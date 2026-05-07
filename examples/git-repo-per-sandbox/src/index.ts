import { getSandbox, type Sandbox } from '@cloudflare/sandbox';
import { Hono } from 'hono';

export { Sandbox } from '@cloudflare/sandbox';

export interface ArtifactsRepoInfo {
  id: string;
  name: string;
  remote: string;
  defaultBranch: string;
  lastPushAt: string | null;
}

export interface ArtifactsTokenResult {
  id: string;
  expiresAt: string;
  plaintext: string;
  scope: 'write' | 'read';
}

export interface ArtifactsRepo extends ArtifactsRepoInfo {
  createToken(
    scope?: 'write' | 'read',
    ttl?: number
  ): Promise<ArtifactsTokenResult>;
}

export interface ArtifactsCreateRepoResult {
  id: string;
  name: string;
  defaultBranch: string;
  remote: string;
  token: string;
}

export interface Artifacts {
  get(name: string): Promise<ArtifactsRepo>;
  create(name: string): Promise<ArtifactsCreateRepoResult>;
}

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  ARTIFACTS: Artifacts;
}

interface CommitRequest {
  filename?: string;
}

interface SandboxRepoState {
  defaultBranch: string;
  remote: string;
  repoExisted: boolean;
  sandbox: Sandbox;
}

const app = new Hono<{ Bindings: Env }>();

app.post('/sandboxes/:id/setup', async (c) => {
  const sandboxId = c.req.param('id');
  const state = await ensureSandboxRepo(c.env, sandboxId);

  return c.json({
    sandboxId,
    repo: sandboxId,
    repoExisted: state.repoExisted,
    remote: state.remote,
    defaultBranch: state.defaultBranch,
    message: 'Sandbox is ready to use ARTIFACTS_GIT_REMOTE.'
  });
});

app.get('/sandboxes/:id/repo', async (c) => {
  const sandboxId = c.req.param('id');
  const repo = await getRepoOrNull(c.env, sandboxId);

  if (!repo) {
    return c.json({ error: 'Repo not found for this sandbox ID.' }, 404);
  }

  return c.json({
    sandboxId,
    repo: repo.name,
    remote: repo.remote,
    defaultBranch: repo.defaultBranch,
    lastPushAt: repo.lastPushAt
  });
});

app.post('/sandboxes/:id/commit', async (c) => {
  const sandboxId = c.req.param('id');

  let body: CommitRequest = {};

  try {
    body = await c.req.json<CommitRequest>();
  } catch {
    body = {};
  }

  const filename = getFilename(body.filename);

  const state = await ensureSandboxRepo(c.env, sandboxId);

  // Clone the repo into the sandbox if needed, then add one file and push it back.
  const result = await state.sandbox.exec(COMMIT_SCRIPT, {
    env: {
      DEFAULT_BRANCH: state.defaultBranch,
      FILE_NAME: filename,
      REPO_DIR: `/workspace/repos/${sandboxId}`
    },
    timeout: 30_000
  });

  if (!result.success) {
    return c.json(
      {
        sandboxId,
        repo: sandboxId,
        filename,
        remote: state.remote,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        success: false
      },
      500
    );
  }

  return c.json({
    sandboxId,
    repo: sandboxId,
    filename,
    remote: state.remote,
    repoExisted: state.repoExisted,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    success: true
  });
});

export default app;

function toAuthenticatedRemote(remote: string, token: string) {
  const tokenSecret = token.split('?expires=')[0];
  return `https://x:${tokenSecret}@${remote.slice('https://'.length)}`;
}

function getFilename(filename?: string) {
  const cleaned = filename?.trim().replace(/[^a-zA-Z0-9._-]/g, '-');
  return cleaned && cleaned.length > 0
    ? cleaned
    : `note-${Date.now().toString()}.txt`;
}

async function ensureSandboxRepo(env: Env, sandboxId: string) {
  const sandbox = getSandbox(env.Sandbox, sandboxId);
  const existingRepo = await getRepoOrNull(env, sandboxId);

  let defaultBranch: string;
  let remote: string;
  let token: string;
  let repoExisted = false;

  if (existingRepo) {
    repoExisted = true;
    defaultBranch = existingRepo.defaultBranch;
    remote = existingRepo.remote;
    const createdToken = await existingRepo.createToken('write', 3600);
    token = createdToken.plaintext;
  } else {
    const created = await env.ARTIFACTS.create(sandboxId);

    defaultBranch = created.defaultBranch;
    remote = created.remote;
    token = created.token;
  }

  // The sandbox gets a normal authenticated Git remote it can reuse across commands.
  await sandbox.setEnvVars({
    ARTIFACTS_GIT_REMOTE: toAuthenticatedRemote(remote, token)
  });

  return {
    sandbox,
    defaultBranch,
    remote,
    repoExisted
  } satisfies SandboxRepoState;
}

async function getRepoOrNull(env: Env, sandboxId: string) {
  try {
    return await env.ARTIFACTS.get(sandboxId);
  } catch (error) {
    if (isMissingRepoError(error)) {
      return null;
    }

    throw error;
  }
}

function isMissingRepoError(error: unknown) {
  return (
    error instanceof Error &&
    /not found|does not exist|missing/i.test(error.message)
  );
}

const COMMIT_SCRIPT = [
  'set -eu',
  'mkdir -p "$(dirname "$REPO_DIR")"',
  'if [ ! -d "$REPO_DIR/.git" ]; then',
  '  rm -rf "$REPO_DIR"',
  '  git clone "$ARTIFACTS_GIT_REMOTE" "$REPO_DIR"',
  'fi',
  'cd "$REPO_DIR"',
  'git checkout -B "$DEFAULT_BRANCH"',
  'touch -- "$FILE_NAME"',
  'printf "created by %s at %s\n" "$FILE_NAME" "$(date -u +%FT%TZ)" >> "$FILE_NAME"',
  'git config user.name "Sandbox SDK example"',
  'git config user.email "sandbox-sdk@example.com"',
  'git add -- "$FILE_NAME"',
  'git commit -m "Add $FILE_NAME"',
  'git push origin "HEAD:$DEFAULT_BRANCH"',
  'git rev-parse HEAD'
].join('\n');
