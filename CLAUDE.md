# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run start       # Boot the panel on $PORT (default 3030)
npm run dev         # Same, with node --watch for auto-reload on server changes
```

No test suite or lint config exists yet — verify changes by running the server and hitting endpoints directly.

**node-pty native build (macOS/Linux)** — on Node versions without a matching prebuild (e.g. very new Node like v26), `npm install`'s prebuild script silently no-ops and leaves the release folder empty, causing `posix_spawnp failed` at spawn time. Fix with:

```bash
cd node_modules/node-pty && npx --yes node-gyp rebuild
```

Requires the platform toolchain (Xcode CLT on macOS; `build-essential`+`python3` on Debian/Ubuntu). Node 20/22 LTS avoids this entirely.

## Architecture

Single-process Node.js daemon (`server/index.js`) that serves an unbundled vanilla-JS SPA from `public/` and exposes both a REST API and Socket.IO. No build step.

### Central abstraction: TaskManager + Session polymorphism

`server/TaskManager.js` is the hub. It owns a `Map<serviceId, entry>` where every entry has one of three `Session` implementations:

- `LocalSession` (`server/sessions/LocalSession.js`) — wraps `node-pty`
- `SshSession` (`server/sessions/SshSession.js`) — wraps `ssh2` client + shell channel
- `DockerSession` (`server/sessions/DockerSession.js`) — wraps `dockerode` exec attached to a running container (`containerId`, optional `command`/`user`/`workingDir`/`dockerHost`)

All three expose `start()`, `write()`, `resize()`, `kill()`, and emit `data`/`exit`. The manager fans events out via `EventEmitter`, and `server/index.js` bridges those to Socket.IO rooms (`service:${id}`). Any new session type (WebSocket-backed shell, k8s exec, etc.) should implement that same interface.

`dockerode` is a soft dependency — it's `require()`d lazily on first Docker session start. If it isn't installed, the DockerSession throws a friendly error but the panel still runs for local/ssh services.

### Access control

Every mutating REST route and every socket event that touches a service checks `manager.userCanAccess(user, id)`. Non-admins only see services whose `allowedUsers` array contains their username (or `"*"`); admins always have access. `broadcastServiceList()` iterates connected sockets and filters per-socket rather than blasting to everyone. Do **not** add a new service-scoped endpoint or socket event without going through this check.

### Encryption at rest

`SESSION_SECRET` (from env, or ephemeral if unset) is used both to sign Express session cookies and — via `server/crypto.js` (AES-256-GCM, key = SHA-256 of the secret) — to encrypt every SSH credential (`sshPasswordEncrypted`, `sshPrivateKeyEncrypted`, `sshPassphraseEncrypted`) written to `services.json`. Decryption is centralized: `TaskManager` receives a `decryptSecret` callback at construction time and calls it inside `buildSshConfig(id)`. **Rotating `SESSION_SECRET` invalidates all stored SSH creds** — they must be re-entered via the admin panel.

### Never leak service internals to clients

`TaskManager._publicDefinition(def)` strips every `sshPassword*`, `sshPrivateKey*`, `sshPassphrase*` field before returning a service, and adds boolean `hasSshPassword`/`hasSshPrivateKey` for the UI. Every path that returns a service to the wire (REST list/get, socket `services` and `service-status` events) goes through this. If you add another secret field, update this method.

### Persistent state files

Auto-created at runtime; not in version control expectations:

- `users.json` — bcrypt-hashed users, chmod 0600. On first boot, `UserStore._load()` creates default admin `admin`/`adminpass`.
- `services.json` — full service definitions including encrypted SSH ciphertext and macros. Also chmod 0600. Written by `saveServicesToDisk()` in `server/index.js`, which explicitly `chmodSync` after write because `fs.writeFileSync({mode})` only applies on file creation.
- `data/known_hosts.json` — SSH host-key TOFU store (`server/knownHosts.js`). First successful connect pins the SHA-256 fingerprint; later mismatches are rejected without prompting.
- `data/logs/<id>.log[.1..3]` — per-service rotating output logs (5MB × 3 files, `server/logger.js`).
- `data/recordings/<id>__<ts>.cast` — asciinema v2 casts (`server/recorder.js`). Records *output only* (not input) so passwords typed at non-echoing prompts are never persisted.

### Data flow: keystroke → shell → screen

1. Browser xterm `onData` → socket `service-input` → `TaskManager.writeToService(id, data)` → `session.write(data)` → the PTY/SSH stream.
2. PTY output → `session.emit('data')` → in `TaskManager.startService()`'s listener: append to in-memory scrollback, append to persistent log, append to session recording if enabled, then emit `manager.data` → `io.to('service:'+id).emit('service-output')` → browser writes to xterm.

Late-joining clients get the full in-memory scrollback (default 200KB) replayed on `subscribe-service`.

### Auto-restart supervision

`TaskManager.startService()` records `entry.lastStartedAt`; on exit, if the service ran ≥ `RESTART_STABLE_MS` (20s), `entry.restartAttempts` resets to 0. Otherwise `_maybeAutoRestart()` schedules a restart with exponential backoff (`restartDelayMs * 2^(attempts-1)`, capped at 60s), up to `maxRestartAttempts` (default 5). **User-initiated stop sets `restartAttempts = maxRestartAttempts` to inhibit auto-restart**; if you add a new "stop" code path, do the same.

### Resource monitoring

`server/ResourceMonitor.js` runs two loops:

- **Global loop (2.5s):** `pidusage` for CPU/RSS of each running *local* service (drives the header sparkline), and `systeminformation` for host CPU/RAM/disk. Emits `host-metrics` (all authed sockets) and `service-metrics` (per-service room, LOCAL only).
- **Context loop (3s, on demand):** enabled per-service via `watchContext(id)` (refcounted — N viewers = 1 poller). Emits `service-context-metrics` to the service room.
  - `local` → `pidusage` of the pid + `os.totalmem()` for a % gauge.
  - `ssh` → runs `top -bn1 | head -5 ; /proc/meminfo ; df -PkT / ; /proc/uptime` over a per-context SSH connection (kept warm, auto-reconnect on close).
  - `docker` → `container.stats({ stream: false })` (delta math done here — matches `docker stats`).

Sockets call `watch-context` / `unwatch-context` when they activate/close a tab. Refcounts are released automatically on socket disconnect.

### Log alerts

`server/LogWatcher.js` scans every output chunk (fed from the `TaskManager.data` event) against per-service regex rules stored on the service definition as `alertRules: [{id, name, pattern, flags, severity, cooldownMs}]`. Line-buffered so a rule can't span two writes; ANSI SGR codes are stripped before matching. Rules with global (`g`) or sticky (`y`) flags are rewritten because those keep state on the shared `RegExp`. `cooldownMs` (default 5s) prevents alert storms from a runaway process.

Matches emit a `log-alert` event that `server/index.js` fans out to `service:${id}` — only viewers with access see it. The frontend badges the sidebar item and tab and pops a toast; clicking a tab clears its badge.

Alert rules are edited via `PUT /api/admin/services/:id/alerts` (or in the initial `POST /api/admin/services` body under `alertRules`).

### Frontend architecture

`public/app.js` is a single IIFE managing three states: login view, dashboard view, and the modal stack. **Multi-terminal tabs** live in `state.tabs[]`, one xterm instance per tab; only the active tab's `.term-host` gets the `.active` CSS class (all others are `visibility: hidden` but stay in the DOM so xterm's canvas keeps its dimensions). The terminal must always be in the layout with real pixel dimensions — xterm's renderer breaks if `open()` is called on a `display: none` container, which is why `.terminal-placeholder` is an overlay on top rather than a display toggle.

`public/index.html` is intentionally unbundled; xterm, xterm-addon-fit, asciinema-player, and socket.io are loaded from CDN. There's no framework.

The HTML `hidden` attribute is used to toggle visibility of view containers and modals; because CSS rules like `.modal { display: grid }` would override it, `[hidden] { display: none !important }` at the top of `styles.css` is load-bearing — don't remove it.

### SFTP

`server/sftp.js` opens a *fresh* SSH connection per operation (list/download/upload/mkdir/delete) rather than reusing the long-lived shell session — keeps memory bounded and lets the shell and SFTP work in parallel. Uploads stream through `busboy` directly into `sftp.createWriteStream`, no memory buffering.

### Workspaces (graphical container streaming)

`server/WorkspaceManager.js` is a parallel hierarchy to TaskManager for browser-streamed desktops (KasmVNC / noVNC). Templates persist in `workspaces.json`; instances are ephemeral containers via `server/sessions/WorkspaceSession.js`. Instances auto-stop after `DEFAULT_IDLE_TIMEOUT_MS` (30 min) with zero viewers — refcounted so a browser refresh doesn't kill the desktop.

`server/vncProxy.js` is a hand-rolled reverse proxy (no `http-proxy` dep) for the workspace's HTTP page and its WebSocket. It strips `X-Frame-Options` / `Content-Security-Policy` from responses so the noVNC page can render inside our `<iframe>`, and disables TLS verification because the backend is always 127.0.0.1 with a per-container self-signed cert.

**WebSocket upgrade dispatcher** (`installWorkspaceUpgradeDispatcher` in `server/index.js`) is load-bearing: it snapshots Socket.IO's `upgrade` listeners, replaces them with its own, and routes workspace-proxy upgrades before Socket.IO ever sees them. It runs `sessionMiddleware` against a *dummy* `ServerResponse` to populate `req.session` for auth, then detaches the socket before piping. If you add another WebSocket subsystem, extend this dispatcher — do not re-register a competing `upgrade` handler.

The `/api/workspaces/:id/stream` mount also has to sit **before** `express.json()` so upload bodies inside the noVNC UI reach the container unread; that ordering in `server/index.js` is deliberate.

### Ephemeral scratchpads

`server/scratchpadContainer.js` spins up throwaway Docker containers (default `ubuntu:latest`, override via `SCRATCHPAD_IMAGE`). Every scratchpad is registered as a *service* with `ephemeral: true`, wired to a `DockerSession` — but its definition is excluded from `services.json` via `manager.persistentDefinitions()`. Containers are labeled `com.shellhelper.scratchpad` so `reapOrphanedScratchpads()` can sweep survivors of a previous crash on boot.

Ephemerals self-destruct in two places: `TaskManager` emits `removed` when the inner shell exits, and `maybeReapEphemeral(id)` runs when the last viewer socket leaves the room. Both paths route through `destroyScratchpad()`, which is idempotent.

### Public tunnels (cloudflared)

`server/TunnelManager.js` shells out to `cloudflared tunnel --url http://localhost:<port>` and parses `https://…trycloudflare.com` from stderr/stdout line-by-line via `readline`. One tunnel per service (`Map<serviceId, {proc, url, port}>`). The `cloudflared` binary is discovered via `$PATH` or `CLOUDFLARED_BIN`; ENOENT surfaces a friendly install-me error rather than crashing.

Tunnels are torn down automatically on `manager.on('exit')` (which covers user-initiated stop, crashes, and restart's stop→start) and on admin delete. If you add another code path that stops a service without going through `manager.stopService`, call `tunnels.stop(id)` explicitly.

REST: `POST/GET /api/services/:id/tunnel/{start,stop,status}`. Socket: `tunnel-status` broadcast to the service room; also pushed to freshly-joined viewers inside `subscribe-service`.
