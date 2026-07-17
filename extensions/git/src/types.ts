/**
 * Public types for the git extension.
 */

import type {
  HTTPAuthHostConfig,
  HTTPAuthInterceptorParams
} from '@cloudflare/sandbox/extensions';

/** Result of a git clone (`checkout`) operation. */
export interface GitCheckoutResult {
  success: boolean;
  repoUrl: string;
  branch: string;
  targetDir: string;
  timestamp: string;
  exitCode?: number;
}

export type GitHostAuth = HTTPAuthHostConfig;

export interface GitAuthConfig {
  github?: GitHostAuth;
  gitlab?: GitHostAuth;
  bitbucket?: GitHostAuth;
  hosts?: Record<string, GitHostAuth>;
}

export type GitAuthInterceptorParams = HTTPAuthInterceptorParams;

export interface GitExtensionOptions {
  auth?: GitAuthConfig;
}

/** Options for cloning a repository. */
export interface GitCheckoutOptions {
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
