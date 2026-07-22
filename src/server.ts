import {
  getSandbox,
  proxyToSandbox,
  type Sandbox as SandboxType
} from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

type Env = {
  Sandbox: DurableObjectNamespace<SandboxType>;
};

const SANDBOX_ID = "repro829";
const SYNTHETIC_CUSTOM_DOMAIN = "repro.invalid";
const PREVIEW_PORT = 6080;
const PREVIEW_TOKEN = "repro829";

async function reproduce(env: Env): Promise<Response> {
  const startedAt = Date.now();
  const sandbox = getSandbox(env.Sandbox, SANDBOX_ID, { keepAlive: true });

  try {
    const exec = await sandbox.exec("printf container-exec-healthy");
    const desktopStart = await sandbox.desktop.start({ resolution: [1024, 768] });
    const desktopStatus = await sandbox.desktop.status();
    const portCheck = await sandbox.exec(
      "curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:6080/vnc.html"
    );

    const exposed = await sandbox.exposePort(PREVIEW_PORT, {
      hostname: SYNTHETIC_CUSTOM_DOMAIN,
      token: PREVIEW_TOKEN
    });

    const previewChecks: Array<{ attempt: number; status: number; body: string }> = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const previewRequest = new Request(new URL("/vnc.html", exposed.url), {
        headers: { "User-Agent": "sandbox-sdk-issue-829-repro" }
      });
      const previewResponse = await proxyToSandbox(previewRequest, env);
      if (!previewResponse) {
        previewChecks.push({ attempt, status: 0, body: "proxyToSandbox returned null" });
      } else {
        previewChecks.push({
          attempt,
          status: previewResponse.status,
          body: (await previewResponse.text()).slice(0, 500)
        });
      }
    }

    const containerHealthy =
      exec.success &&
      exec.stdout === "container-exec-healthy" &&
      portCheck.success &&
      portCheck.stdout === "200" &&
      desktopStatus.status !== "inactive";
    const allPreviewRequestsStale = previewChecks.every(
      (check) =>
        check.status === 410 && check.body.includes('"code":"STALE_PREVIEW_URL"')
    );

    return Response.json({
      reproduced: containerHealthy && allPreviewRequestsStale,
      sdkVersion: "0.11.0",
      containerImage: "cloudflare/sandbox:0.11.0-desktop",
      sandboxId: SANDBOX_ID,
      elapsedMs: Date.now() - startedAt,
      containerHealthy,
      evidence: {
        exec: { success: exec.success, exitCode: exec.exitCode, stdout: exec.stdout },
        desktopStart,
        desktopStatus,
        port6080FromContainer: {
          success: portCheck.success,
          exitCode: portCheck.exitCode,
          httpStatus: portCheck.stdout,
          stderr: portCheck.stderr
        },
        exposePort: exposed,
        previewChecks
      },
      expected: "Each preview request should return the noVNC vnc.html response (HTTP 200).",
      actual: allPreviewRequestsStale
        ? "All three requests returned HTTP 410 STALE_PREVIEW_URL."
        : "At least one preview request did not return STALE_PREVIEW_URL."
    });
  } catch (error) {
    return Response.json(
      {
        reproduced: false,
        sdkVersion: "0.11.0",
        containerImage: "cloudflare/sandbox:0.11.0-desktop",
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      },
      { status: 500 }
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const proxied = await proxyToSandbox(request, env);
    if (proxied) return proxied;

    const url = new URL(request.url);
    if (url.pathname === "/api/reproduce" && request.method === "POST") {
      return reproduce(env);
    }

    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
