// Chrome launch + CDP connection helpers (shared by both engines)
const { spawn, execSync } = require('child_process');
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

function launchChrome(port, tempDir) {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('Chrome not found');
  const q = getScreenQuarter();
  return spawn(chromePath, [
    `--remote-debugging-port=${port}`,
    '--incognito',
    `--user-data-dir=${tempDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-popup-blocking',
    `--window-size=${q.w},${q.h}`,
    '--window-position=0,0',
    'about:blank',
  ], { stdio: 'ignore', detached: false });
}

async function waitForCDP(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`); }
    catch { await new Promise(r => setTimeout(r, 500)); }
  }
  throw new Error('CDP timeout');
}

module.exports = { findChrome, launchChrome, waitForCDP };
