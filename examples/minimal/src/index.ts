import { ContainerProxy, getSandbox, Sandbox } from '@cloudflare/sandbox';

export { ContainerProxy };

export class InterceptorSandbox extends Sandbox<Env> {
  enableInternet = true;

  // Intercepts outbound HTTP to intercept.test specifically
  static outboundByHost = {
    'intercept.test': (
      request: Request,
      _env: Env,
      ctx: { containerId: string }
    ) => {
      console.log(`[outboundByHost] ${request.method} ${request.url}`);
      return Response.json({
        intercepted: true,
        handler: 'outboundByHost',
        url: request.url,
        containerId: ctx.containerId
      });
    }
  };

  // Catch-all: intercepts all other outbound HTTP from the container
  static outbound = (
    request: Request,
    _env: Env,
    ctx: { containerId: string }
  ) => {
    console.log(`[outbound] ${request.method} ${request.url}`);
    return Response.json({
      intercepted: true,
      handler: 'outbound',
      url: request.url,
      containerId: ctx.containerId
    });
  };
}

/**
 * Comment/Uncomment these lines to recreate issue.
 *
 * We're essentially removing + re-adding the declarations back after definition here
 * which fixes the issue
 */
// const _outbound = InterceptorSandbox.outbound;
// const _outboundByHost = InterceptorSandbox.outboundByHost;
// Reflect.deleteProperty(InterceptorSandbox, 'outbound');
// Reflect.deleteProperty(InterceptorSandbox, 'outboundByHost');
// InterceptorSandbox.outbound = _outbound;
// InterceptorSandbox.outboundByHost = _outboundByHost;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Get or create a sandbox instance
    const sandbox = getSandbox(env.InterceptorSandbox, 'my-sandbox');

    if (url.pathname === '/intercept') {
      const response = await sandbox.exec(
        "curl -sS --resolve 'example.test:80:198.51.100.1' http://example.test"
      );
      return Response.json({
        output: response.stdout,
        error: response.stderr,
        exitCode: response.exitCode,
        success: response.success
      });
    }

    // Execute a shell command
    if (url.pathname === '/run') {
      const result = await sandbox.exec('echo "2 + 2 = $((2 + 2))"');
      return Response.json({
        output: result.stdout,
        error: result.stderr,
        exitCode: result.exitCode,
        success: result.success
      });
    }

    // Work with files
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
