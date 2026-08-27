'use strict';

// Port occupancy check + best-effort process termination. Backed by `lsof`
// (present on macOS + most Linux distros); returns "unknown" rather than
// throwing on platforms where lsof isn't available, so the caller can degrade
// gracefully instead of surfacing a scary error.

const { execFile } = require('child_process');

const LSOF_TIMEOUT_MS = 3_000;

function runLsof(args) {
  return new Promise((resolve, reject) => {
    execFile(
      'lsof',
      args,
      { timeout: LSOF_TIMEOUT_MS, maxBuffer: 512 * 1024 },
      (err, stdout, stderr) => {
        // `lsof -i :port` exits 1 with no output when nothing is listening —
        // that's the happy "port is free" path, not an error.
        if (err && !stdout && !stderr) {
          if (err.code === 'ENOENT') {
            return reject(new Error('lsof not installed'));
          }
          if (err.code === 1) return resolve('');
        }
        resolve(stdout || '');
      },
    );
  });
}

/**
 * Check whether TCP `port` is bound by any process. Returns:
 *   { inUse: false, port }
 *   { inUse: true, port, pid, command, user }
 *   { inUse: null, port, error }  ← platform can't answer (e.g. no lsof)
 */
async function checkPort(port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new Error('port must be an integer between 1 and 65535');
  }
  let stdout;
  try {
    // -nP disables DNS / port-name lookup (much faster). -sTCP:LISTEN filters
    // to only sockets actually listening — connected outbound sockets on the
    // same port number don't count as a conflict for a would-be binder.
    stdout = await runLsof(['-nP', '-iTCP:' + p, '-sTCP:LISTEN']);
  } catch (err) {
    return { inUse: null, port: p, error: err.message };
  }
  const lines = stdout.split('\n').filter((l) => l.trim() && !/^COMMAND\s/.test(l));
  if (lines.length === 0) return { inUse: false, port: p };
  // lsof default columns: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
  const cols = lines[0].split(/\s+/);
  const [command, pidStr, user] = cols;
  const pid = Number(pidStr);
  return {
    inUse: true,
    port: p,
    pid: Number.isFinite(pid) ? pid : null,
    command: command || null,
    user: user || null,
  };
}

/**
 * Send `signal` (default SIGTERM, then SIGKILL after 500ms if still alive) to
 * `pid`. Rejects if the pid can't be signalled (already dead, EPERM, etc.).
 */
function killPid(pid, { signal = 'SIGTERM', force = true } = {}) {
  return new Promise((resolve, reject) => {
    const p = Number(pid);
    if (!Number.isInteger(p) || p <= 1) {
      return reject(new Error('refusing to signal pid ' + pid));
    }
    try {
      process.kill(p, signal);
    } catch (err) {
      return reject(new Error(`could not signal pid ${p}: ${err.message}`));
    }
    if (!force) return resolve({ pid: p, signal });
    // Give the process 500ms to exit gracefully before escalating.
    setTimeout(() => {
      try {
        process.kill(p, 0); // liveness probe
        try {
          process.kill(p, 'SIGKILL');
          resolve({ pid: p, signal: 'SIGKILL', escalated: true });
        } catch (err2) {
          if (err2.code === 'ESRCH') resolve({ pid: p, signal });
          else reject(err2);
        }
      } catch {
        // ESRCH — already gone. Good.
        resolve({ pid: p, signal });
      }
    }, 500);
  });
}

module.exports = { checkPort, killPid };
