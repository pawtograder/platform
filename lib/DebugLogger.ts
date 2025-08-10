export type LogLevel = "debug" | "info" | "warn" | "error";

export class DebugLogger {
  private scope: string;
  private enabled: boolean;

  constructor(scope: string) {
    this.scope = scope;
    // Always enabled per request to not rely on env or localStorage
    this.enabled = true;
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }

  private prefix(level: LogLevel) {
    const ts = new Date().toISOString();
    return `[${ts}] [${level.toUpperCase()}] [${this.scope}]`;
  }

  debug(...args: unknown[]) {
    if (!this.enabled) return;
    // eslint-disable-next-line no-console
    console.debug(this.prefix("debug"), ...args);
  }
  info(...args: unknown[]) {
    if (!this.enabled) return;
    // eslint-disable-next-line no-console
    console.info(this.prefix("info"), ...args);
  }
  warn(...args: unknown[]) {
    if (!this.enabled) return;
    // eslint-disable-next-line no-console
    console.warn(this.prefix("warn"), ...args);
  }
  error(...args: unknown[]) {
    if (!this.enabled) return;
    // eslint-disable-next-line no-console
    console.error(this.prefix("error"), ...args);
  }
}

export function createLogger(scope: string) {
  return new DebugLogger(scope);
}