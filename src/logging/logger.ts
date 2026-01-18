export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

export interface Logger {
  log(message?: unknown, ...optionalParams: unknown[]): void;
  info(message?: unknown, ...optionalParams: unknown[]): void;
  warn(message?: unknown, ...optionalParams: unknown[]): void;
  error(message?: unknown, ...optionalParams: unknown[]): void;
  debug(message?: unknown, ...optionalParams: unknown[]): void;

  /** Create a child logger that prefixes messages with the given tag. */
  child?(tag: string): Logger;
}

export type LoggerLike = Partial<Logger> | Console;

const noop = (): void => {
  // intentionally empty
};

function resolveMethod(base: any, name: keyof Logger): ((...args: any[]) => void) {
  const fn = base?.[name];
  if (typeof fn === "function") return fn.bind(base);

  const fallback = base?.log;
  if (typeof fallback === "function") return fallback.bind(base);

  return noop;
}

export function asLogger(logger?: LoggerLike): Logger {
  const base: any = logger ?? console;

  const out: Logger = {
    log: resolveMethod(base, "log"),
    info: resolveMethod(base, "info"),
    warn: resolveMethod(base, "warn"),
    error: resolveMethod(base, "error"),
    debug: resolveMethod(base, "debug"),
  };

  // Add child() only if it's meaningful (keeps object small).
  out.child = (tag: string): Logger => createTaggedLogger(out, tag);
  return out;
}

export function createNullLogger(): Logger {
  const out: Logger = {
    log: noop,
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
  };
  out.child = (): Logger => out;
  return out;
}

function levelToRank(level: LogLevel): number {
  switch (level) {
    case "silent":
      return 0;
    case "error":
      return 1;
    case "warn":
      return 2;
    case "info":
      return 3;
    case "debug":
      return 4;
    default:
      return 3;
  }
}

export function createLogger(options?: {
  base?: LoggerLike;
  level?: LogLevel;
  tag?: string;
}): Logger {
  const base = asLogger(options?.base);
  const level = options?.level ?? "info";
  const tag = options?.tag;

  const minRank = levelToRank(level);
  const shouldLog = (msgLevel: LogLevel): boolean => levelToRank(msgLevel) <= minRank && minRank !== 0;

  const prefix = tag ? `[${tag}] ` : "";

  const wrap = (fn: (...args: any[]) => void) => {
    return (message?: unknown, ...optionalParams: unknown[]) => {
      if (typeof message === "string") fn(`${prefix}${message}`, ...optionalParams);
      else if (message !== undefined) fn(prefix, message, ...optionalParams);
      else fn(prefix.trimEnd(), ...optionalParams);
    };
  };

  const out: Logger = {
    error: shouldLog("error") ? wrap(base.error) : noop,
    warn: shouldLog("warn") ? wrap(base.warn) : noop,
    info: shouldLog("info") ? wrap(base.info) : noop,
    log: shouldLog("info") ? wrap(base.log) : noop,
    debug: shouldLog("debug") ? wrap(base.debug) : noop,
  };

  out.child = (childTag: string): Logger => {
    const combined = tag ? `${tag}:${childTag}` : childTag;
    return createLogger({ base, level, tag: combined });
  };

  return out;
}

export function createTaggedLogger(base: LoggerLike | Logger, tag: string): Logger {
  // Preserve any existing level filtering on "base" by not re-wrapping through createLogger().
  const b = (base as Logger).log ? (base as Logger) : asLogger(base as LoggerLike);
  const prefix = `[${tag}] `;

  const wrap = (fn: (...args: any[]) => void) => {
    return (message?: unknown, ...optionalParams: unknown[]) => {
      if (typeof message === "string") fn(`${prefix}${message}`, ...optionalParams);
      else if (message !== undefined) fn(prefix, message, ...optionalParams);
      else fn(prefix.trimEnd(), ...optionalParams);
    };
  };

  const out: Logger = {
    log: wrap(b.log),
    info: wrap(b.info),
    warn: wrap(b.warn),
    error: wrap(b.error),
    debug: wrap(b.debug),
  };
  out.child = (childTag: string): Logger => createTaggedLogger(out, childTag);
  return out;
}

/**
 * Wrap a base logger so that `debug()` is a no-op unless `enabled`.
 * Useful to route verbosity through `DebugOptions` without touching every callsite.
 */
export function createDebugGateLogger(base?: LoggerLike, enabled: boolean = false): Logger {
  const b = asLogger(base);
  const out: Logger = {
    log: b.log,
    info: b.info,
    warn: b.warn,
    error: b.error,
    debug: enabled ? b.debug : noop,
  };
  out.child = (tag: string): Logger => createDebugGateLogger(createTaggedLogger(out, tag), enabled);
  return out;
}

let globalLogger: Logger | undefined;

export function setGlobalLogger(logger: LoggerLike | Logger | undefined): void {
  globalLogger = logger ? (logger as any).log ? (logger as Logger) : asLogger(logger as LoggerLike) : undefined;
}

export function getGlobalLogger(): Logger {
  return globalLogger ?? asLogger(console);
}
