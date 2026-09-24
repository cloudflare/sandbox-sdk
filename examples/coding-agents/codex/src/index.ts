import { z } from "zod";

import { type AgentCommand, CodingAgentSandbox, type TaskOutcome } from "../../shared/sandbox";

export { default } from "../../shared/handler";
export { Outbound } from "../../shared/outbound";

const GATEWAY_HOST = "gateway.ai.cloudflare.com";

// Codex reports why a run failed as a turn.failed or error event.
const failureEventSchema = z.union([
  z.object({ type: z.literal("turn.failed"), error: z.object({ message: z.string() }) }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export class CodexSandbox extends CodingAgentSandbox {
  protected readonly agent = "codex";

  get #lastMessagePath(): string {
    return `${this.taskDirectory}/last-message.txt`;
  }

  protected command(prompt: string): AgentCommand {
    const baseUrl = `https://${GATEWAY_HOST}/v1/${this.env.AI_GATEWAY_ACCOUNT_ID}/${this.env.AI_GATEWAY_ID}/openai`;
    return {
      argv: [
        "codex",
        "exec",
        "--json",
        "--ephemeral",
        // The Container is the sandbox, so Codex runs commands without its own.
        "--dangerously-bypass-approvals-and-sandbox",
        "--output-last-message",
        this.#lastMessagePath,
        "--model",
        this.env.MODEL,
        // A custom provider sends no API key; the Worker adds the gateway token.
        "--config",
        'model_provider="cloudflare-ai-gateway"',
        "--config",
        `model_providers.cloudflare-ai-gateway={ name = "Cloudflare AI Gateway", base_url = ${JSON.stringify(baseUrl)}, wire_api = "responses" }`,
        "--config",
        "analytics.enabled=false",
        "--config",
        "check_for_update_on_startup=false",
        // Plugins sync a marketplace repository from GitHub on every run.
        "--config",
        "features.plugins=false",
        "--",
        prompt,
      ],
      env: {},
    };
  }

  // Codex exits nonzero when the turn fails, so the exit code decides the outcome.
  protected async outcome(exitCode: number): Promise<TaskOutcome> {
    if (exitCode === 0) {
      return { state: "succeeded", result: (await this.readTaskFile(this.#lastMessagePath)) ?? "" };
    }
    let failure: string | undefined;
    for await (const event of this.events(failureEventSchema)) {
      failure = event.type === "error" ? event.message : event.error.message;
    }
    if (failure === undefined) return this.exitFailure(exitCode);
    return { state: "failed", error: failure };
  }
}
