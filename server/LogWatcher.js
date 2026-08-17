'use strict';

const EventEmitter = require('events');

const MAX_RULES_PER_SERVICE = 20;
const MAX_LINE_BYTES = 4096; // guard the per-service line buffer
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g; // strip CSI/SGR sequences before matching

/**
 * Scans streaming log/output chunks against per-service regex rules and emits
 * `alert` events (serviceId, timestamp, line, rule) when a rule matches. Runs
 * in-process — cheap compared to the shell it's watching.
 *
 * A rule is: { id, name, pattern, flags?, severity? ('warn'|'crit'), cooldownMs? }
 *
 * Cooldown prevents alert storms when the shell dumps thousands of matching
 * lines back-to-back (a common log format failure); the alert fires once,
 * then coalesces until `cooldownMs` (default 5s) has passed.
 */
class LogWatcher extends EventEmitter {
  constructor() {
    super();
    this._perService = new Map(); // id -> { rules, buffer, lastFireAt: Map<ruleId, ts> }
  }

  /**
   * Replace this service's rule set. Invalid rules are dropped; the number of
   * dropped entries is returned so admin CRUD can surface it.
   */
  setRules(serviceId, rulesInput) {
    const rules = [];
    const list = Array.isArray(rulesInput) ? rulesInput : [];
    for (const r of list.slice(0, MAX_RULES_PER_SERVICE)) {
      if (!r || typeof r.pattern !== 'string' || !r.pattern) continue;
      let flags = typeof r.flags === 'string' ? r.flags : '';
      // Force non-global — global state on a shared RegExp breaks test() calls.
      flags = flags.replace(/[gy]/g, '');
      let re;
      try {
        re = new RegExp(r.pattern, flags);
      } catch {
        continue;
      }
      rules.push({
        id: r.id ? String(r.id) : 'rule_' + Math.random().toString(36).slice(2, 10),
        name: String(r.name || r.pattern).slice(0, 80),
        pattern: r.pattern,
        flags,
        severity: r.severity === 'crit' ? 'crit' : 'warn',
        cooldownMs:
          Number.isFinite(r.cooldownMs) && r.cooldownMs >= 0
            ? Math.floor(r.cooldownMs)
            : 5000,
        _re: re,
      });
    }
    const state = this._ensure(serviceId);
    state.rules = rules;
    state.lastFireAt = new Map();
    return { count: rules.length, dropped: list.length - rules.length };
  }

  getRules(serviceId) {
    const state = this._perService.get(serviceId);
    if (!state) return [];
    return state.rules.map((r) => ({
      id: r.id,
      name: r.name,
      pattern: r.pattern,
      flags: r.flags,
      severity: r.severity,
      cooldownMs: r.cooldownMs,
    }));
  }

  removeService(serviceId) {
    this._perService.delete(serviceId);
  }

  /**
   * Feed a raw output chunk. Line splitting is done here so a match can never
   * span two write() calls: we buffer any trailing non-newline bytes for the
   * next feed().
   */
  feed(serviceId, chunk) {
    const state = this._perService.get(serviceId);
    if (!state || !state.rules.length) return;
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    state.buffer += text;
    if (state.buffer.length > MAX_LINE_BYTES) {
      // A single line longer than our cap — flush what we have as a "line".
      this._testLine(serviceId, state, state.buffer);
      state.buffer = '';
      return;
    }
    let idx;
    while ((idx = state.buffer.indexOf('\n')) !== -1) {
      const line = state.buffer.slice(0, idx);
      state.buffer = state.buffer.slice(idx + 1);
      if (line) this._testLine(serviceId, state, line);
    }
  }

  _testLine(serviceId, state, rawLine) {
    // Strip ANSI so rules like /ERROR/ still hit lines coloured by the app.
    const clean = rawLine.replace(ANSI_RE, '').replace(/\r$/, '');
    if (!clean) return;
    const now = Date.now();
    for (const rule of state.rules) {
      let hit;
      try {
        hit = rule._re.test(clean);
      } catch {
        hit = false;
      }
      if (!hit) continue;
      const last = state.lastFireAt.get(rule.id) || 0;
      if (now - last < rule.cooldownMs) continue;
      state.lastFireAt.set(rule.id, now);
      this.emit('alert', {
        serviceId,
        timestamp: now,
        line: clean.slice(0, MAX_LINE_BYTES),
        rule: {
          id: rule.id,
          name: rule.name,
          pattern: rule.pattern,
          severity: rule.severity,
        },
      });
    }
  }

  _ensure(serviceId) {
    let state = this._perService.get(serviceId);
    if (!state) {
      state = { rules: [], buffer: '', lastFireAt: new Map() };
      this._perService.set(serviceId, state);
    }
    return state;
  }
}

module.exports = LogWatcher;
