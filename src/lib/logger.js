'use strict';
const { nowLocal } = require('./util');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const current = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || 20;

function log(level, scope, msg, extra) {
  if (LEVELS[level] < current) return;
  const line = `${nowLocal().dt} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra !== undefined) out(line, extra instanceof Error ? extra.message : extra);
  else out(line);
}

module.exports = (scope) => ({
  debug: (m, e) => log('debug', scope, m, e),
  info: (m, e) => log('info', scope, m, e),
  warn: (m, e) => log('warn', scope, m, e),
  error: (m, e) => log('error', scope, m, e),
});
