// protocol-engine.js — Protocol register mode execution engine
// Same EventEmitter interface as server/engine.js but uses Python curl_cffi for login/register

const { EventEmitter } = require('events');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const { chromium } = require('playwright');

const { autoPayment, CONFIG: PAY_CONFIG } = require('./payment');
const { randomDelay } = require('./utils');

const ROOT = __dirname;
const PYTHON_SCRIPT = path.join(ROOT, 'protocol_register.py');

// ========== Discord config (copied from engine.js — cannot modify original) ==========
const DISCORD_TOKEN = PAY_CONFIG.discordToken || '';
const CHANNEL_ID = PAY_CONFIG.discordChannelId || '';
const HUB_MESSAGE_ID = PAY_CONFIG.discordMessageId || '';
const GUILD_ID = PAY_CONFIG.discordGuildId || '';
const APP_ID = PAY_CONFIG.discordAppId || '';
const API_BASE = 'https://discord.com/api/v9';

const superProps = Buffer.from(JSON.stringify({
  os: 'Windows', browser: 'Chrome', device: '',
  browser_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  browser_version: '131.0.0.0', os_version: '10',
  release_channel: 'stable', client_build_number: 335978,
})).toString('base64');

const discordHeaders = {
  'Authorization': DISCORD_TOKEN, 'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'X-Super-Properties': superProps,
};

function nn() { return String(BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))); }

// Discord Gateway (same as engine.js)
function connectGateway() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json');
    let hb = null, seq = null, sessionId = null;
    const eh = {};
    function on(e, f) { if (!eh[e]) eh[e] = []; eh[e].push(f); }
    function off(e, f) { const a = eh[e] || []; const i = a.indexOf(f); if (i !== -1) a.splice(i, 1); }
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.s) seq = m.s;
      if (m.op === 10) {
        hb = setInterval(() => ws.send(JSON.stringify({ op: 1, d: seq })), m.d.heartbeat_interval);
        ws.send(JSON.stringify({ op: 2, d: { token: DISCORD_TOKEN, properties: { os: 'Windows', browser: 'Chrome', device: '' }, presence: { status: 'online', afk: false } } }));
      }
      if (m.op === 0 && m.t === 'READY') { sessionId = m.d.session_id; resolve({ ws, sessionId, on, off, cleanup: () => { clearInterval(hb); ws.close(); } }); }
      if (m.op === 0 && m.t) { for (const f of (eh[m.t] || [])) f(m.d); }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('Gateway timeout')), 30000);
  });
}

function waitFor(gw, event, filter, ms = 30000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { gw.off(event, h); reject(new Error(`Timeout: ${event}`)); }, ms);
    function h(d) { if (filter(d)) { clearTimeout(t); gw.off(event, h); resolve(d); } }
    gw.on(event, h);
  });
}

function waitForAny(gw, events, filter, ms = 30000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); reject(new Error('Timeout')); }, ms);
    const hs = {};
    function cleanup() { clearTimeout(t); for (const e of events) gw.off(e, hs[e]); }
    for (const e of events) { hs[e] = (d) => { if (filter(d)) { cleanup(); resolve(d); } }; gw.on(e, hs[e]); }
  });
}

async function interact(body) {
  const r = await fetch(`${API_BASE}/interactions`, { method: 'POST', headers: discordHeaders, body: JSON.stringify(body) });
  if (r.status !== 204 && r.status !== 200) throw new Error(`Interaction ${r.status}: ${await r.text()}`);
}

async function getPaymentLink(gw, accessToken) {
  const menuP = waitFor(gw, 'MESSAGE_CREATE', (d) => d.author?.bot && d.components?.length > 0, 15000);
  await interact({ type: 3, nonce: nn(), guild_id: GUILD_ID, channel_id: CHANNEL_ID, message_flags: 0, message_id: HUB_MESSAGE_ID, application_id: APP_ID, session_id: gw.sessionId, data: { component_type: 2, custom_id: 'hub:chatgpt' } });
  const menu = await menuP;
  let btnId = null;
  for (const r of (menu.components || [])) { for (const c of (r.components || [])) { if (c.label?.includes('美区') && c.label?.includes('PLUS') && c.label?.includes('免费试用')) btnId = c.custom_id; } }
  if (!btnId) throw new Error('US Plus button not found');
  const modalP = waitFor(gw, 'INTERACTION_MODAL_CREATE', () => true, 15000);
  await new Promise(r => setTimeout(r, 1500));
  await interact({ type: 3, nonce: nn(), guild_id: GUILD_ID, channel_id: CHANNEL_ID, message_flags: 64, message_id: menu.id, application_id: APP_ID, session_id: gw.sessionId, data: { component_type: 2, custom_id: btnId } });
  const modal = await modalP;
  const fieldId = modal.data?.components?.[0]?.components?.[0]?.custom_id;
  if (!fieldId) throw new Error('Modal field not found');
  await new Promise(r => setTimeout(r, 1000));
  await interact({ type: 5, nonce: nn(), application_id: APP_ID, channel_id: CHANNEL_ID, guild_id: GUILD_ID, session_id: gw.sessionId, data: { id: modal.data.id, custom_id: modal.data.custom_id, components: [{ type: 1, components: [{ type: 4, custom_id: fieldId, value: accessToken }] }] } });
  const result = await waitForAny(gw, ['MESSAGE_UPDATE', 'MESSAGE_CREATE'], (d) => { const txt = JSON.stringify(d); return txt.includes('pay.openai.com') || txt.includes('已经是') || txt.includes('already'); }, 30000);
  const raw = JSON.stringify(result);
  const linkMatch = raw.match(/https:\/\/pay\.openai\.com[^\s"')]+/);
  const titleMatch = raw.match(/✅[^"'\n]+/);
  return { link: linkMatch?.[0] || '', title: titleMatch?.[0] || '', raw: raw.slice(0, 300) };
}

// ========== Chrome helpers ==========
const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
];
function findChrome() { for (const p of CHROME_PATHS) if (fs.existsSync(p)) return p; return null; }

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
  return spawn(chromePath, [`--remote-debugging-port=${port}`, '--incognito', `--user-data-dir=${tempDir}`, '--no-first-run', '--no-default-browser-check', '--disable-default-apps', '--disable-popup-blocking', `--window-size=${q.w},${q.h}`, '--window-position=0,0', 'about:blank'], { stdio: 'ignore', detached: false });
}

async function waitForCDP(port) {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await new Promise(r => setTimeout(r, 500)); }
  }
  throw new Error('CDP timeout');
}

// ========== CPA JSON (no refresh_token) ==========
function saveCPAJson(email, accessToken, session) {
  const authDir = path.join(ROOT, 'cpa-auth');
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
  const sanitized = email.replace(/@/g, '-at-').replace(/\./g, '-');
  const filePath = path.join(authDir, `codex-${sanitized}.json`);
  let accountId = '';
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64').toString());
    accountId = payload['https://api.openai.com/auth']?.chatgpt_account_id || '';
  } catch {}
  const now = new Date();
  const expired = new Date(now.getTime() + 10 * 24 * 3600000);
  const data = {
    access_token: accessToken, account_id: accountId, email,
    expired: expired.toISOString().replace('Z', '+08:00'),
    id_token: '', last_refresh: now.toISOString().replace('Z', '+08:00'),
    refresh_token: '', type: 'codex',
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`  [CPA-Auth] Saved: ${filePath}`);
  return filePath;
}

// ========== Python subprocess ==========
function runProtocolRegister(account) {
  return new Promise((resolve, reject) => {
    const py = spawn('py', ['-3', PYTHON_SCRIPT], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    const input = JSON.stringify({ email: account.email, password: account.password, client_id: account.client_id || '', refresh_token: account.refresh_token || '' });
    let stdout = '', stderr = '';
    py.stdout.on('data', (data) => {
      for (const line of data.toString().split('\n').filter(l => l.trim())) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.log) { console.log(parsed.log); } else { stdout = line; }
        } catch { stdout = line; }
      }
    });
    py.stderr.on('data', (data) => { stderr += data.toString(); });
    py.on('close', (code) => {
      try {
        const result = JSON.parse(stdout);
        if (result.status === 'success') resolve(result);
        else reject(new Error(result.error || 'Protocol register failed'));
      } catch { reject(new Error(stderr.slice(-200) || `Python exit ${code}`)); }
    });
    py.stdin.write(input);
    py.stdin.end();
  });
}

// ========== Protocol Engine ==========
class ProtocolEngine extends EventEmitter {
  constructor() {
    super();
    this.status = 'idle';
    this.stopFlag = false;
    this._gw = null;
    this._chromeProc = null;
    this._browser = null;
    this._tempDir = null;
  }

  getStatus() { return this.status; }

  emitStatus(data) {
    this.emit('account-status', data);
    try {
      const { statusDB } = require('./server/db');
      statusDB.set(data.email, data);
    } catch {}
  }

  stop() {
    if (this.status !== 'idle') {
      this.stopFlag = true;
      if (this._chromeProc) try { this._chromeProc.kill(); } catch {}
      if (this._browser) try { this._browser.close(); } catch {}
      if (this._gw) try { this._gw.cleanup(); } catch {}
      if (this._tempDir) try { fs.rmSync(this._tempDir, { recursive: true, force: true }); } catch {}
      this._chromeProc = null; this._browser = null; this._gw = null; this._tempDir = null;
      this.status = 'idle';
      this.emit('log', { email: '', phase: '', message: 'Protocol engine force stopped.', timestamp: new Date().toISOString() });
    }
  }

  async start(startFrom = 0, filterEmails = null) {
    this.status = 'running';
    this.stopFlag = false;

    // LogCapture: hijack console.log to emit 'log' events (same as PipelineEngine)
    const { LogCapture } = require('./server/logger');
    this._logCapture = new LogCapture();
    let currentEmail = '';
    const logHandler = (message) => {
      const ts = new Date().toISOString();
      this.emit('log', { email: currentEmail, phase: '', message, timestamp: ts });
      if (currentEmail) {
        try { const { logsDB } = require('./server/db'); logsDB.add(currentEmail, '', message, ts); } catch {}
      }
    };
    this._logCapture.onLog(logHandler);
    this._logCapture.start();

    const { accountsDB } = require('./server/db');
    let accounts = accountsDB.list().map(a => ({
      email: a.email, password: a.password, loginType: a.login_type,
      client_id: a.client_id || '', refresh_token: a.refresh_token || '',
    }));

    if (filterEmails?.length > 0) {
      const set = new Set(filterEmails.map(e => e.toLowerCase()));
      accounts = accounts.filter(a => set.has(a.email.toLowerCase()));
    }
    if (accounts.length === 0) throw new Error('No accounts');

    const summary = { total: accounts.length, success: 0, alreadyPlus: 0, noLink: 0, error: 0 };

    try {
      // === Phase 1: Parallel protocol login/register (with concurrency limit) ===
      let concurrency = 3;
      try { concurrency = Math.min(Math.max(JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8')).protocolConcurrency || 3, 1), 10); } catch {}
      console.log(`[Proto-Engine] Starting ${accounts.length} accounts (concurrency: ${concurrency})...`);

      const loginResults = [];
      for (let batch = 0; batch < accounts.length; batch += concurrency) {
        if (this.stopFlag) break;
        const chunk = accounts.slice(batch, batch + concurrency);
        const batchResults = await Promise.allSettled(chunk.map(async (account, j) => {
          const i = batch + j;
          if (this.stopFlag) throw new Error('Stopped');
          const progress = `${i + 1}/${accounts.length}`;
          this.emitStatus({ email: account.email, status: 'running', phase: 'protocol-login', progress });
          currentEmail = account.email;
          console.log(`[${progress}] === ${account.email} (protocol) ===`);
          const result = await runProtocolRegister(account);
          console.log(`[${progress}] Protocol login OK: ${result.accessToken?.slice(0, 20)}...`);
          return { account, result };
        }));
        loginResults.push(...batchResults);
      }

      // Collect successful logins
      const successfulLogins = [];
      for (const r of loginResults) {
        if (r.status === 'fulfilled') {
          const { account, result } = r.value;
          const isPlusOrAbove = ['plus', 'pro', 'team', 'enterprise'].includes((result.planType || 'free').toLowerCase());
          if (isPlusOrAbove) {
            console.log(`[Proto-Engine] ${account.email} already Plus, generating CPA JSON...`);
            saveCPAJson(account.email, result.accessToken, result.session);
            this.emitStatus({ email: account.email, status: 'already_plus', phase: 'done', progress: '' });
            summary.alreadyPlus++;
          } else {
            successfulLogins.push({ account, result });
          }
        } else {
          const email = accounts[loginResults.indexOf(r)]?.email || 'unknown';
          console.log(`[Proto-Engine] ${email} failed: ${r.reason?.message?.slice(0, 80)}`);
          this.emitStatus({ email, status: 'error', phase: 'protocol-login', reason: r.reason?.message });
          summary.error++;
        }
      }

      if (successfulLogins.length === 0 || this.stopFlag) {
        this.emit('complete', { summary });
        this.status = 'idle';
        return;
      }

      // === Phase 2: Serial Discord + Payment ===
      console.log(`[Proto-Engine] ${successfulLogins.length} accounts need payment. Connecting Discord...`);
      this._gw = await connectGateway();
      console.log('[Proto-Engine] Discord connected!');

      const port = 9222;
      this._tempDir = path.join(os.tmpdir(), `proto-pay-${Date.now()}`);
      this._chromeProc = launchChrome(port, this._tempDir);
      this._browser = await waitForCDP(port);

      for (let i = 0; i < successfulLogins.length; i++) {
        if (this.stopFlag) break;
        const { account, result } = successfulLogins[i];
        const progress = `${i + 1}/${successfulLogins.length}`;

        try {
          // Discord
          currentEmail = account.email;
          this.emitStatus({ email: account.email, status: 'running', phase: 'discord', progress });
          console.log(`[${progress}] Discord: ${account.email}...`);
          // Always use Discord bot to get $0 Plus trial link
          const discord = await getPaymentLink(this._gw, result.accessToken);
          const link = discord.link;
          if (link) console.log(`[${progress}] ${discord.title || 'Link obtained'}`);
          console.log(`[${progress}] Link: ${link?.slice(0, 60) || 'none'}`);

          if (!link) {
            console.log(`[${progress}] No payment link`);
            this.emitStatus({ email: account.email, status: 'no_link', phase: 'done', progress });
            summary.noLink++;
            continue;
          }

          // Payment
          this.emitStatus({ email: account.email, status: 'running', phase: 'payment', progress });
          console.log(`[${progress}] Opening payment: ${link.slice(0, 60)}...`);
          const ctx = this._browser.contexts()[0];
          const page = ctx.pages()[0] || await ctx.newPage();
          await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          await randomDelay(2000, 3000);

          let paymentOk = true;
          try { await autoPayment(page); } catch (e) { console.log(`[${progress}] Payment error: ${e.message?.slice(0, 60)}`); paymentOk = false; }

          // Generate CPA JSON (no refresh_token)
          saveCPAJson(account.email, result.accessToken, result.session);

          if (paymentOk) {
            this.emitStatus({ email: account.email, status: 'success', phase: 'done', progress });
            summary.success++;
          } else {
            this.emitStatus({ email: account.email, status: 'error', phase: 'payment', progress, reason: 'Payment failed' });
            summary.error++;
          }
        } catch (e) {
          console.log(`[${progress}] ${account.email} error: ${e.message?.slice(0, 80)}`);
          this.emitStatus({ email: account.email, status: 'error', phase: 'payment', progress, reason: e.message });
          summary.error++;
        }

        if (i < successfulLogins.length - 1) await randomDelay(3000, 5000);
      }

    } catch (e) {
      console.log(`[Proto-Engine] Fatal: ${e.message}`);
    } finally {
      if (this._browser) try { await this._browser.close(); } catch {}
      if (this._chromeProc) try { this._chromeProc.kill(); } catch {}
      if (this._gw) try { this._gw.cleanup(); } catch {}
      if (this._tempDir) try { fs.rmSync(this._tempDir, { recursive: true, force: true }); } catch {}
      this._browser = null; this._chromeProc = null; this._gw = null; this._tempDir = null;
      if (this._logCapture) { this._logCapture.stop(); this._logCapture.offLog(logHandler); }
    }

    console.log(`[Proto-Engine] Complete: ${JSON.stringify(summary)}`);
    this.emit('complete', { summary });
    this.status = 'idle';
  }
}

module.exports = { ProtocolEngine };
