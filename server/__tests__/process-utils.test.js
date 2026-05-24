const test = require('node:test');
const assert = require('node:assert');
const { killTree } = require('../process-utils');

test('killTree() 接受 null/undefined/0/NaN 不抛错', () => {
  // All of these are no-ops by contract.
  killTree(null);
  killTree(undefined);
  killTree(0);
  killTree(NaN);
  killTree('not-a-number');
  killTree(-1);
  // If any threw, the test would fail; we just assert reachability.
  assert.ok(true);
});

test('killTree() 对不存在 PID 静默失败（不抛错）', () => {
  // Use an obviously fake high PID (Windows PIDs are usually < 100000).
  killTree(999999999);
  assert.ok(true, 'no exception for non-existent PID');
});

test('killTree() 实际 kill 一个真子进程（验证非 no-op）', async () => {
  // Spawn a Node child that just sits idle (setInterval keeps event loop
  // alive). killTree() should terminate it; we verify via 'exit' event.
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore', windowsHide: true,
  });
  const pid = child.pid;
  assert.ok(pid, 'child has a PID');
  await new Promise((r) => setTimeout(r, 300));  // let it actually start
  killTree(pid);
  const exited = await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 5000);
    child.once('exit', () => { clearTimeout(timeout); resolve(true); });
  });
  // Belt-and-suspenders cleanup if the test fails.
  try { child.kill(); } catch {}
  assert.strictEqual(exited, true, 'child must exit within 5s of killTree');
});
