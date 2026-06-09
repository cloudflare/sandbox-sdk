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

interface SandboxRepoState {
  defaultBranch: string;
  remote: string;
  repoExisted: boolean;
  sandbox: ReturnType<typeof getSandbox>;
  tokenSecret: string;
}

const app = new Hono<{ Bindings: Env }>();
const SANDBOX_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
const REDACTED_SECRET = '***';

app.post('/sandboxes/:id/commit/:filename', async (c) => {
  const sandboxID = getSandboxID(c.req.param('id'));
  if (!sandboxID) {
    return c.json(
      {
        error:
          'Sandbox ID must contain only letters, numbers, dots, underscores, and dashes.'
      },
      400
    );
  }

  const filename = getFilename(c.req.param('filename'));
  const content =
    (await c.req.text()) || `created at ${new Date().toISOString()}\n`;

  const state = await ensureSandboxRepo(c.env, sandboxID);

  const result = await state.sandbox.exec(COMMIT_SCRIPT, {
    env: {
      DEFAULT_BRANCH: state.defaultBranch,
      FILE_NAME: filename,
      FILE_CONTENT: content,
      REPO_DIR: `/workspace/repos/${sandboxID}`
    },
    timeout: 30_000
  });
  const stdout = redactSecret(result.stdout, state.tokenSecret);
  const stderr = redactSecret(result.stderr, state.tokenSecret);

  if (!result.success) {
    return c.json(
      {
        sandboxId: sandboxID,
        repo: sandboxID,
        filename,
        remote: state.remote,
        stdout,
        stderr,
        exitCode: result.exitCode,
        success: false
      },
      500
    );
  }

  return c.json({
    sandboxId: sandboxID,
    repo: sandboxID,
    filename,
    remote: state.remote,
    repoExisted: state.repoExisted,
    stdout,
    stderr,
    exitCode: result.exitCode,
    success: true
  });
});

app.get('/sandboxes/:id/repo', async (c) => {
  const sandboxID = getSandboxID(c.req.param('id'));
  if (!sandboxID) {
    return c.json(
      {
        error:
          'Sandbox ID must contain only letters, numbers, dots, underscores, and dashes.'
      },
      400
    );
  }

  const repo = await getRepoOrNull(c.env, sandboxID);

  if (!repo) {
    return c.json({ error: 'Repo not found for this sandbox ID.' }, 404);
  }

  return c.json({
    sandboxId: sandboxID,
    repo: repo.name,
    remote: repo.remote,
    defaultBranch: repo.defaultBranch,
    lastPushAt: repo.lastPushAt
  });
});

export default app;

function toAuthenticatedRemote(remote: string, token: string) {
  return `https://x:${token}@${remote.slice('https://'.length)}`;
}

function getFilename(filename: string) {
  const cleaned = filename.trim().replace(/[^a-zA-Z0-9._-]/g, '-');
  return cleaned.length > 0 ? cleaned : `note-${Date.now().toString()}.txt`;
}

function getSandboxID(sandboxID: string) {
  const trimmed = sandboxID.trim();
  if (trimmed === '.' || trimmed === '..') {
    return null;
  }

  return SANDBOX_ID_PATTERN.test(trimmed) ? trimmed : null;
}

function redactSecret(output: string, secret: string) {
  return output.split(secret).join(REDACTED_SECRET);
}

function getTokenSecret(token: string) {
  return token.split('?expires=')[0];
}

async function ensureSandboxRepo(
  env: Env,
  sandboxID: string
): Promise<SandboxRepoState> {
  const sandbox = getSandbox(env.Sandbox, sandboxID);
  const existingRepo = await getRepoOrNull(env, sandboxID);

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
    try {
      const created = await env.ARTIFACTS.create(sandboxID);

      defaultBranch = created.defaultBranch;
      remote = created.remote;
      token = created.token;
    } catch {
      // A concurrent request may have created the repo first; retry lookup.
      const repo = await getRepoOrNull(env, sandboxID);
      if (!repo) {
        throw new Error(
          `Failed to create or find repo for sandbox ${sandboxID}`
        );
      }

      repoExisted = true;
      defaultBranch = repo.defaultBranch;
      remote = repo.remote;
      const createdToken = await repo.createToken('write', 3600);
      token = createdToken.plaintext;
    }
  }

  const tokenSecret = getTokenSecret(token);

  await sandbox.setEnvVars({
    ARTIFACTS_GIT_REMOTE: toAuthenticatedRemote(remote, tokenSecret)
  });

  return { sandbox, defaultBranch, remote, repoExisted, tokenSecret };
}

async function getRepoOrNull(env: Env, sandboxID: string) {
  try {
    return await env.ARTIFACTS.get(sandboxID);
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
  'printf "%s" "$FILE_CONTENT" > "$FILE_NAME"',
  'git config user.name "Sandbox SDK example"',
  'git config user.email "sandbox-sdk@example.com"',
  'git add -- "$FILE_NAME"',
  'git commit -m "Add $FILE_NAME"',
  'git push origin "HEAD:$DEFAULT_BRANCH"',
  'git rev-parse HEAD'
].join('\n');
