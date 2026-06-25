/**
 * Git extension for the Cloudflare Sandbox SDK.
 *
 * Git is just a sequence of shell commands, so this is an **SDK-only**
 * extension: it drives `this.client.commands.execute` over the existing
 * control channel and needs no sidecar. All the git business logic that used
 * to live in the container (argument building, branch parsing, error
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

import { filterEnvVars, redactCommand, shellEscape } from '@repo/shared';
import {
  ErrorCode,
  type ErrorResponse,
  getHttpStatus
} from '@repo/shared/errors';
import { DISABLE_SESSION_TOKEN } from '@repo/shared/internal';
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
  GitSessionOptions
} from './types.js';

export type {
  GitCheckoutOptions,
  GitCheckoutResult,
  GitSessionOptions
} from './types.js';
export { withGit as default };

/** Shape returned by the commands control sub-API. */
interface ExecOutcome {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * The git extension. Drives `git` in the container through the commands
 * control sub-API and translates failures into the SDK's typed git errors.
 */
export class Git extends SandboxExtension {
  constructor(sandbox: SandboxLike) {
    super(sandbox);
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

    const targetDir = options.targetDir || generateTargetDirectory(repoUrl);
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
    const cloneCommand = this.#command(
      buildCloneArgs(repoUrl, targetDir, options)
    );
    const cloneResult = await this.#exec(cloneCommand, sessionId);

    if (cloneResult.exitCode !== 0) {
      if (cloneResult.exitCode === 124) {
        this.#throwError(
          ErrorCode.GIT_NETWORK_ERROR,
          `Git clone timed out after ${gitCloneTimeoutSeconds(
            cloneTimeoutMs
          )} seconds for '${redactCommand(repoUrl)}'`,
          {
            repository: redactCommand(repoUrl),
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
        `Failed to clone repository '${redactCommand(repoUrl)}': ${
          redactCommand(cloneResult.stderr || '') ||
          `exit code ${cloneResult.exitCode}`
        }`,
        {
          repository: redactCommand(repoUrl),
          targetDir,
          exitCode: cloneResult.exitCode,
          stderr: redactCommand(cloneResult.stderr || '')
        }
      );
    }

    // Query the branch actually checked out rather than assuming.
    const branchResult = await this.#exec(
      this.#command(buildGetCurrentBranchArgs()),
      sessionId,
      targetDir
    );
    const branch =
      branchResult.exitCode === 0 && branchResult.stdout.trim()
        ? branchResult.stdout.trim()
        : options.branch || 'unknown';

    return {
      success: true,
      repoUrl,
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
      this.#command(buildCheckoutArgs(branch)),
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
      this.#command(buildGetCurrentBranchArgs()),
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
      this.#command(buildListBranchesArgs()),
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

  #sessionId(options: GitSessionOptions): string {
    return options.sessionId ?? DISABLE_SESSION_TOKEN;
  }

  /**
   * Env to attach to a git command. Sessionless git runs in a fresh shell, so
   * merge in the sandbox-level env vars (tokens, proxy settings) the same way
   * the Sandbox's own sessionless execution does. A real session already
   * carries its own env, so nothing extra is injected there.
   */
  #execEnv(sessionId: string): Record<string, string> | undefined {
    if (sessionId !== DISABLE_SESSION_TOKEN) {
      return undefined;
    }
    const env = filterEnvVars(this.envVars);
    return Object.keys(env).length > 0 ? env : undefined;
  }

  #command(args: string[]): string {
    return args.map((arg) => shellEscape(arg)).join(' ');
  }

  async #exec(
    command: string,
    sessionId: string,
    cwd?: string
  ): Promise<ExecOutcome> {
    const result = await this.client.commands.execute(command, sessionId, {
      cwd,
      env: this.#execEnv(sessionId)
    });
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
export function withGit(sandbox: SandboxLike): Git {
  return new Git(sandbox);
}
