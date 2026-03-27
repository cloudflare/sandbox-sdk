import type { PluginInput } from '@opencode-ai/plugin';

export default interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  log(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

export function createLogger({
  app
}: {
  app: PluginInput['client']['app'];
}): Logger {
  function log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    extra?: Record<string, unknown>
  ): void {
    app.log({
      body: {
        service: 'cloudflare-sandbox-plugin',
        level,
        message,
        extra
      }
    });
  }
  return {
    debug: log.bind(null, 'debug'),
    info: log.bind(null, 'info'),
    log: log.bind(null, 'info'),
    warn: log.bind(null, 'warn'),
    error: log.bind(null, 'error')
  };
}
