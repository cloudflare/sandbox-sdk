import { DurableObject, tracing } from 'cloudflare:workers';
import { type OpenAISession, parseOpenAISession } from './openai-session';

type ContainerMonitor = { expectedStop: boolean };
type ExecutorConnection = {
  sessionID: string;
  environmentID: string;
  remoteURL: string;
};

export class ExecutorEnvironment extends DurableObject<Env> {
  #operations: Promise<void> = Promise.resolve();
  #containerMonitor?: ContainerMonitor;

  update(sessionID: string): Promise<void> {
    return this.#enqueue(() =>
      tracing.enterSpan('agents-api.executor.update', async (span) => {
        span.setAttribute('openai.session_id', sessionID);
        const session = await this.#updateSession({ sessionID, span });
        if (session?.status === 'idle') {
          await this.#prepareIdle(sessionID, span);
        }
      })
    );
  }

  prewarm(sessionID: string): Promise<void> {
    return this.#enqueue(() =>
      tracing.enterSpan('agents-api.executor.prewarm', async (span) => {
        span.setAttribute('openai.session_id', sessionID);
        if (!prewarmEnabled(this.env.EXECUTOR_PREWARM_ENABLED)) return;
        await this.#updateSession({ sessionID, span, forceStart: true });
      })
    );
  }

  alarm(): Promise<void> {
    return this.#enqueue(() =>
      tracing.enterSpan('agents-api.executor.deadline', async (span) => {
        const sessionID = await this.ctx.storage.get<string>('sessionID');
        if (!sessionID) {
          const message = 'Executor deadline is missing a session ID.';
          span.setAttribute('error', true);
          span.setAttribute('error.message', message);
          await this.#destroy();
          return;
        }
        span.setAttribute('openai.session_id', sessionID);
        try {
          const session = await this.#updateSession({ sessionID, span });
          if (session?.status === 'idle') {
            await this.#destroy({ preserveSnapshot: true });
          }
        } catch (error) {
          await this.#armDeadline(sessionID);
          const message = errorMessage(error);
          span.setAttribute('error', true);
          span.setAttribute('error.message', message);
          throw error;
        }
      })
    );
  }

  destroy(): Promise<void> {
    return this.#enqueue(() => this.#destroy());
  }

  async #enqueue(operation: () => Promise<void>): Promise<void> {
    const previous = this.#operations;
    const { promise, resolve: release } = Promise.withResolvers<void>();
    this.#operations = promise;

    await previous;
    try {
      await operation();
    } finally {
      release();
    }
  }

  async #updateSession({
    sessionID,
    span,
    forceStart
  }: {
    sessionID: string;
    span: Span;
    forceStart?: true;
  }): Promise<OpenAISession | undefined> {
    const session = await this.#fetchSession(sessionID);
    this.#addSessionSpanAttributes(span, session);
    if (!session) {
      await this.#destroy();
      return undefined;
    }
    if (!this.#isOwnSession(session)) return undefined;

    switch (session.status) {
      case 'failed':
        await this.#destroy();
        return undefined;
      case 'idle':
        if (!forceStart) return session;
        break;
      case 'requires_action':
        for (const action of session.requiredActions) {
          switch (action.type) {
            case 'environment_connection':
              if (!action.environmentID) break;
              if (!session.remoteURL) {
                throw new Error(
                  'OpenAI session environment is missing remote_url.'
                );
              }
              span.setAttribute('openai.needs_environment_connection', true);
              await this.#start({
                sessionID,
                environmentID: action.environmentID,
                remoteURL: session.remoteURL
              });
              return session;
          }
        }
        break;
      case 'in_progress':
        break;
    }

    if (!this.ctx.container?.running) {
      if (!session.environmentID || !session.remoteURL) {
        throw new Error(
          'OpenAI session is missing executor connection details.'
        );
      }
      await this.#start({
        sessionID,
        environmentID: session.environmentID,
        remoteURL: session.remoteURL
      });
      return session;
    }

    await this.#armDeadline(sessionID);
    return session;
  }

  #addSessionSpanAttributes(
    span: Span,
    session: OpenAISession | undefined
  ): void {
    if (!session) return;
    span.setAttribute('openai.agent_id', session.agentID);
    span.setAttribute('openai.session_status', session.status);
    span.setAttribute(
      'openai.session_environment_type',
      session.environmentType
    );
    span.setAttribute(
      'openai.session_required_actions_count',
      session.requiredActions.length
    );
  }

  #isOwnSession(session: OpenAISession): boolean {
    return (
      session.environmentType === 'self_hosted' &&
      session.agentID === this.env.OPENAI_AGENT_ID
    );
  }

  async #fetchSession(sessionID: string): Promise<OpenAISession | undefined> {
    return tracing.enterSpan(
      'agents-api.openai.retrieve_session',
      async (span) => {
        const response = await fetch(
          `https://api.openai.com/v1/agents/sessions/${encodeURIComponent(sessionID)}`,
          {
            headers: { Authorization: `Bearer ${this.env.OPENAI_API_KEY}` },
            signal: AbortSignal.timeout(30_000)
          }
        );
        span.setAttribute('http.response.status_code', response.status);

        if (response.status === 404) return undefined;
        if (!response.ok) {
          const message = `OpenAI session lookup failed with status ${response.status}.`;
          span.setAttribute('error', true);
          span.setAttribute('error.message', message);
          throw new Error(message);
        }
        return parseOpenAISession(await response.json());
      }
    );
  }

  async #start(connection: ExecutorConnection): Promise<void> {
    return tracing.enterSpan('agents-api.executor.start', async (span) => {
      span.setAttribute('openai.session_id', connection.sessionID);
      span.setAttribute('openai.environment_id', connection.environmentID);

      const container = this.ctx.container;
      if (!container) throw new Error('Container binding is not configured.');
      const remoteURL = requireRemoteURL(connection.remoteURL);
      keepAliveMilliseconds(this.env.EXECUTOR_KEEP_ALIVE_SECONDS);

      const currentEnvironmentID =
        await this.ctx.storage.get<string>('environmentID');
      if (
        container.running &&
        (currentEnvironmentID === undefined ||
          currentEnvironmentID === connection.environmentID)
      ) {
        this.#attachContainerMonitor(connection.sessionID);
        await this.ctx.storage.put('environmentID', connection.environmentID);
        await this.#armDeadline(connection.sessionID);
        return;
      }

      if (container.running) {
        this.#expectContainerStop();
        await container.destroy();
      }

      const snapshot = snapshotsEnabled(this.env.EXECUTOR_SNAPSHOTS_ENABLED)
        ? await this.ctx.storage.get<ContainerSnapshot>('containerSnapshot')
        : undefined;
      if (snapshot) {
        span.setAttribute('container.snapshot.restored', true);
        span.setAttribute('container.snapshot.id', snapshot.id);
        span.setAttribute('container.snapshot.size', snapshot.size);
      }
      container.start({
        enableInternet: true,
        env: executorEnv({
          executorAPIKey: this.env.OPENAI_EXECUTOR_API_KEY,
          environmentID: connection.environmentID,
          remoteURL
        }),
        ...(snapshot ? { containerSnapshot: snapshot } : {})
      });
      this.#attachContainerMonitor(connection.sessionID);
      await this.ctx.storage.put('environmentID', connection.environmentID);
      await this.#armDeadline(connection.sessionID);

      console.log({
        message: 'Codex executor started',
        sessionID: connection.sessionID,
        environmentID: connection.environmentID
      });
    });
  }

  async #armDeadline(sessionID: string): Promise<void> {
    const timeout = keepAliveMilliseconds(this.env.EXECUTOR_KEEP_ALIVE_SECONDS);
    await this.ctx.storage.put('sessionID', sessionID);
    if (this.ctx.container?.running) {
      await this.ctx.container.setInactivityTimeout(timeout);
    }
    await this.ctx.storage.setAlarm(Date.now() + timeout);
  }

  async #prepareIdle(sessionID: string, span: Span): Promise<void> {
    const container = this.ctx.container;
    if (!container?.running) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    if (snapshotsEnabled(this.env.EXECUTOR_SNAPSHOTS_ENABLED)) {
      try {
        const snapshot = await container.snapshotContainer({});
        await this.ctx.storage.put('containerSnapshot', snapshot);
        span.setAttribute('container.snapshot.created', true);
        span.setAttribute('container.snapshot.id', snapshot.id);
        span.setAttribute('container.snapshot.size', snapshot.size);
      } catch (error) {
        await this.#armDeadline(sessionID);
        throw error;
      }
    } else {
      await this.ctx.storage.delete('containerSnapshot');
    }

    await this.#armDeadline(sessionID);
  }

  #attachContainerMonitor(sessionID: string): void {
    if (this.#containerMonitor || !this.ctx.container) return;
    const monitor = { expectedStop: false };
    this.#containerMonitor = monitor;
    void this.ctx.container
      .monitor()
      .then(
        () => this.#containerStopped(sessionID, monitor),
        (error) => this.#containerFailed(sessionID, monitor, error)
      )
      .catch((error) =>
        console.error({
          message: 'Could not restart Codex executor',
          sessionID,
          error: errorMessage(error)
        })
      );
  }

  #containerStopped(sessionID: string, monitor: ContainerMonitor): void {
    if (this.#containerMonitor === monitor) this.#containerMonitor = undefined;
    console.log({ message: 'Codex executor stopped', sessionID });
  }

  #containerFailed(
    sessionID: string,
    monitor: ContainerMonitor,
    error: unknown
  ): Promise<void> | undefined {
    if (monitor.expectedStop) {
      this.#containerStopped(sessionID, monitor);
      return;
    }
    if (this.#containerMonitor === monitor) this.#containerMonitor = undefined;
    return this.#restartAfterCrash(sessionID, error);
  }

  #expectContainerStop(): void {
    if (this.#containerMonitor) {
      this.#containerMonitor.expectedStop = true;
      this.#containerMonitor = undefined;
    }
  }

  #restartAfterCrash(sessionID: string, error: unknown): Promise<void> {
    const message = errorMessage(error);
    console.error({
      message: 'Codex executor crashed',
      sessionID,
      error: message
    });

    return this.#enqueue(() =>
      tracing.enterSpan('agents-api.executor.restart', async (span) => {
        span.setAttribute('openai.session_id', sessionID);
        span.setAttribute('container.error', message);
        span.setAttribute('error', true);
        span.setAttribute('error.message', message);
        await this.#updateSession({ sessionID, span });
      })
    );
  }

  async #destroy({
    preserveSnapshot
  }: { preserveSnapshot?: boolean } = {}): Promise<void> {
    return tracing.enterSpan('agents-api.executor.destroy', async (span) => {
      this.#expectContainerStop();
      span.setAttribute(
        'container.running',
        Boolean(this.ctx.container?.running)
      );
      if (this.ctx.container?.running) await this.ctx.container.destroy();
      await this.ctx.storage.deleteAlarm();
      if (preserveSnapshot) {
        await this.ctx.storage.delete('environmentID');
        await this.ctx.storage.delete('sessionID');
      } else {
        await this.ctx.storage.deleteAll();
      }
    });
  }
}

function requireRemoteURL(value: string): string {
  const remoteURL = value.trim();
  if (!remoteURL) throw new Error('OPENAI_REMOTE_URL must be non-empty.');
  return remoteURL;
}

function keepAliveMilliseconds(value: string): number {
  const seconds = Number(value);
  const milliseconds = seconds * 1_000;
  if (
    !Number.isSafeInteger(seconds) ||
    seconds <= 0 ||
    !Number.isSafeInteger(milliseconds) ||
    milliseconds > 604_800_000
  ) {
    throw new Error(
      'EXECUTOR_KEEP_ALIVE_SECONDS must be a positive safe integer no greater than 604800.'
    );
  }
  return milliseconds;
}

function prewarmEnabled(value: string): boolean {
  return value !== 'false';
}

function snapshotsEnabled(value: string): boolean {
  return value !== 'false';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function executorEnv({
  executorAPIKey,
  environmentID,
  remoteURL
}: {
  executorAPIKey: string;
  environmentID: string;
  remoteURL: string;
}) {
  return {
    CODEX_API_KEY: executorAPIKey,
    OPENAI_ENVIRONMENT_ID: environmentID,
    OPENAI_REMOTE_URL: remoteURL,
    HOME: '/root',
    USER: 'root',
    LOGNAME: 'root',
    LANG: 'C.UTF-8'
  };
}
