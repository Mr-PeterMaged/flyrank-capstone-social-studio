// Structured JSON logger that redacts secrets by KEY NAME (anywhere in the object) and
// by literal VALUE (anything registered via addSecret). Tokens never reach the logs,
// even if some code accidentally passes them in.
const SENSITIVE_KEY = /token|secret|authorization|password|api[-_]?key|signature/i;
const secrets = new Set();

export function addSecret(value) {
  if (typeof value === 'string' && value.length >= 8) secrets.add(value);
}

function scrubString(s) {
  let out = s;
  for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
  return out;
}

function redact(value, depth = 0) {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: scrubString(value.message) };
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1)]),
    );
  }
  return value;
}

let sink = (line) => process.stdout.write(line + '\n');
export const setLogSink = (fn) => {
  sink = fn;
};

function emit(level, msg, fields) {
  sink(JSON.stringify({ ts: new Date().toISOString(), level, msg: scrubString(String(msg)), ...(redact(fields) ?? {}) }));
}

export const log = {
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
};
