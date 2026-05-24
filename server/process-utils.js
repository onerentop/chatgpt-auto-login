/**
 * Process tree termination.
 *
 * `kill(pid)` only signals the immediate process; on Windows curl_cffi
 * spawns a native child that does not receive SIGTERM through .kill(),
 * leaving zombies that hold the user-data-dir open and gradually consume
 * disk. Same story for Chrome with renderer / GPU subprocesses.
 *
 * `killTree(pid)` uses the platform's group-kill primitive — `taskkill /T`
 * on Windows, negative-PID signal on POSIX — so the whole subtree dies.
 * Failures are swallowed (the worst case is the same as today: a stray
 * subprocess).
 */

const { spawnSync } = require('child_process');

function killTree(pid) {
  if (!pid) return;
  pid = Number(pid);
  if (!Number.isFinite(pid) || pid <= 0) return;

  if (process.platform === 'win32') {
    // /T = terminate the process and any child processes it started.
    // /F = force termination. stdio:'ignore' so a missing/already-dead PID
    // (taskkill exits 128) doesn't pollute the parent stderr.
    try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); }
    catch {}
    return;
  }

  // POSIX: send to the process group first (kill -SIGKILL -PID). Requires
  // the child to have been spawned with { detached: true } so it has its
  // own group; if not, this fails and we still try the single-process kill.
  try { process.kill(-pid, 'SIGKILL'); } catch {}
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

module.exports = { killTree };
