import { SandboxFileError, SandboxProtocolError } from "@cloudflare/sandbox";
import { z } from "zod";

import type { CodingAgentEnv } from "./sandbox";

const SANDBOX_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const repositoryRequestSchema = z.object({
  url: z.url({ protocol: /^https$/, hostname: /^github\.com$/ }),
  ref: z.string().min(1).optional(),
});

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/sandboxes\/([^/]+)\/(repository|task|events|diff|execution)$/.exec(
      url.pathname,
    );
    if (match === null) return new Response("Not found", { status: 404 });

    const sandboxName = match[1];
    const resource = match[2];
    if (!SANDBOX_NAME_PATTERN.test(sandboxName)) {
      return new Response(
        "sandbox name must contain 1-63 lowercase letters, digits, or hyphens and start with a letter or digit",
        { status: 400 },
      );
    }

    const sandbox = env.SANDBOX.getByName(sandboxName);
    try {
      if (resource === "repository" && request.method === "POST") {
        const parsed = repositoryRequestSchema.safeParse(
          await request.json().catch(() => undefined),
        );
        if (!parsed.success) {
          return new Response('Body must be {"url": "https://github.com/...", "ref"?: string}', {
            status: 400,
          });
        }
        const result = await sandbox.cloneRepository(sandboxName, parsed.data.url, parsed.data.ref);
        return Response.json(result, { status: result.exitCode === 0 ? 200 : 502 });
      }
      if (resource === "task" && request.method === "POST") {
        const prompt = await request.text();
        if (prompt.trim() === "") return new Response("Prompt is required", { status: 400 });
        const started = await sandbox.startTask(sandboxName, prompt);
        if (started === "busy") return new Response("A task is already running", { status: 409 });
        return Response.json({ state: "running" }, { status: 202 });
      }
      if (resource === "task" && request.method === "GET") {
        return Response.json(await sandbox.readTask());
      }
      if (resource === "events" && request.method === "GET") {
        return await sandbox.readEvents();
      }
      if (resource === "diff" && request.method === "GET") {
        const result = await sandbox.readDiff(sandboxName);
        if (result.exitCode !== 0) return Response.json(result, { status: 502 });
        return new Response(result.stdout, { headers: { "content-type": "text/plain" } });
      }
      if (resource === "execution" && request.method === "DELETE") {
        await sandbox.resetExecution();
        return new Response(null, { status: 204 });
      }
      return new Response("Method not allowed", { status: 405 });
    } catch (cause) {
      console.error({
        event: "sandbox.request.failed",
        sandboxName,
        resource,
        error: describeError(cause),
      });
      return errorResponse(cause);
    }
  },
} satisfies ExportedHandler<CodingAgentEnv>;

// Structured logs drop an Error's message and stack because they are not enumerable.
function describeError(cause: unknown): string {
  return cause instanceof Error && cause.stack !== undefined ? cause.stack : String(cause);
}

function errorResponse(cause: unknown): Response {
  if (SandboxFileError.is(cause)) {
    if (cause.code === "ENOENT") return new Response("Workspace file not found", { status: 404 });
    return new Response("Workspace file operation failed", { status: 500 });
  }
  if (SandboxProtocolError.is(cause)) {
    return new Response("Sandbox file protocol failed", { status: 500 });
  }
  return new Response("Sandbox request failed", { status: 500 });
}
