// Global flag to enable/disable logging
const DEBUG = true;

class Logger {
  private enabled: boolean;

  constructor(enabled: boolean = DEBUG) {
    this.enabled = enabled;
  }

  log(message: string, ...args: any[]): void {
    if (this.enabled) {
      console.log(`[LOG] ${message}`, ...args);
    }
  }

  info(message: string, ...args: any[]): void {
    if (this.enabled) {
      console.info(`[INFO] ${message}`, ...args);
    }
  }

  warn(message: string, ...args: any[]): void {
    if (this.enabled) {
      console.warn(`[WARN] ${message}`, ...args);
    }
  }

  error(message: string, ...args: any[]): void {
    // Errors are always logged regardless of DEBUG flag
    console.error(`[ERROR] ${message}`, ...args);
  }

  debug(message: string, ...args: any[]): void {
    if (this.enabled) {
      console.debug(`[DEBUG] ${message}`, ...args);
    }
  }
}

export const logger = new Logger();
