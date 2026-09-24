import { z } from "zod";

import { type AgentCommand, CodingAgentSandbox, type TaskOutcome } from "../../shared/sandbox";

export { default } from "../../shared/handler";
export { Outbound } from "../../shared/outbound";

const piEventSchema = z.union([
  z.object({ type: z.literal("agent_settled") }),
  z.object({
    type: z.literal("message_end"),
    message: z.object({
      role: z.literal("assistant"),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
      stopReason: z.string(),
      errorMessage: z.string().optional(),
    }),
  }),
]);

export class PiSandbox extends CodingAgentSandbox {
  protected readonly agent = "pi";

  protected command(prompt: string): AgentCommand {
    return {
      argv: [
        "pi",
        "--mode",
        "json",
        "--no-session",
        "--provider",
        "cloudflare-ai-gateway",
        "--model",
        this.env.MODEL,
        "--",
        prompt,
      ],
      env: {
        // Pi requires a key; the Worker replaces this placeholder with the gateway token.
        CLOUDFLARE_API_KEY: "provided-by-worker",
        CLOUDFLARE_ACCOUNT_ID: this.env.AI_GATEWAY_ACCOUNT_ID,
        CLOUDFLARE_GATEWAY_ID: this.env.AI_GATEWAY_ID,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
      },
    };
  }

  // Pi exits 0 even when the model call fails, so the outcome comes from its events:
  // the run must settle, and the last assistant message must not end in an error.
  protected async outcome(exitCode: number): Promise<TaskOutcome> {
    if (exitCode !== 0) return this.exitFailure(exitCode);
    let settled = false;
    let final:
      | Extract<z.infer<typeof piEventSchema>, { type: "message_end" }>["message"]
      | undefined;
    for await (const event of this.events(piEventSchema)) {
      if (event.type === "agent_settled") settled = true;
      else final = event.message;
    }
    if (!settled || final === undefined) {
      return { state: "failed", error: "pi exited before the agent settled" };
    }
    if (final.stopReason === "error" || final.stopReason === "aborted") {
      return { state: "failed", error: final.errorMessage ?? `pi stopped: ${final.stopReason}` };
    }
    const text = final.content.flatMap((block) =>
      block.type === "text" ? [block.text ?? ""] : [],
    );
    return { state: "succeeded", result: text.join("") };
  }
}
