import { AgentAPISDK } from '@openai/agents-api-preview';
import { runAgentTask } from './agent-task.js';
import type { SessionManager, SessionResult } from './types.js';

export type SessionManagerConfig = {
  agentID: string;
  executorClientSecret: string;
  executorURL: string;
  taskTimeoutMS: number;
};

export class AgentsSessionManager implements SessionManager {
  readonly #client: AgentAPISDK;
  readonly #config: SessionManagerConfig;

  constructor(config: SessionManagerConfig, client = new AgentAPISDK()) {
    this.#config = config;
    this.#client = client;
  }

  async create(input: string): Promise<SessionResult> {
    const session = await this.#client.beta.agents.sessions.create({
      agent_id: this.#config.agentID,
      environment: {
        type: 'self_hosted',
        workspace_directory: '/workspace'
      }
    });
    try {
      return await this.run(session.id, input);
    } catch (error) {
      await this.delete(session.id).catch(() => undefined);
      throw error;
    }
  }

  async run(sessionID: string, input: string): Promise<SessionResult> {
    await this.#client.beta.agents.sessions.retrieve(sessionID);
    const output = await runAgentTask(
      this.#client,
      sessionID,
      input,
      this.#config.taskTimeoutMS
    );
    return { sessionID, output };
  }

  async delete(sessionID: string): Promise<void> {
    let sessionError: unknown;
    try {
      await this.#client.beta.agents.sessions.delete(sessionID);
    } catch (error) {
      sessionError = error;
    }

    const response = await fetch(
      `${this.#config.executorURL}/executors/${encodeURIComponent(sessionID)}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${this.#config.executorClientSecret}`
        },
        signal: AbortSignal.timeout(30_000)
      }
    );
    if (!response.ok) {
      throw new Error(
        `Executor cleanup failed with status ${response.status}.`
      );
    }
    if (sessionError) throw sessionError;
  }
}
