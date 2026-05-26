// Chrome launch + CDP connection helpers (shared by both engines)
const { spawn, execSync } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
];

function findChrome() {
  for (const p of CHROME_PATHS) if (fs.existsSync(p)) return p;
  return null;
}

let _screenSize = null;
function getScreenQuarter() {
  if (!_screenSize) {
    try {
      const out = execSync('powershell -command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds | Select Width,Height | ConvertTo-Json"', { encoding: 'utf-8', timeout: 5000 });
      const { Width, Height } = JSON.parse(out);
      _screenSize = { w: Math.floor(Width / 2), h: Math.floor(Height / 2) };
    } catch { _screenSize = { w: 960, h: 540 }; }
  }
  return _screenSize;
}

function launchChrome(port, tempDir, options = {}) {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('Chrome not found');
  const q = getScreenQuarter();
  const args = [
    `--remote-debugging-port=${port}`,
    '--incognito',
    `--user-data-dir=${tempDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-popup-blocking',
    `--window-size=${q.w},${q.h}`,
    '--window-position=0,0',
  ];
  // v2.42: options.proxyServer 显式优先，未传则默认 process.env.HTTPS_PROXY。
  // 这样业务代码无需再 require proxy manager + 调用 getProxyUrl()，
  // 由 server/proxy/global.js 设的 HTTPS_PROXY env 成为唯一来源。
  // 显式传 '' / null 仍可走直连（不加 --proxy-server）。
  const proxyServer = options.proxyServer ?? process.env.HTTPS_PROXY;
  if (proxyServer) {
    args.push(`--proxy-server=${proxyServer}`);
    args.push('--proxy-bypass-list=<-loopback>');  // route everything (incl. localhost upstreams) through proxy
  }
  args.push('about:blank');
  return spawn(chromePath, args, { stdio: 'ignore', detached: false });
}

async function waitForCDP(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`); }
    catch { await new Promise(r => setTimeout(r, 500)); }
  }
  throw new Error('CDP timeout');
}

// Scan 127.0.0.1:start..end for a port we can bind a TCP listener to.
// Critical for `--remote-debugging-port` because if the requested port is
// already taken (e.g. another chrome / DevTools client), chrome silently
// starts WITHOUT exposing CDP, then waitForCDP() connects to the OTHER
// chrome on that port and the whole automation runs in the wrong browser.
async function findFreePort(start = 9300, end = 9999) {
  for (let p = start; p <= end; p++) {
    const ok = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(p, '127.0.0.1');
    });
    if (ok) return p;
  }
  throw new Error(`No free port in ${start}-${end}`);
}

module.exports = { findChrome, launchChrome, waitForCDP, findFreePort };
