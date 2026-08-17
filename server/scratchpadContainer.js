'use strict';

// Lifecycle helpers for ephemeral scratchpad containers.
//
// Each scratchpad owns exactly one throwaway container. Files created inside
// it live only on the container's writable layer, which is removed with the
// container itself — so nothing the user does can touch the host filesystem.

const SCRATCHPAD_IMAGE = process.env.SCRATCHPAD_IMAGE || 'ubuntu:latest';
const LABEL_KEY = 'com.shellhelper.scratchpad';

let Docker = null;
function loadDockerode() {
  if (Docker) return Docker;
  try {
    Docker = require('dockerode');
  } catch {
    throw new Error(
      'dockerode is not installed. Run `npm install dockerode` to enable scratchpads.',
    );
  }
  return Docker;
}

function newDocker() {
  const D = loadDockerode();
  return new D();
}

// Best-effort: `docker pull` if the image isn't already local. Silent success
// path; surfaces a helpful error if the pull fails (usually: daemon not
// running, offline, or image typo).
async function ensureImage(docker, image) {
  try {
    await docker.getImage(image).inspect();
    return;
  } catch {
    /* not present locally — fall through to pull */
  }
  await new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(
        stream,
        (finishErr) => (finishErr ? reject(finishErr) : resolve()),
      );
    });
  });
}

/**
 * Spin up a fresh, isolated container for a scratchpad and return its id.
 *
 * @param {object} opts
 * @param {string} opts.scratchpadId  service id the container is bound to (label)
 * @param {boolean} opts.network      false → --network=none (no internet)
 * @returns {Promise<{docker: import('dockerode'), containerId: string, image: string}>}
 */
async function createScratchpadContainer({ scratchpadId, network }) {
  const docker = newDocker();
  // Fail fast with a friendly message if the daemon isn't reachable.
  try {
    await docker.ping();
  } catch (err) {
    throw new Error(
      `Docker daemon is not reachable (${err.message || err}). ` +
        'Start Docker Desktop / dockerd and try again.',
    );
  }
  await ensureImage(docker, SCRATCHPAD_IMAGE);

  const createOpts = {
    Image: SCRATCHPAD_IMAGE,
    // Sleep forever so `docker exec` can attach an interactive shell. The
    // scratchpad's real "shell" is the exec, not this pid 1.
    Cmd: ['sleep', 'infinity'],
    Tty: false,
    OpenStdin: false,
    Labels: { [LABEL_KEY]: scratchpadId },
    HostConfig: {
      // AutoRemove makes the container vanish the instant it stops, so even
      // an unclean server crash won't leave zombies lying around.
      AutoRemove: true,
      NetworkMode: network ? 'bridge' : 'none',
    },
  };

  const container = await docker.createContainer(createOpts);
  await container.start();
  return { docker, containerId: container.id, image: SCRATCHPAD_IMAGE };
}

/**
 * Force-remove a scratchpad container. Safe to call multiple times or on an
 * already-gone container — Docker "no such container" errors are swallowed.
 */
async function destroyScratchpadContainer(docker, containerId) {
  if (!docker || !containerId) return;
  try {
    const container = docker.getContainer(containerId);
    // stop with a 0s grace so the exec dies immediately; AutoRemove takes it
    // from there. Fallback to explicit remove if stop errored (already gone).
    try {
      await container.stop({ t: 0 });
    } catch (err) {
      if (!isNotFound(err)) {
        try {
          await container.remove({ force: true });
        } catch (err2) {
          if (!isNotFound(err2)) throw err2;
        }
      }
    }
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
}

function isNotFound(err) {
  if (!err) return false;
  const code = err.statusCode || (err.reason && err.reason.statusCode);
  return code === 404;
}

// On boot, reap any leftover scratchpad containers from a previous run (e.g.
// server crashed before it could clean up). Matched by our label.
async function reapOrphanedScratchpads() {
  let docker;
  try {
    docker = newDocker();
    await docker.ping();
  } catch {
    return; // no docker → nothing to reap
  }
  let containers;
  try {
    containers = await docker.listContainers({
      all: true,
      filters: { label: [LABEL_KEY] },
    });
  } catch {
    return;
  }
  await Promise.all(
    containers.map((info) =>
      destroyScratchpadContainer(docker, info.Id).catch(() => {}),
    ),
  );
}

module.exports = {
  SCRATCHPAD_IMAGE,
  createScratchpadContainer,
  destroyScratchpadContainer,
  reapOrphanedScratchpads,
};
