/**
 * Levelled logger for the author tools.
 *
 * LOG_LEVEL (env): debug | info | warn | error | silent. Default: info.
 * Example: LOG_LEVEL=debug npm run build:search
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const active = LEVELS[process.env.LOG_LEVEL] ? process.env.LOG_LEVEL : "info";

function emit(level, scope, args) {
  if (LEVELS[level] < LEVELS[active]) return;
  const stream = level === "error" || level === "warn" ? console.error : console.log;
  stream(`[${level}] [${scope}]`, ...args);
}

export function logger(scope) {
  return {
    debug: (...args) => emit("debug", scope, args),
    info: (...args) => emit("info", scope, args),
    warn: (...args) => emit("warn", scope, args),
    error: (...args) => emit("error", scope, args),
  };
}
