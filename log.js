// One-line structured logs: `2026-10-24T13:20:01.123Z INFO  session.press id=Ab3dE9 player=1 action=buzz`.
// Errors go to stderr (pm2's error log), everything else to stdout. Never pass secrets (session keys) in here.
function format(value) {
  if (value === undefined || value === null) return String(value);
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return /[\s"=]/.test(text) ? JSON.stringify(text) : text;
}

function log(level, event, fields = {}) {
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${format(v)}`);
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${event}${parts.length ? ` ${parts.join(' ')}` : ''}`;
  (level === 'error' ? console.error : console.log)(line);
}

module.exports = {
  info: (event, fields) => log('info', event, fields),
  warn: (event, fields) => log('warn', event, fields),
  error: (event, fields) => log('error', event, fields),
  // Session ids are long random strings; a prefix is enough to follow one through the log.
  short: (id) => String(id).slice(0, 6),
};
