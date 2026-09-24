import { z } from "zod";

import { type AgentCommand, CodingAgentSandbox, type TaskOutcome } from "../../shared/sandbox";

export { default } from "../../shared/handler";
export { Outbound } from "../../shared/outbound";

const GATEWAY_HOST = "gateway.ai.cloudflare.com";

const resultEventSchema = z.object({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().optional(),
});

export class ClaudeCodeSandbox extends CodingAgentSandbox {
  protected readonly agent = "claude";

  protected command(prompt: string): AgentCommand {
    return {
      argv: [
        "claude",
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "--no-session-persistence",
        "--model",
        this.env.MODEL,
        "--",
        prompt,
      ],
      env: {
        ANTHROPIC_BASE_URL: `https://${GATEWAY_HOST}/v1/${this.env.AI_GATEWAY_ACCOUNT_ID}/${this.env.AI_GATEWAY_ID}/anthropic`,
        // Claude Code requires a key; the Worker drops it and adds the gateway token.
        ANTHROPIC_API_KEY: "provided-by-worker",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        // The Container runs as root, where skipping permissions requires this.
        IS_SANDBOX: "1",
      },
    };
  }

  // The final result event carries the outcome, including model and turn-limit failures.
  // A failed model call still reports subtype "success", so read is_error.
  protected async outcome(exitCode: number): Promise<TaskOutcome> {
    let result: z.infer<typeof resultEventSchema> | undefined;
    for await (const event of this.events(resultEventSchema)) result = event;
    if (result === undefined) return this.exitFailure(exitCode);
    if (result.is_error) return { state: "failed", error: result.result ?? result.subtype };
    return { state: "succeeded", result: result.result ?? "" };
  }
}
