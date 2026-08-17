'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const session = require('express-session');

const USERS_FILE = path.join(__dirname, '..', 'users.json');
const DEFAULT_ADMIN_USERNAME = 'admin';
const DEFAULT_ADMIN_PASSWORD = 'adminpass';

const DEFAULT_TERMINAL_PREFS = Object.freeze({
  theme: 'shellHelper',
  fontSize: 13,
  fontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, "Courier New", monospace',
  customTheme: null, // when theme === 'custom', an xterm-style theme object
});

// Everything the frontend can round-trip. Anything else is ignored to keep
// users.json from turning into a junk drawer.
const ALLOWED_FONT_FAMILY_RE =
  /^[A-Za-z0-9 _\-,'"()]{1,200}$/;

function sanitizeTerminalPrefs(input) {
  if (!input || typeof input !== 'object') return { ...DEFAULT_TERMINAL_PREFS };
  const out = { ...DEFAULT_TERMINAL_PREFS };
  if (typeof input.theme === 'string' && input.theme.length <= 32) {
    out.theme = input.theme;
  }
  if (Number.isFinite(input.fontSize)) {
    out.fontSize = Math.max(8, Math.min(32, Math.round(input.fontSize)));
  }
  if (typeof input.fontFamily === 'string' && ALLOWED_FONT_FAMILY_RE.test(input.fontFamily)) {
    out.fontFamily = input.fontFamily;
  }
  if (input.customTheme && typeof input.customTheme === 'object') {
    out.customTheme = sanitizeThemeColors(input.customTheme);
  } else {
    out.customTheme = null;
  }
  return out;
}

// xterm colour keys we accept — matches xterm's ITheme, dropped silently
// otherwise. Values must be hex (#rgb / #rrggbb) or an rgba() literal.
const THEME_KEYS = [
  'background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground',
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
];
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]{1,60}\))$/;

function sanitizeThemeColors(input) {
  const out = {};
  for (const key of THEME_KEYS) {
    const v = input[key];
    if (typeof v === 'string' && COLOR_RE.test(v)) out[key] = v;
  }
  return out;
}

class UserStore {
  constructor() {
    this.users = [];
    this._load();
  }

  _load() {
    if (!fs.existsSync(USERS_FILE)) {
      const passwordHash = bcrypt.hashSync(DEFAULT_ADMIN_PASSWORD, 10);
      this.users = [
        {
          id: this._newId(),
          username: DEFAULT_ADMIN_USERNAME,
          passwordHash,
          role: 'admin',
          createdAt: new Date().toISOString(),
        },
      ];
      this._save();
      console.log(
        `[shellHelper] created default admin (username="${DEFAULT_ADMIN_USERNAME}" password="${DEFAULT_ADMIN_PASSWORD}") — change it after first login!`,
      );
      return;
    }
    const raw = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    this.users = Array.isArray(raw.users) ? raw.users : [];
  }

  _save() {
    fs.writeFileSync(
      USERS_FILE,
      JSON.stringify({ users: this.users }, null, 2),
      { mode: 0o600 },
    );
    try {
      fs.chmodSync(USERS_FILE, 0o600);
    } catch {
      /* best effort */
    }
  }

  _newId() {
    return 'u_' + crypto.randomBytes(6).toString('hex');
  }

  _publicUser(u) {
    return {
      id: u.id,
      username: u.username,
      role: u.role,
      createdAt: u.createdAt,
      terminalPrefs: sanitizeTerminalPrefs(u.terminalPrefs),
    };
  }

  list() {
    return this.users.map((u) => this._publicUser(u));
  }

  findByUsername(username) {
    return this.users.find((u) => u.username === username);
  }

  findById(id) {
    return this.users.find((u) => u.id === id);
  }

  async verify(username, password) {
    const user = this.findByUsername(username);
    if (!user) return null;
    const ok = await bcrypt.compare(String(password || ''), user.passwordHash);
    return ok ? this._publicUser(user) : null;
  }

  async create({ username, password, role = 'user' }) {
    if (!username || typeof username !== 'string') {
      throw new Error('username is required');
    }
    if (!/^[a-zA-Z0-9_.-]{2,32}$/.test(username)) {
      throw new Error('username must be 2-32 chars, letters/digits/._- only');
    }
    if (!password || password.length < 8) {
      throw new Error('password must be at least 8 characters');
    }
    if (this.findByUsername(username)) {
      throw new Error(`username "${username}" already exists`);
    }
    const user = {
      id: this._newId(),
      username,
      passwordHash: await bcrypt.hash(password, 10),
      role: role === 'admin' ? 'admin' : 'user',
      createdAt: new Date().toISOString(),
    };
    this.users.push(user);
    this._save();
    return this._publicUser(user);
  }

  updateTerminalPrefs(id, prefs) {
    const user = this.findById(id);
    if (!user) throw new Error('user not found');
    user.terminalPrefs = sanitizeTerminalPrefs({
      ...(user.terminalPrefs || {}),
      ...(prefs || {}),
    });
    this._save();
    return this._publicUser(user);
  }

  async changePassword(id, newPassword) {
    if (!newPassword || newPassword.length < 8) {
      throw new Error('password must be at least 8 characters');
    }
    const user = this.findById(id);
    if (!user) throw new Error('user not found');
    user.passwordHash = await bcrypt.hash(newPassword, 10);
    this._save();
  }

  delete(id) {
    const user = this.findById(id);
    if (!user) throw new Error('user not found');
    if (user.role === 'admin') {
      const admins = this.users.filter((u) => u.role === 'admin');
      if (admins.length <= 1) {
        throw new Error('cannot delete the last admin');
      }
    }
    this.users = this.users.filter((u) => u.id !== id);
    this._save();
  }
}

function createSessionMiddleware(secret) {
  return session({
    name: 'shellhelper.sid',
    secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 12 * 60 * 60 * 1000,
    },
  });
}

function currentUser(req) {
  return req.session && req.session.user ? req.session.user : null;
}

function requireAuth(req, res, next) {
  if (!currentUser(req)) {
    return res.status(401).json({ error: 'authentication required' });
  }
  next();
}

function requireAdmin(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'authentication required' });
  if (user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  next();
}

module.exports = {
  UserStore,
  createSessionMiddleware,
  currentUser,
  requireAuth,
  requireAdmin,
  sanitizeTerminalPrefs,
  DEFAULT_TERMINAL_PREFS,
};
