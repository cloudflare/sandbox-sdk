import { getSandbox } from '@cloudflare/sandbox';

export { Sandbox } from '@cloudflare/sandbox';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const sandbox = getSandbox(env.Sandbox, 'my-sandbox');

    if (url.pathname === '/run') {
      const proc = await sandbox.exec([
        '/bin/bash',
        '-lc',
        'echo "2 + 2 = $((2 + 2))"'
      ]);
      const out = await proc.output();
      return Response.json({
        output: new TextDecoder().decode(out.stdout),
        error: new TextDecoder().decode(out.stderr),
        exitCode: out.exitCode,
        success: out.exitCode === 0
      });
    }

    if (url.pathname === '/file') {
      await sandbox.writeFile('/workspace/hello.txt', 'Hello, Sandbox!');
      const file = await sandbox.readFile('/workspace/hello.txt');
      return Response.json({
        content: file.content
      });
    }

    return new Response('Try /run or /file');
  }
};
