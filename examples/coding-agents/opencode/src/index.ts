import { z } from "zod";

import { type AgentCommand, CodingAgentSandbox, type TaskOutcome } from "../../shared/sandbox";

export { default } from "../../shared/handler";
export { Outbound } from "../../shared/outbound";

const opencodeEventSchema = z.union([
  z.object({ type: z.literal("text"), part: z.object({ text: z.string() }) }),
  z.object({
    type: z.literal("error"),
    error: z.object({
      name: z.string(),
      data: z.object({ message: z.string().optional() }).optional(),
    }),
  }),
]);

export class OpencodeSandbox extends CodingAgentSandbox {
  protected readonly agent = "opencode";

  protected command(prompt: string): AgentCommand {
    return {
      argv: [
        "opencode",
        "run",
        "--format",
        "json",
        "--auto",
        "--model",
        this.env.MODEL,
        "--",
        prompt,
      ],
      env: {
        // OpenCode requires a token; the Worker replaces this placeholder with the gateway token.
        CLOUDFLARE_API_TOKEN: "provided-by-worker",
        CLOUDFLARE_ACCOUNT_ID: this.env.AI_GATEWAY_ACCOUNT_ID,
        CLOUDFLARE_GATEWAY_ID: this.env.AI_GATEWAY_ID,
        // Use the model list built into the binary and skip other downloads and uploads.
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
        OPENCODE_DISABLE_SHARE: "1",
      },
    };
  }

  // OpenCode exits nonzero on any model or session error. The last text part is the answer;
  // error events explain a failure.
  protected async outcome(exitCode: number): Promise<TaskOutcome> {
    let text = "";
    let error: string | undefined;
    for await (const event of this.events(opencodeEventSchema)) {
      if (event.type === "text") text = event.part.text;
      else error = event.error.data?.message ?? event.error.name;
    }
    if (exitCode === 0) return { state: "succeeded", result: text };
    if (error === undefined) return this.exitFailure(exitCode);
    return { state: "failed", error };
  }
}
