export class GitBranchCommands {
  buildCheckoutArgs(branch: string): string[] {
    return ['git', 'checkout', branch];
  }

  buildCreateBranchArgs(branch: string): string[] {
    return ['git', 'checkout', '-b', branch];
  }

  buildDeleteBranchArgs(branch: string, force = false): string[] {
    return ['git', 'branch', force ? '-D' : '-d', branch];
  }

  buildGetCurrentBranchArgs(): string[] {
    return ['git', 'branch', '--show-current'];
  }

  buildListBranchesArgs(): string[] {
    return ['git', 'branch', '-a'];
  }
}
