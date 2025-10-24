import { getSandbox } from "@cloudflare/sandbox";

interface CmdOutput { success: boolean; stdout: string; stderr: string; };
// helper to read the outputs from `.exec` results
const getOutput = (res: CmdOutput) => res.success ? res.stdout : res.stderr;

const EXTRA_SYSTEM = "You are an automatic feature-implementer/bug-fixer." +
  "You apply all necessary changes to achieve the user request. You must ensure you DO NOT commit the changes, "  +
  "so the pipeline can read the local `git diff` and apply the change upstream."


export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "POST") {
      try {
        const { repo, task } = await request.json<{repo?: string, task?: string}>();
        if (!repo || !task) return new Response("invalid body", { status: 400 });
        
        
        // get the repo name
        const name = repo.split('/').pop() ?? "tmp";

        // open sandbox
        const sandbox = getSandbox(env.Sandbox, crypto.randomUUID().slice(0, 8));

        // git clone repo
        await sandbox.gitCheckout(repo, { targetDir: name });

        const { ANTHROPIC_API_KEY } = env;

        // Set env vars for the session
        await sandbox.setEnvVars({ ANTHROPIC_API_KEY });

        // kick off CC with our query
        const cmd = `cd ${name} && claude --append-system-prompt "${EXTRA_SYSTEM}" -p "${task.replaceAll("\"", "\\\"")}" --permission-mode acceptEdits`;

        const logs = getOutput(await sandbox.exec(cmd));
        const diff = getOutput(await sandbox.exec("git diff"));
        return Response.json({ logs, diff });
      } catch {
        return new Response("invalid body", { status: 400 });
      }
    }
    return new Response("not found");
  },
};

export { Sandbox } from "@cloudflare/sandbox";
