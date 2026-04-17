import pino from "pino";
import { resolve } from "path";
import { mkdirSync } from "fs";

let dirEnsured = false;

export function createLogger(service: string) {
  // Lazy init: return a proxy that creates the real logger on first use
  let _logger: pino.Logger | null = null;

  function getLogger(): pino.Logger {
    if (!_logger) {
      // Read LOG_DIR at first-use time so dotenv has had a chance to load
      const LOG_DIR = process.env.LOG_DIR || "/root/agent-platform/logs";
      if (!dirEnsured) {
        try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}
        dirEnsured = true;
      }
      const logFile = resolve(LOG_DIR, `${service}.log`);
      _logger = pino(
        {
          level: process.env.LOG_LEVEL || "debug",
          base: { service },
          timestamp: pino.stdTimeFunctions.isoTime,
        },
        pino.multistream([
          { stream: pino.destination({ dest: logFile, append: true, sync: false }) },
          { level: "info", stream: process.stdout },
        ])
      );
    }
    return _logger;
  }

  return new Proxy({} as pino.Logger, {
    get(_target, prop) {
      const logger = getLogger();
      const val = (logger as any)[prop];
      if (typeof val === "function") return val.bind(logger);
      return val;
    },
  });
}
