export type LogLevel = "debug" | "info" | "warn" | "error";

function shouldEnableDebug(): boolean {
  // Enable via NEXT_PUBLIC_DEBUG_LOG=1 or localStorage('debug') containing 'realtime'
  try {
    if (typeof process !== "undefined" && process.env && process.env.NEXT_PUBLIC_DEBUG_LOG === "1") return true;
  } catch {}
  try {
    if (typeof window !== "undefined") {
      const dbg = window.localStorage.getItem("debug") || "";
      if (dbg.includes("realtime") || dbg.includes("pawto")) return true;
    }
  } catch {}
  return false;
}

export class DebugLogger {
  private scope: string;
  private enabled: boolean;

  constructor(scope: string) {
    this.scope = scope;
    this.enabled = shouldEnableDebug();
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