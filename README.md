# shellHelper

A lightweight, generalized process control panel with live web terminals.
Manage local shells and remote SSH machines through a browser with a real
xterm.js terminal wired to `node-pty` (local) or `ssh2` (remote).

**Features**

- Multi-user with per-shell ACLs and bcrypt-hashed passwords
- **Multi-terminal tabs** — open several shells side-by-side in one browser
- **SSH shells** — password or private-key auth, encrypted at rest
- **Host-key pinning (TOFU)** — first connect pins, later mismatches are rejected
- **SFTP file browser** — list/download/upload/mkdir/delete on any SSH shell
- **Session recording** — asciinema v2 casts, playable in-browser
- **Auto-restart with exponential backoff** — supervisor mode for crashy shells
- **Persistent rotating logs** per service
- **Autostart on boot** flag

## Folder tree

```
shellHelper/
├── .env / .env.example
├── package.json
├── README.md
├── services.json          # persisted shell definitions
├── users.json             # auto-created on first boot (chmod 0600)
├── data/                  # auto-created at runtime
│   ├── logs/<id>.log[.1,.2,...]
│   ├── recordings/<id>__<ts>.cast
│   └── known_hosts.json
├── public/
│   ├── app.js
│   ├── index.html
│   └── styles.css
└── server/
    ├── auth.js            # user store, sessions, admin middleware
    ├── crypto.js          # AES-GCM encrypt/decrypt
    ├── knownHosts.js      # SSH host-key store
    ├── logger.js          # persistent log writer w/ rotation
    ├── recorder.js        # asciinema v2 cast writer
    ├── sftp.js            # ssh2 sftp wrapper (list/upload/download/mkdir/delete)
    ├── TaskManager.js     # service registry, lifecycle, ACLs, restart, recording
    ├── index.js           # Express + Socket.IO entry
    └── sessions/
        ├── LocalSession.js
        └── SshSession.js
```

## Install & run

```bash
npm install
# If node-pty's binary is missing (Node with no prebuild), rebuild once:
cd node_modules/node-pty && npx --yes node-gyp rebuild && cd ../..

npm run start     # http://localhost:3030
```

Default admin on first boot: **`admin` / `adminpass`** — change immediately via
the 🔑 button in the sidebar footer.

## Adding shells

Admin panel (⚙︎ button, admin-only) → **Shells** tab → **Add shell**.

**Local shells** — command, args, cwd. Runs via `node-pty` on this host.

**Remote SSH shells** — host/IP, port, SSH username, then either:
- **Password** — encrypted at rest with AES-256-GCM.
- **Private key** — paste an OpenSSH-format key + optional passphrase. Both
  encrypted at rest.

**Supervision toggles** on the same form:
- **Autostart** — start the shell when the panel boots.
- **Auto-restart** — respawn on unexpected exit, up to 5 attempts with
  exponential backoff (2s → 4s → 8s → ... capped at 60s). The counter resets
  after 20s of stable running.
- **Record sessions** — capture terminal output to `data/recordings/*.cast`.
  Input is deliberately *not* recorded (so sudo passwords etc. never persist).

**Allowed users** — check any non-admin users who should see this shell in
their sidebar. Admins always have access to everything.

## SFTP file browser

For any SSH-typed shell, click the **Files** button in the header. Browse the
remote filesystem, upload files (streaming, no memory bloat), download, create
folders, delete entries. Uses the same stored SSH credentials.

## Session recordings

Admin panel → **Shells** → the ⏺ icon on a shell opens its recordings list.
Click a recording to play it back with asciinema-player (autoplay, monokai
theme). Delete unwanted recordings with the 🗑 icon.

## Host-key management

The first successful SSH connection to any host pins its public key (SHA256
fingerprint) into `data/known_hosts.json`. Every subsequent connection
verifies against that pin — mismatches are rejected without prompting (matches
OpenSSH's `StrictHostKeyChecking=yes` behavior after TOFU).

Admin panel → **Known SSH hosts** tab lists all pinned entries. Delete an
entry only if you know the target was legitimately re-keyed; the next connect
will pin whatever key is presented.

## Persistent logs

Every service's raw output is appended to `data/logs/<id>.log`, rotating at
5MB up to 3 files. Click **Logs** in the header to view the tail (last 128KB)
of the active tab's shell.

## Environment variables

| Name             | Default          | Purpose                                            |
| ---------------- | ---------------- | -------------------------------------------------- |
| `PORT`           | `3030`           | HTTP port                                          |
| `HOST`           | `0.0.0.0`        | Bind address                                       |
| `SESSION_SECRET` | *(generated)*    | Signs cookies + AES key for SSH creds              |
| `MAX_SCROLLBACK` | `200000`         | Bytes of in-memory scrollback per service          |
| `DEFAULT_SHELL`  | `$SHELL`         | Fallback for local services w/o `command`          |
| `LOGS_DIR`       | `data/logs`      | Persistent log directory                           |
| `RECORDINGS_DIR` | `data/recordings`| Session recording directory                        |
| `KNOWN_HOSTS_FILE` | `data/known_hosts.json` | SSH host-key store                        |
| `MAX_LOG_BYTES`  | `5242880`        | Rotation threshold per log file                    |
| `MAX_LOG_FILES`  | `3`              | How many rotated files to keep                     |

**Set `SESSION_SECRET`** to a long random string in any real deployment
(`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
If unset, an ephemeral one is generated at boot and *all stored SSH secrets
become undecryptable on restart*.

## Endpoints

All require an authenticated session unless noted.

| Method | Path                                         | Access | Description                     |
| ------ | -------------------------------------------- | ------ | ------------------------------- |
| POST   | `/api/auth/login`                            | public | Body `{username, password}`     |
| POST   | `/api/auth/logout`                           | any    | End session                     |
| GET    | `/api/auth/me`                               | any    | Current user                    |
| POST   | `/api/auth/change-password`                  | any    | Rotate own password             |
| GET    | `/api/services`                              | any    | Services visible to the user    |
| POST   | `/api/services/:id/start`                    | any\*  | Start                           |
| POST   | `/api/services/:id/stop`                     | any\*  | Stop (SIGTERM)                  |
| POST   | `/api/services/:id/restart`                  | any\*  | Stop then start                 |
| GET    | `/api/services/:id/logs?bytes=N`             | any\*  | Tail persistent log             |
| GET    | `/api/services/:id/sftp/list?path=...`       | any\*  | SFTP directory listing          |
| GET    | `/api/services/:id/sftp/download?path=...`   | any\*  | Streaming download              |
| POST   | `/api/services/:id/sftp/upload?path=...`     | any\*  | Multipart streaming upload      |
| POST   | `/api/services/:id/sftp/mkdir`               | any\*  | Body `{path}`                   |
| POST   | `/api/services/:id/sftp/delete`              | any\*  | Body `{path, isDir}`            |
| GET/POST/PATCH/DELETE | `/api/admin/services*`          | admin  | Manage shell definitions        |
| GET/POST/DELETE | `/api/admin/users*`                 | admin  | Manage users                    |
| GET    | `/api/admin/services/:id/recordings`         | admin  | List cast files                 |
| GET    | `/api/admin/recordings/:name`                | admin  | Stream cast file                |
| DELETE | `/api/admin/recordings/:name`                | admin  | Delete recording                |
| GET    | `/api/admin/known-hosts`                     | admin  | List pinned SSH host keys       |
| DELETE | `/api/admin/known-hosts?host=&port=`         | admin  | Forget a pinned key             |

\* also subject to per-shell ACL.

## Security notes

- Passwords: bcrypt (10 rounds).
- Cookies: HTTP-only, `sameSite: lax`. Set `secure: true` in `auth.js` if
  running behind HTTPS.
- SSH creds (password, private key, passphrase): AES-256-GCM at rest, key
  derived from `SESSION_SECRET`. Rotating `SESSION_SECRET` invalidates all
  stored SSH secrets — re-enter them via the admin panel.
- SSH host keys: TOFU + pin. First-connect trust is *your* trust boundary —
  do the initial connect from a trusted network.
- Session recordings capture output only, never keystrokes, so text typed
  at non-echoing prompts (sudo passwords, etc.) is never persisted.
