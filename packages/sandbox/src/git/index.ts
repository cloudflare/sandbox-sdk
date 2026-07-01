/**
 * Git extension for the Cloudflare Sandbox SDK.
 *
 * Git is just a sequence of shell commands, so this is an **SDK-only**
 * extension: it drives the owning sandbox's unified `exec()` process surface
 * over the existing control channel and needs no sidecar. All the git
 * business logic that used to live in the container (argument building,
 * branch parsing, error
 * classification) is ported into `./manager` and runs in the Worker; only the
 * `git` process itself runs in the container.
 *
 * Usage — attach it to a Sandbox subclass and expose delegate methods:
 *
 * ```ts
 * import { Sandbox as BaseSandbox } from '@cloudflare/sandbox';
 * import { withGit } from '@cloudflare/sandbox/git';
 *
 * export class Sandbox extends BaseSandbox<Env> {
 *   git = withGit(this);
 *   gitCheckout(repoUrl: string, options?: GitCheckoutOptions) {
 *     return this.git.checkout(repoUrl, options);
 *   }
 * }
 *
 * await sandbox.gitCheckout('https://github.com/owner/repo.git');
 * ```
 */

import { redactCommand } from '@repo/shared';
import {
  ErrorCode,
  type ErrorResponse,
  getHttpStatus
} from '@repo/shared/errors';
import { createErrorFromResponse } from '../errors/index.js';
import { SandboxExtension, type SandboxLike } from '../extensions/index.js';
import {
  buildCheckoutArgs,
  buildCloneArgs,
  buildGetCurrentBranchArgs,
  buildListBranchesArgs,
  DEFAULT_GIT_CLONE_TIMEOUT_MS,
  determineErrorCode,
  generateTargetDirectory,
  gitCloneTimeoutSeconds,
  parseBranchList,
  validateBranchName,
  validateGitUrl,
  validatePath
} from './manager.js';
import type {
  GitCheckoutOptions,
  GitCheckoutResult,
  GitExtensionOptions,
  GitHostAuth,
  GitSessionOptions
} from './types.js';

export type {
  GitAuthConfig,
  GitCheckoutOptions,
  GitCheckoutResult,
  GitExtensionOptions,
  GitHostAuth,
  GitSessionOptions
} from './types.js';
export { withGit as default };

const CLONE_PROCESS_TIMEOUT_BUFFER_MS = 10_000;

/** Shape returned by a completed git process. */
interface ExecOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface CheckoutURLPlan {
  publicRepoUrl: string;
  cloneRepoUrl: string;
  proxy?: {
    upstreamOrigin: string;
    allowedPathPrefix: string;
    proxiedPath: string;
    authorization: string;
  };
}

/**
 * The git extension. Drives `git` in the container through the commands
 * control sub-API and translates failures into the SDK's typed git errors.
 */
export class Git extends SandboxExtension {
  readonly #options: GitExtensionOptions;

  constructor(sandbox: SandboxLike, options: GitExtensionOptions = {}) {
    super(sandbox);
    this.#options = options;
  }

  /**
   * Clone a repository. Returns the resolved target directory and the branch
   * actually checked out (queried from git, not assumed).
   */
  async checkout(
    repoUrl: string,
    options: GitCheckoutOptions = {}
  ): Promise<GitCheckoutResult> {
    const urlValidation = validateGitUrl(repoUrl);
    if (!urlValidation.isValid) {
      this.#throwValidation('repoUrl', urlValidation.errors, 'INVALID_GIT_URL');
    }

    const urlPlan = this.#checkoutURLPlan(repoUrl, options.auth);
    const targetDir =
      options.targetDir || generateTargetDirectory(urlPlan.publicRepoUrl);
    const cloneTimeoutMs =
      options.cloneTimeoutMs ?? DEFAULT_GIT_CLONE_TIMEOUT_MS;

    if (!Number.isInteger(cloneTimeoutMs) || cloneTimeoutMs <= 0) {
      this.#throwError(
        ErrorCode.VALIDATION_FAILED,
        `Invalid clone timeout '${options.cloneTimeoutMs}'. Must be a positive integer representing milliseconds.`,
        {
          validationErrors: [
            {
              field: 'cloneTimeoutMs',
              message:
                'Clone timeout must be a positive integer representing milliseconds',
              code: 'INVALID_TIMEOUT'
            }
          ]
        }
      );
    }

    const pathValidation = validatePath(targetDir);
    if (!pathValidation.isValid) {
      this.#throwValidation('targetDir', pathValidation.errors, 'INVALID_PATH');
    }

    const sessionId = this.#sessionId(options);
    const cloneResult = await this.#withCloneURL(
      urlPlan,
      cloneTimeoutMs + CLONE_PROCESS_TIMEOUT_BUFFER_MS,
      async (cloneUrl) => {
        const result = await this.#exec(
          buildCloneArgs(cloneUrl, targetDir, options),
          sessionId,
          undefined,
          cloneTimeoutMs + CLONE_PROCESS_TIMEOUT_BUFFER_MS
        );

        if (result.exitCode === 0 && urlPlan.proxy) {
          const remoteResult = await this.#exec(
            ['git', 'remote', 'set-url', 'origin', urlPlan.publicRepoUrl],
            sessionId,
            targetDir
          );
          if (remoteResult.exitCode !== 0) {
            this.#throwError(
              ErrorCode.GIT_OPERATION_FAILED,
              `Failed to reset git remote URL in '${targetDir}': ${
                remoteResult.stderr || `exit code ${remoteResult.exitCode}`
              }`,
              {
                targetDir,
                exitCode: remoteResult.exitCode,
                stderr: remoteResult.stderr
              }
            );
          }
        }

        return result;
      }
    );

    if (cloneResult.exitCode !== 0) {
      if ([124, 143, -15].includes(cloneResult.exitCode)) {
        this.#throwError(
          ErrorCode.GIT_NETWORK_ERROR,
          `Git clone timed out after ${gitCloneTimeoutSeconds(
            cloneTimeoutMs
          )} seconds for '${redactCommand(urlPlan.publicRepoUrl)}'`,
          {
            repository: redactCommand(urlPlan.publicRepoUrl),
            targetDir,
            exitCode: 124,
            stderr: 'Operation timed out'
          }
        );
      }

      const code = determineErrorCode(
        'clone',
        cloneResult.stderr || 'Unknown error',
        cloneResult.exitCode
      );
      this.#throwError(
        code,
        `Failed to clone repository '${redactCommand(urlPlan.publicRepoUrl)}': ${
          redactCommand(cloneResult.stderr || '') ||
          `exit code ${cloneResult.exitCode}`
        }`,
        {
          repository: redactCommand(urlPlan.publicRepoUrl),
          targetDir,
          exitCode: cloneResult.exitCode,
          stderr: redactCommand(cloneResult.stderr || '')
        }
      );
    }

    // Query the branch actually checked out rather than assuming.
    const branchResult = await this.#exec(
      buildGetCurrentBranchArgs(),
      sessionId,
      targetDir
    );
    const branch =
      branchResult.exitCode === 0 && branchResult.stdout.trim()
        ? branchResult.stdout.trim()
        : options.branch || 'unknown';

    return {
      success: true,
      repoUrl: urlPlan.publicRepoUrl,
      branch,
      targetDir,
      timestamp: new Date().toISOString()
    };
  }

  /** Check out an existing branch in a cloned repository. */
  async checkoutBranch(
    repoPath: string,
    branch: string,
    options: GitSessionOptions = {}
  ): Promise<void> {
    const pathValidation = validatePath(repoPath);
    if (!pathValidation.isValid) {
      this.#throwValidation('repoPath', pathValidation.errors, 'INVALID_PATH');
    }

    const branchValidation = validateBranchName(branch);
    if (!branchValidation.isValid) {
      this.#throwError(
        ErrorCode.VALIDATION_FAILED,
        `Invalid branch name '${branch}': ${branchValidation.error || 'Invalid format'}`,
        {
          validationErrors: [
            {
              field: 'branch',
              message: branchValidation.error || 'Invalid branch name format',
              code: 'INVALID_BRANCH'
            }
          ]
        }
      );
    }

    const result = await this.#exec(
      buildCheckoutArgs(branch),
      this.#sessionId(options),
      repoPath
    );

    if (result.exitCode !== 0) {
      const code = determineErrorCode(
        'checkout',
        result.stderr || 'Unknown error',
        result.exitCode
      );
      this.#throwError(
        code,
        `Failed to checkout branch '${branch}' in '${repoPath}': ${
          result.stderr || `exit code ${result.exitCode}`
        }`,
        {
          branch,
          targetDir: repoPath,
          exitCode: result.exitCode,
          stderr: result.stderr
        }
      );
    }
  }

  /** Return the current branch of a cloned repository. */
  async getCurrentBranch(
    repoPath: string,
    options: GitSessionOptions = {}
  ): Promise<string> {
    const pathValidation = validatePath(repoPath);
    if (!pathValidation.isValid) {
      this.#throwValidation('repoPath', pathValidation.errors, 'INVALID_PATH');
    }

    const result = await this.#exec(
      buildGetCurrentBranchArgs(),
      this.#sessionId(options),
      repoPath
    );

    if (result.exitCode !== 0) {
      this.#throwError(
        determineErrorCode(
          'getCurrentBranch',
          result.stderr || 'Unknown error',
          result.exitCode
        ),
        `Failed to get current branch in '${repoPath}': ${
          result.stderr || `exit code ${result.exitCode}`
        }`,
        {
          targetDir: repoPath,
          exitCode: result.exitCode,
          stderr: result.stderr
        }
      );
    }

    return result.stdout.trim();
  }

  /** List local and remote branches of a cloned repository. */
  async listBranches(
    repoPath: string,
    options: GitSessionOptions = {}
  ): Promise<string[]> {
    const pathValidation = validatePath(repoPath);
    if (!pathValidation.isValid) {
      this.#throwValidation('repoPath', pathValidation.errors, 'INVALID_PATH');
    }

    const result = await this.#exec(
      buildListBranchesArgs(),
      this.#sessionId(options),
      repoPath
    );

    if (result.exitCode !== 0) {
      this.#throwError(
        determineErrorCode(
          'listBranches',
          result.stderr || 'Unknown error',
          result.exitCode
        ),
        `Failed to list branches in '${repoPath}': ${
          result.stderr || `exit code ${result.exitCode}`
        }`,
        {
          targetDir: repoPath,
          exitCode: result.exitCode,
          stderr: result.stderr
        }
      );
    }

    return parseBranchList(result.stdout);
  }

  // --- internals -----------------------------------------------------------

  async #withCloneURL<T>(
    plan: CheckoutURLPlan,
    leaseDurationMs: number,
    callback: (cloneUrl: string) => Promise<T>
  ): Promise<T> {
    if (!plan.proxy) {
      return callback(plan.cloneRepoUrl);
    }

    return this.withHTTPProxyLease(
      {
        extensionId: 'git',
        routes: [
          {
            upstreamOrigin: plan.proxy.upstreamOrigin,
            allowedPathPrefix: plan.proxy.allowedPathPrefix,
            injectHeaders: { authorization: plan.proxy.authorization },
            expiresAt: Date.now() + leaseDurationMs
          }
        ]
      },
      (lease) => callback(`${lease.internalBaseURL}${plan.proxy!.proxiedPath}`)
    );
  }

  #checkoutURLPlan(
    repoUrl: string,
    authOverride: GitCheckoutOptions['auth']
  ): CheckoutURLPlan {
    let parsed: URL;
    try {
      parsed = new URL(repoUrl);
    } catch {
      return { publicRepoUrl: repoUrl, cloneRepoUrl: repoUrl };
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { publicRepoUrl: repoUrl, cloneRepoUrl: repoUrl };
    }

    const urlAuth = this.#authFromURL(parsed);
    const publicRepoUrl = this.#stripURLCredentials(parsed);
    const hostAuth = this.#authHosts(authOverride)[parsed.hostname];
    const auth = urlAuth ?? hostAuth;

    if (parsed.protocol === 'http:' && auth) {
      this.#throwError(
        ErrorCode.VALIDATION_FAILED,
        'Git authentication proxying only supports HTTPS Git URLs. Use an HTTPS repository URL or disable git auth for this checkout.',
        { repository: redactCommand(publicRepoUrl) }
      );
    }

    if (urlAuth && authOverride === false) {
      this.#throwError(
        ErrorCode.VALIDATION_FAILED,
        'Unsafe credential-bearing Git URLs are not allowed when git auth is explicitly disabled. Pass credentials through the git extension auth option or remove credentials from the URL.',
        { repository: redactCommand(publicRepoUrl) }
      );
    }

    if (!auth) {
      return { publicRepoUrl, cloneRepoUrl: publicRepoUrl };
    }

    return {
      publicRepoUrl,
      cloneRepoUrl: publicRepoUrl,
      proxy: {
        upstreamOrigin: parsed.origin,
        allowedPathPrefix: parsed.pathname,
        proxiedPath: `${parsed.pathname}${parsed.search}`,
        authorization: this.#authorizationHeader(auth)
      }
    };
  }

  #authFromURL(url: URL): GitHostAuth | undefined {
    if (!url.username && !url.password) return undefined;
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    if (password) {
      return { type: 'basic', username, token: password };
    }
    return { token: username };
  }

  #stripURLCredentials(url: URL): string {
    const copy = new URL(url.toString());
    copy.username = '';
    copy.password = '';
    return copy.toString();
  }

  #authorizationHeader(auth: GitHostAuth): string {
    if (auth.type === 'bearer') {
      return `Bearer ${auth.token}`;
    }
    const username = auth.username ?? 'x-access-token';
    return `Basic ${btoa(`${username}:${auth.token}`)}`;
  }

  #authHosts(
    authOverride: GitCheckoutOptions['auth']
  ): Record<string, GitHostAuth> {
    if (authOverride === false) {
      return {};
    }
    const config = authOverride ?? this.#options.auth;
    if (!config) {
      return {};
    }

    const hosts: Record<string, GitHostAuth> = { ...(config.hosts ?? {}) };
    if (config.github) {
      hosts['github.com'] = config.github;
    }
    if (config.gitlab) {
      hosts['gitlab.com'] = config.gitlab;
    }
    if (config.bitbucket) {
      hosts['bitbucket.org'] = config.bitbucket;
    }
    return hosts;
  }

  #sessionId(options: GitSessionOptions): string | undefined {
    return options.sessionId;
  }

  async #exec(
    command: string[],
    sessionId: string | undefined,
    cwd?: string,
    timeout?: number
  ): Promise<ExecOutcome> {
    const result = await this.exec(command, {
      ...(sessionId !== undefined && { sessionId }),
      ...(cwd !== undefined && { cwd }),
      ...(timeout !== undefined && { timeout }),
      stdout: 'pipe',
      stderr: 'pipe'
    }).output({ encoding: 'utf8' });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode
    };
  }

  #throwValidation(field: string, errors: string[], code: string): never {
    this.#throwError(
      code === 'INVALID_GIT_URL'
        ? ErrorCode.INVALID_GIT_URL
        : ErrorCode.VALIDATION_FAILED,
      `Invalid ${field}: ${errors.join(', ')}`,
      {
        validationErrors: errors.map((message) => ({ field, message, code }))
      }
    );
  }

  #throwError(
    code: ErrorCode,
    message: string,
    context: Record<string, unknown>
  ): never {
    const response: ErrorResponse = {
      code,
      message,
      context,
      httpStatus: getHttpStatus(code),
      timestamp: new Date().toISOString()
    };
    throw createErrorFromResponse(response);
  }
}

/** Factory — the consumer-facing API. */
export function withGit(
  sandbox: SandboxLike,
  options: GitExtensionOptions = {}
): Git {
  return new Git(sandbox, options);
}
