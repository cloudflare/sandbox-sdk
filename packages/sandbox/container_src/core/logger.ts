// Simple console logger implementation
import type { Logger } from './types';

export class ConsoleLogger implements Logger {
  info(message: string, meta?: Record<string, unknown>): void {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    console.log(`[${timestamp}] INFO: ${message}${metaStr}`);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    console.warn(`[${timestamp}] WARN: ${message}${metaStr}`);
  }

  error(message: string, error?: Error, meta?: Record<string, unknown>): void {
    const timestamp = new Date().toISOString();
    const errorStr = error ? ` Error: ${error.message}` : '';
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    console.error(`[${timestamp}] ERROR: ${message}${errorStr}${metaStr}`);
    if (error?.stack) {
      console.error(error.stack);
    }
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
    console.debug(`[${timestamp}] DEBUG: ${message}${metaStr}`);
  }
}