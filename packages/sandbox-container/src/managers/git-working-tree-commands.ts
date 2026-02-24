export class GitWorkingTreeCommands {
  buildAddArgs(files?: string[], all = true): string[] {
    if (files && files.length > 0) {
      return ['git', 'add', '--', ...files];
    }

    return ['git', 'add', all ? '-A' : '.'];
  }

  buildCommitArgs(
    message: string,
    options?: {
      authorName?: string;
      authorEmail?: string;
      allowEmpty?: boolean;
    }
  ): string[] {
    const args = ['git'];

    if (options?.authorName) {
      args.push('-c', `user.name=${options.authorName}`);
    }

    if (options?.authorEmail) {
      args.push('-c', `user.email=${options.authorEmail}`);
    }

    args.push('commit', '-m', message);

    if (options?.allowEmpty) {
      args.push('--allow-empty');
    }

    return args;
  }

  buildResetArgs(options?: {
    mode?: 'soft' | 'mixed' | 'hard' | 'merge' | 'keep';
    target?: string;
    paths?: string[];
  }): string[] {
    const allowedModes = ['soft', 'mixed', 'hard', 'merge', 'keep'] as const;

    if (options?.mode && !allowedModes.includes(options.mode)) {
      throw new Error(`Reset mode must be one of ${allowedModes.join(', ')}.`);
    }

    const args = ['git', 'reset'];

    if (options?.mode) {
      args.push(`--${options.mode}`);
    }

    if (options?.target) {
      args.push(options.target);
    }

    if (options?.paths && options.paths.length > 0) {
      args.push('--', ...options.paths);
    }

    return args;
  }

  buildRestoreArgs(options: {
    paths: string[];
    staged?: boolean;
    worktree?: boolean;
    source?: string;
  }): string[] {
    if (!options.paths || options.paths.length === 0) {
      throw new Error('At least one path is required.');
    }

    let staged = options.staged;
    let worktree = options.worktree;

    if (staged === undefined && worktree === undefined) {
      worktree = true;
    } else if (staged === true && worktree === undefined) {
      worktree = false;
    } else if (staged === undefined && worktree !== undefined) {
      staged = false;
    }

    if (staged === false && worktree === false) {
      throw new Error('At least one of staged or worktree must be true.');
    }

    const args = ['git', 'restore'];

    if (worktree) {
      args.push('--worktree');
    }

    if (staged) {
      args.push('--staged');
    }

    if (options.source) {
      args.push('--source', options.source);
    }

    args.push('--', ...options.paths);

    return args;
  }

  buildStatusArgs(): string[] {
    return ['git', 'status', '--porcelain=1', '-b'];
  }
}
