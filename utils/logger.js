/**
 * Structured JSON Logger
 * Zero dependencies, extremely lightweight and fast.
 */

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'INFO'] || LOG_LEVELS.INFO;

function log(level, message, meta = {}) {
  if (LOG_LEVELS[level] < CURRENT_LEVEL) return;

  const logObject = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta
  };

  if (process.env.NODE_ENV === 'test') {
    // Cleaner console logs during testing
    if (level === 'ERROR') {
      console.error(`[${level}] ${message}`, meta.error || '');
    } else {
      console.log(`[${level}] ${message}`);
    }
  } else {
    console.log(JSON.stringify(logObject));
  }
}

module.exports = {
  debug: (msg, meta) => log('DEBUG', msg, meta),
  info: (msg, meta) => log('INFO', msg, meta),
  warn: (msg, meta) => log('WARN', msg, meta),
  error: (msg, meta) => log('ERROR', msg, { ...meta, error: meta instanceof Error ? meta.stack : (meta?.stack || meta?.error) })
};
