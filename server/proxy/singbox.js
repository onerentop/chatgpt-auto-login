// sing-box binary lifecycle: detect / download / launch / stop
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const https = require('https');
const { extract } = require('tar-fs');
const zlib = require('zlib');
const StreamZip = require('node-stream-zip');

const ROOT = path.join(__dirname, '..', '..');
const BIN_DIR = path.join(ROOT, 'bin');
const SINGBOX_VERSION = '1.13.12';

function getBinaryPath() {
  return process.platform === 'win32'
    ? path.join(BIN_DIR, 'sing-box.exe')
    : path.join(BIN_DIR, 'sing-box');
}

function getAssetName() {
  const platform = process.platform;
  const arch = process.arch === 'x64' ? 'amd64' : 'arm64';
  const v = SINGBOX_VERSION;
  if (platform === 'win32')  return { name: `sing-box-${v}-windows-${arch}.zip`,  isZip: true };
  if (platform === 'darwin') return { name: `sing-box-${v}-darwin-${arch}.tar.gz`, isZip: false };
  return { name: `sing-box-${v}-linux-${arch}.tar.gz`, isZip: false };
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        download(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const f = fs.createWriteStream(dest);
      res.pipe(f);
      f.on('finish', () => f.close(resolve));
      f.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function ensureBinary() {
  const binPath = getBinaryPath();
  if (fs.existsSync(binPath)) return binPath;

  fs.mkdirSync(BIN_DIR, { recursive: true });
  const asset = getAssetName();
  const url = `https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VERSION}/${asset.name}`;
  const archivePath = path.join(BIN_DIR, asset.name);
  console.log(`[sing-box] Downloading ${url} ...`);
  await download(url, archivePath);
  console.log(`[sing-box] Downloaded ${asset.name}, extracting...`);

  if (asset.isZip) {
    const zip = new StreamZip.async({ file: archivePath });
    const entries = await zip.entries();
    for (const e of Object.values(entries)) {
      if (e.name.endsWith('sing-box.exe')) {
        await zip.extract(e.name, binPath);
        break;
      }
    }
    await zip.close();
  } else {
    // tar.gz
    await new Promise((resolve, reject) => {
      fs.createReadStream(archivePath)
        .pipe(zlib.createGunzip())
        .pipe(extract(BIN_DIR, {
          map: (header) => {
            if (header.name.endsWith('sing-box')) header.name = 'sing-box';
            return header;
          },
        }))
        .on('finish', resolve)
        .on('error', reject);
    });
    fs.chmodSync(binPath, 0o755);
  }
  try { fs.unlinkSync(archivePath); } catch {}
  console.log(`[sing-box] Ready at ${binPath}`);
  return binPath;
}

let _proc = null;
let _configPath = null;

async function start(configJson) {
  if (_proc) await stop();
  const binPath = await ensureBinary();
  _configPath = path.join(BIN_DIR, 'config.json');
  fs.writeFileSync(_configPath, JSON.stringify(configJson, null, 2));
  console.log(`[sing-box] Starting with config ${_configPath}`);
  _proc = spawn(binPath, ['run', '-c', _configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  _proc.stdout.on('data', (d) => process.stdout.write(`[sing-box] ${d}`));
  _proc.stderr.on('data', (d) => process.stderr.write(`[sing-box err] ${d}`));
  let exitCode = null;
  _proc.on('exit', (code) => { exitCode = code; console.log(`[sing-box] exited ${code}`); _proc = null; });

  // Give sing-box a moment to bind ports
  await new Promise(r => setTimeout(r, 1500));

  // If the process died during startup, surface the failure
  if (!_proc) {
    throw new Error(`sing-box exited unexpectedly (code: ${exitCode}); check if a port (e.g. 7890/7891) is already in use, or see sing-box log for "address already in use"`);
  }

  // Probe every mixed/http/socks inbound port to confirm it is actually listening
  const ports = (configJson.inbounds || [])
    .filter((ib) => ib && (ib.type === 'mixed' || ib.type === 'http' || ib.type === 'socks'))
    .map((ib) => ib.listen_port)
    .filter(Boolean);

  const net = require('net');
  for (const port of ports) {
    const ok = await new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1');
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        try { sock.destroy(); } catch {}
        resolve(result);
      };
      sock.once('connect', () => finish(true));
      sock.once('error', () => finish(false));
      setTimeout(() => finish(false), 1000);
    });
    if (!ok) {
      try { _proc?.kill(); } catch {}
      _proc = null;
      throw new Error(`sing-box failed to bind port ${port}: address already in use`);
    }
  }

  return _proc;
}

async function stop() {
  if (!_proc) return;
  return new Promise((resolve) => {
    const p = _proc;
    _proc = null;
    p.once('exit', () => resolve());
    try { p.kill(); } catch { resolve(); }
    setTimeout(resolve, 3000);
  });
}

function isRunning() { return !!_proc; }

module.exports = { ensureBinary, start, stop, isRunning, getBinaryPath };
