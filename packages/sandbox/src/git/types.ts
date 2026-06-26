/**
 * Public types for the git extension.
 */

/** Result of a git clone (`checkout`) operation. */
export interface GitCheckoutResult {
  success: boolean;
  repoUrl: string;
  branch: string;
  targetDir: string;
  timestamp: string;
  exitCode?: number;
}

export interface GitHostAuth {
  token: string;
  username?: string;
  type?: 'basic' | 'bearer';
}

export interface GitAuthConfig {
  github?: GitHostAuth;
  gitlab?: GitHostAuth;
  bitbucket?: GitHostAuth;
  hosts?: Record<string, GitHostAuth>;
}

export interface GitAuthInterceptorParams {
  hosts: Record<string, GitHostAuth>;
}

export interface GitExtensionOptions {
  auth?: GitAuthConfig;
}

/** Options shared by every git extension method. */
export interface GitSessionOptions {
  /**
   * Session to run the git command in. Omit to run sessionless (the command
   * runs in a fresh, non-persistent shell). Sessionless commands still inherit
   * the sandbox-level environment variables (e.g. tokens, proxy settings), so
   * auth and egress configured on the sandbox keep working. Pass a session id
   * to run inside an existing session so its working directory and environment
   * carry over instead.
   */
  sessionId?: string;
}

/** Options for cloning a repository. */
export interface GitCheckoutOptions extends GitSessionOptions {
  /** Branch (or tag) to check out after cloning. */
  branch?: string;
  /** Directory to clone into. Defaults to `/workspace/<repoName>`. */
  targetDir?: string;
  /** Clone depth for shallow clones (e.g. 1 for the latest commit only). */
  depth?: number;
  /** Maximum wall-clock time for the git clone subprocess, in milliseconds. */
  cloneTimeoutMs?: number;
  auth?: GitAuthConfig | false;
}
