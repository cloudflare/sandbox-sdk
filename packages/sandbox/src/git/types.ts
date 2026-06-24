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

/** Options shared by every git extension method. */
export interface GitSessionOptions {
  /**
   * Session to run the git command in. Omit to run sessionless (the command
   * runs in a fresh, non-persistent shell). Pass a session id to run inside an
   * existing session so working directory and environment carry over.
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
}
