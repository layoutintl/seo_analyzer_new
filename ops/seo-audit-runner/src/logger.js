/**
 * Minimal leveled logger with secret redaction.
 *
 * Every line is passed through redact():
 *  - URL credentials (`//user:pass@host`) become `//***:***@host`
 *  - any string registered in `secrets` (e.g. the Slack webhook URL)
 *    is replaced with [REDACTED]
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

export function createLogger({ level = 'info', stream = process.stderr, secrets = [] } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const activeSecrets = secrets.filter((s) => typeof s === 'string' && s.length > 0);

  function redact(input) {
    let text = String(input);
    text = text.replace(/\/\/[^@/\s]+@/g, '//***:***@');
    for (const secret of activeSecrets) {
      text = text.split(secret).join('[REDACTED]');
    }
    return text;
  }

  function write(lvl, message) {
    if (LEVELS[lvl] > threshold) return;
    stream.write(`[${new Date().toISOString()}] ${lvl.toUpperCase().padEnd(5)} ${redact(message)}\n`);
  }

  return {
    level,
    redact,
    error: (msg) => write('error', msg),
    warn: (msg) => write('warn', msg),
    info: (msg) => write('info', msg),
    debug: (msg) => write('debug', msg),
  };
}
