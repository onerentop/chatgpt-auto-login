# Web Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Vue 3 + Express web dashboard for the ChatGPT auto-login pipeline with real-time execution monitoring, account/config management, and result export.

**Architecture:** Express serves REST API + Socket.IO on one port. Vue 3 SPA (Element Plus) is built by Vite and served as static files. PipelineEngine class wraps existing pipeline logic with EventEmitter for real-time log streaming. Existing CLI files remain untouched.

**Tech Stack:** Express, Socket.IO, jsonwebtoken, archiver (ZIP), Vue 3, Element Plus, Vite, socket.io-client, vue-router

---

## File Map

### Backend (server/)
| File | Responsibility |
|------|---------------|
| `server/index.js` | Express app + Socket.IO init + serve Vue static build |
| `server/engine.js` | PipelineEngine EventEmitter class — wraps index.js logic |
| `server/logger.js` | Intercept console.log → emit to engine |
| `server/routes/auth.js` | POST /api/auth/login |
| `server/routes/accounts.js` | GET/POST/DELETE /api/accounts, import, export |
| `server/routes/config.js` | GET/PUT /api/config |
| `server/routes/execute.js` | POST /api/execute, stop, GET status |
| `server/routes/results.js` | GET /api/results, retry, download auth files |

### Frontend (web/)
| File | Responsibility |
|------|---------------|
| `web/src/main.js` | Vue app entry + Element Plus + router |
| `web/src/App.vue` | Root component |
| `web/src/router.js` | Vue Router config (5 routes) |
| `web/src/api.js` | Axios instance + auth interceptor |
| `web/src/socket.js` | Socket.IO client singleton |
| `web/src/views/Login.vue` | Password login page |
| `web/src/views/Dashboard.vue` | Stats overview |
| `web/src/views/Accounts.vue` | Account table + import/export |
| `web/src/views/Config.vue` | Config form with grouped sections |
| `web/src/views/Execute.vue` | Start/stop + real-time log stream |
| `web/src/views/Results.vue` | Results table + retry + download |
| `web/src/components/AppLayout.vue` | Sidebar nav + content area |

---

### Task 1: Backend Scaffold — Express + Socket.IO + Auth

**Files:**
- Create: `server/index.js`
- Create: `server/routes/auth.js`

- [ ] **Step 1: Install backend dependencies**

```bash
cd E:\workspace\projects\demo\chatgpt-auto-login
npm install express socket.io jsonwebtoken cors archiver
```

- [ ] **Step 2: Create server/index.js**

```javascript
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/accounts', require('./routes/accounts'));
app.use('/api/config', require('./routes/config'));
app.use('/api/execute', require('./routes/execute')(io));
app.use('/api/results', require('./routes/results'));

// Serve Vue static build
const distPath = path.join(__dirname, '..', 'web', 'dist');
app.use(express.static(distPath));
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(distPath, 'index.html'));
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Dashboard running at http://localhost:${PORT}`));
```

- [ ] **Step 3: Create server/routes/auth.js**

```javascript
const express = require('express');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const SECRET = 'chatgpt-auto-login-web';

function getWebPassword() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config.json'), 'utf-8'));
    return config.webPassword || 'admin';
  } catch { return 'admin'; }
}

router.post('/login', (req, res) => {
  const { password } = req.body;
  if (password === getWebPassword()) {
    const token = jwt.sign({ role: 'admin' }, SECRET, { expiresIn: '24h' });
    res.json({ token });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  try {
    jwt.verify(auth.slice(7), SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
}

module.exports = router;
module.exports.authMiddleware = authMiddleware;
module.exports.SECRET = SECRET;
```

- [ ] **Step 4: Commit**

```bash
git add server/index.js server/routes/auth.js package.json package-lock.json
git commit -m "feat: backend scaffold with Express, Socket.IO, auth route"
```

---

### Task 2: Accounts API

**Files:**
- Create: `server/routes/accounts.js`

- [ ] **Step 1: Create server/routes/accounts.js**

```javascript
const express = require('express');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { authMiddleware } = require('./auth');
const router = express.Router();

const CSV_PATH = path.join(__dirname, '..', '..', 'accounts.csv');
const HEADER = 'email,password,totp_secret,client_id,refresh_token\n';

function readAccounts() {
  if (!fs.existsSync(CSV_PATH)) return [];
  const content = fs.readFileSync(CSV_PATH, 'utf-8');
  return parse(content, { columns: true, skip_empty_lines: true, trim: true });
}

function writeAccounts(accounts) {
  const lines = accounts.map(a =>
    `${a.email},${a.password},${a.totp_secret || ''},${a.client_id || ''},${a.refresh_token || ''}`
  );
  fs.writeFileSync(CSV_PATH, HEADER + lines.join('\n') + '\n');
}

router.use(authMiddleware);

router.get('/', (req, res) => {
  const accounts = readAccounts();
  res.json(accounts.map(a => ({
    ...a,
    password: a.password ? '••••••' : '',
    loginType: ['outlook.com','hotmail.com','live.com'].some(d => a.email?.includes(d)) ? 'outlook' : 'google',
  })));
});

router.post('/', (req, res) => {
  const { email, password, totp_secret, client_id, refresh_token } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const accounts = readAccounts();
  if (accounts.find(a => a.email === email)) return res.status(409).json({ error: 'Account exists' });
  accounts.push({ email, password, totp_secret: totp_secret || '', client_id: client_id || '', refresh_token: refresh_token || '' });
  writeAccounts(accounts);
  res.json({ ok: true });
});

router.post('/import', (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  const accounts = readAccounts();
  const lines = text.split('\n').filter(l => l.trim());
  let added = 0;
  for (const line of lines) {
    let parts;
    if (line.includes('----')) {
      parts = line.split('----');
    } else {
      parts = line.split(',');
    }
    const [email, password, totp_or_client, refresh] = parts;
    if (!email || !password) continue;
    if (accounts.find(a => a.email.trim() === email.trim())) continue;
    const isOutlook = ['outlook.com','hotmail.com','live.com'].some(d => email.includes(d));
    accounts.push({
      email: email.trim(),
      password: password.trim(),
      totp_secret: isOutlook ? '' : (totp_or_client || '').trim(),
      client_id: isOutlook ? (totp_or_client || '').trim() : '',
      refresh_token: isOutlook ? (refresh || '').trim() : '',
    });
    added++;
  }
  writeAccounts(accounts);
  res.json({ added, total: accounts.length });
});

router.delete('/:email', (req, res) => {
  let accounts = readAccounts();
  const before = accounts.length;
  accounts = accounts.filter(a => a.email !== req.params.email);
  writeAccounts(accounts);
  res.json({ deleted: before - accounts.length });
});

router.get('/export', (req, res) => {
  if (!fs.existsSync(CSV_PATH)) return res.status(404).json({ error: 'No accounts' });
  res.download(CSV_PATH, 'accounts.csv');
});

module.exports = router;
```

- [ ] **Step 2: Commit**

```bash
git add server/routes/accounts.js
git commit -m "feat: accounts API — CRUD, import, export"
```

---

### Task 3: Config API

**Files:**
- Create: `server/routes/config.js`

- [ ] **Step 1: Create server/routes/config.js**

```javascript
const express = require('express');
const fs = require('fs');
const path = require('path');
const { authMiddleware } = require('./auth');
const router = express.Router();

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config.json');
const SENSITIVE = ['cardNumber', 'cardCvv', 'discordToken', 'cpaKey', 'smsApiUrl'];

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')); }
  catch { return {}; }
}

router.use(authMiddleware);

router.get('/', (req, res) => {
  const config = readConfig();
  const masked = { ...config };
  for (const key of SENSITIVE) {
    if (masked[key]) masked[key] = masked[key].slice(0, 4) + '••••••';
  }
  res.json(masked);
});

router.get('/raw', (req, res) => {
  res.json(readConfig());
});

router.put('/', (req, res) => {
  const current = readConfig();
  const updates = req.body;
  for (const [key, val] of Object.entries(updates)) {
    if (val !== undefined && !String(val).includes('••••••')) {
      current[key] = val;
    }
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2));
  res.json({ ok: true });
});

module.exports = router;
```

- [ ] **Step 2: Commit**

```bash
git add server/routes/config.js
git commit -m "feat: config API — read (masked), update"
```

---

### Task 4: Pipeline Engine

**Files:**
- Create: `server/engine.js`
- Create: `server/logger.js`

- [ ] **Step 1: Create server/logger.js**

```javascript
class LogCapture {
  constructor() {
    this.listeners = [];
    this._originalLog = console.log;
  }

  start() {
    const self = this;
    console.log = function (...args) {
      self._originalLog.apply(console, args);
      const message = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
      for (const fn of self.listeners) fn(message);
    };
  }

  stop() {
    console.log = this._originalLog;
  }

  onLog(fn) { this.listeners.push(fn); }
  offLog(fn) { this.listeners = this.listeners.filter(f => f !== fn); }
}

module.exports = { LogCapture };
```

- [ ] **Step 2: Create server/engine.js**

This file re-implements the core loop from index.js as an EventEmitter class. It imports the same modules (login.js, payment.js, cpa.js, utils.js) and calls them the same way but emits events instead of blocking on stdin.

```javascript
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { chromium } = require('playwright');
const { loadAccounts, saveResult, saveSessionData, saveCPAAuthFile, fetchTokensViaPKCE, randomDelay } = require('../utils');
const { loginAccount } = require('../login');
const { autoPayment, CONFIG } = require('../payment');
const { registerToCPA } = require('../cpa');
const { LogCapture } = require('./logger');

const ROOT = path.join(__dirname, '..');
const CSV_PATH = path.join(ROOT, 'accounts.csv');
const RESULTS_PATH = path.join(ROOT, 'results.csv');
const SESSIONS_DIR = path.join(ROOT, 'sessions');
const DISCORD_RESULTS = path.join(ROOT, 'discord-results.json');

class PipelineEngine extends EventEmitter {
  constructor() {
    super();
    this.status = 'idle'; // idle | running | stopping
    this.stopFlag = false;
    this.logCapture = new LogCapture();
  }

  getStatus() { return this.status; }

  stop() {
    if (this.status === 'running') {
      this.status = 'stopping';
      this.stopFlag = true;
      this.emit('log', { email: '', phase: '', message: 'Stopping after current account...', timestamp: new Date().toISOString() });
    }
  }

  async start(startFrom = 0) {
    if (this.status === 'running') throw new Error('Already running');
    this.status = 'running';
    this.stopFlag = false;

    // Hook console.log
    this.logCapture.start();
    this.logCapture.onLog((msg) => {
      this.emit('log', { email: this._currentEmail || '', phase: this._currentPhase || '', message: msg, timestamp: new Date().toISOString() });
    });

    const accounts = loadAccounts(CSV_PATH);
    const allResults = [];

    // Reuse Discord + Chrome setup from index.js (simplified — inline the core logic)
    // This mirrors index.js main() but emits events
    const DISCORD_TOKEN = CONFIG.discordToken || '';
    const CHANNEL_ID = CONFIG.discordChannelId || '';
    const HUB_MESSAGE_ID = CONFIG.discordMessageId || '';
    const GUILD_ID = CONFIG.discordGuildId || '';
    const APP_ID = CONFIG.discordAppId || '';

    let gw = null;
    try {
      // Connect Discord Gateway (copied from index.js pattern)
      gw = await this._connectDiscordGateway(DISCORD_TOKEN);
      this.emit('log', { email: '', phase: '', message: `Loaded ${accounts.length} accounts. Starting from #${startFrom + 1}.`, timestamp: new Date().toISOString() });

      const basePort = 19222;
      for (let i = startFrom; i < accounts.length; i++) {
        if (this.stopFlag) break;

        const account = accounts[i];
        this._currentEmail = account.email;
        this._currentPhase = 'login';
        this.emit('account-status', { email: account.email, status: 'running', phase: 'login', progress: `${i + 1}/${accounts.length}` });

        const port = basePort + i;
        const tempDir = path.join(os.tmpdir(), `chatgpt-login-${Date.now()}`);
        let chromeProc = null, browser = null;
        let finalResult = { email: account.email, status: 'ERROR', paymentLink: '', reason: '' };

        try {
          chromeProc = this._launchChrome(port, tempDir);
          browser = await this._waitForCDP(port);
          const loginResult = await loginAccount(browser, account);
          saveResult(RESULTS_PATH, loginResult);
          saveSessionData(SESSIONS_DIR, loginResult);

          if (loginResult.status !== 'SUCCESS' || !loginResult.accessToken) {
            finalResult.reason = `Login: ${loginResult.reason || loginResult.status}`;
            allResults.push(finalResult);
            this.emit('account-status', { email: account.email, status: 'failed', phase: 'login', progress: `${i + 1}/${accounts.length}` });
            continue;
          }

          const planType = loginResult.session?.account?.planType || 'free';
          const isPlusOrAbove = ['plus', 'pro', 'team', 'enterprise'].includes(planType.toLowerCase());

          if (isPlusOrAbove) {
            this._currentPhase = 'cpa';
            finalResult = { email: account.email, status: 'ALREADY_PLUS', paymentLink: '', reason: '' };

            if (CONFIG.enableCPA !== false) {
              this.emit('account-status', { email: account.email, status: 'running', phase: 'cpa', progress: `${i + 1}/${accounts.length}` });
              try { await registerToCPA(browser, account.email, account); } catch (e) { console.log(`CPA error: ${e.message}`); }
            } else {
              const pkceTokens = await fetchTokensViaPKCE(browser, account).catch(() => null);
              saveCPAAuthFile(account.email, pkceTokens?.access_token || loginResult.accessToken, pkceTokens || loginResult.session);
            }
          } else {
            // Phase 2: Discord
            this._currentPhase = 'discord';
            this.emit('account-status', { email: account.email, status: 'running', phase: 'discord', progress: `${i + 1}/${accounts.length}` });
            const discord = await this._getPaymentLink(gw, loginResult.accessToken, GUILD_ID, CHANNEL_ID, HUB_MESSAGE_ID, APP_ID);

            if (discord.link) {
              finalResult = { email: account.email, status: 'SUCCESS', paymentLink: discord.link, reason: '' };

              // Phase 3: Payment
              this._currentPhase = 'payment';
              this.emit('account-status', { email: account.email, status: 'running', phase: 'payment', progress: `${i + 1}/${accounts.length}` });
              const ctx = browser.contexts()[0];
              const pages = ctx.pages();
              const page = pages.length > 0 ? pages[0] : await ctx.newPage();
              await page.goto(discord.link, { waitUntil: 'domcontentloaded', timeout: 30000 });
              await randomDelay(2000, 3000);
              try { await autoPayment(page); } catch (e) { console.log(`Auto-fill error: ${e.message}`); }

              await randomDelay(10000, 12000);

              // Phase 4: CPA
              this._currentPhase = 'cpa';
              if (CONFIG.enableCPA !== false) {
                this.emit('account-status', { email: account.email, status: 'running', phase: 'cpa', progress: `${i + 1}/${accounts.length}` });
                try { await registerToCPA(browser, account.email, account); } catch (e) { console.log(`CPA error: ${e.message}`); }
              } else {
                const pkceTokens = await fetchTokensViaPKCE(browser, account).catch(() => null);
                saveCPAAuthFile(account.email, pkceTokens?.access_token || loginResult.accessToken, pkceTokens || loginResult.session);
              }
            } else {
              finalResult = { email: account.email, status: 'NO_LINK', paymentLink: '', reason: discord.raw?.slice(0, 200) || '' };
            }
          }

          this.emit('account-status', { email: account.email, status: finalResult.status === 'ERROR' ? 'failed' : 'success', phase: 'done', progress: `${i + 1}/${accounts.length}` });
        } catch (error) {
          finalResult.reason = error.message.slice(0, 200);
          this.emit('account-status', { email: account.email, status: 'failed', phase: 'error', progress: `${i + 1}/${accounts.length}` });
        } finally {
          if (browser) try { await browser.close(); } catch {}
          if (chromeProc) try { chromeProc.kill(); } catch {}
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
        }

        allResults.push(finalResult);
        if (i < accounts.length - 1 && !this.stopFlag) {
          await randomDelay(5000, 8000);
        }
      }
    } finally {
      if (gw) gw.cleanup();
      this.logCapture.stop();
      this._currentEmail = '';
      this._currentPhase = '';
    }

    fs.writeFileSync(DISCORD_RESULTS, JSON.stringify(allResults, null, 2));

    const summary = {
      total: allResults.length,
      success: allResults.filter(r => r.status === 'SUCCESS').length,
      alreadyPlus: allResults.filter(r => r.status === 'ALREADY_PLUS').length,
      noLink: allResults.filter(r => r.status === 'NO_LINK').length,
      error: allResults.filter(r => r.status === 'ERROR').length,
    };
    this.emit('complete', { summary });
    this.status = 'idle';
    return summary;
  }

  // --- Private helpers (copied from index.js patterns) ---

  _launchChrome(port, tempDir) {
    const chromePaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    ];
    let chromePath;
    for (const p of chromePaths) if (fs.existsSync(p)) { chromePath = p; break; }
    if (!chromePath) throw new Error('Chrome not found');
    return spawn(chromePath, [
      `--remote-debugging-port=${port}`, '--incognito',
      `--user-data-dir=${tempDir}`, '--no-first-run',
      '--no-default-browser-check', '--disable-default-apps',
      '--disable-popup-blocking', '--window-size=1920,1080', 'about:blank',
    ], { stdio: 'ignore', detached: false });
  }

  async _waitForCDP(port) {
    const start = Date.now();
    while (Date.now() - start < 15000) {
      try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`); }
      catch { await new Promise(r => setTimeout(r, 500)); }
    }
    throw new Error('CDP timeout');
  }

  async _connectDiscordGateway(token) {
    // Reuse the Gateway connection logic from index.js
    // This is a simplified version — full implementation mirrors index.js
    const superProps = Buffer.from(JSON.stringify({
      os: 'Windows', browser: 'Chrome', device: '',
      browser_user_agent: 'Mozilla/5.0', browser_version: '131.0.0.0',
      os_version: '10', release_channel: 'stable', client_build_number: 335978,
    })).toString('base64');

    const headers = {
      'Authorization': token, 'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'X-Super-Properties': superProps,
    };

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
          ws.send(JSON.stringify({ op: 2, d: { token, properties: { os: 'Windows', browser: 'Chrome', device: '' }, presence: { status: 'online', afk: false } } }));
        }
        if (m.op === 0 && m.t === 'READY') {
          sessionId = m.d.session_id;
          resolve({ ws, sessionId, on, off, headers, cleanup: () => { clearInterval(hb); ws.close(); } });
        }
        if (m.op === 0 && m.t) for (const f of (eh[m.t] || [])) f(m.d);
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('Gateway timeout')), 30000);
    });
  }

  async _getPaymentLink(gw, accessToken, guildId, channelId, hubMessageId, appId) {
    // Mirrors the Discord bot flow from index.js
    function nn() { return String(BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))); }
    async function interact(body) {
      const res = await fetch(`https://discord.com/api/v9/interactions`, { method: 'POST', headers: gw.headers, body: JSON.stringify(body) });
      if (res.status !== 204 && res.status !== 200) throw new Error(`Interaction ${res.status}`);
    }
    function waitFor(event, filter, ms = 30000) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { gw.off(event, h); reject(new Error(`Timeout: ${event}`)); }, ms);
        function h(d) { if (filter(d)) { clearTimeout(t); gw.off(event, h); resolve(d); } }
        gw.on(event, h);
      });
    }
    function waitForAny(events, filter, ms = 30000) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { cleanup(); reject(new Error('Timeout')); }, ms);
        const hs = {};
        function cleanup() { clearTimeout(t); for (const e of events) gw.off(e, hs[e]); }
        for (const e of events) { hs[e] = (d) => { if (filter(d)) { cleanup(); resolve(d); } }; gw.on(e, hs[e]); }
      });
    }

    try {
      const menuP = waitFor('MESSAGE_CREATE', (d) => d.author?.bot && d.components?.length > 0, 15000);
      await interact({ type: 3, nonce: nn(), guild_id: guildId, channel_id: channelId, message_flags: 0, message_id: hubMessageId, application_id: appId, session_id: gw.sessionId, data: { component_type: 2, custom_id: 'hub:chatgpt' } });
      const menu = await menuP;

      let btnId = null;
      for (const r of (menu.components || [])) for (const c of (r.components || [])) if (c.label?.includes('美区') && c.label?.includes('PLUS') && c.label?.includes('免费试用')) btnId = c.custom_id;
      if (!btnId) throw new Error('US Plus button not found');

      const modalP = waitFor('INTERACTION_MODAL_CREATE', () => true, 15000);
      await new Promise(r => setTimeout(r, 1500));
      await interact({ type: 3, nonce: nn(), guild_id: guildId, channel_id: channelId, message_flags: 64, message_id: menu.id, application_id: appId, session_id: gw.sessionId, data: { component_type: 2, custom_id: btnId } });
      const modal = await modalP;

      const comps = modal.components.map(r => ({ type: r.type, components: r.components.map(f => ({ type: f.type, custom_id: f.custom_id, value: accessToken })) }));
      const resultP = waitForAny(['MESSAGE_UPDATE', 'MESSAGE_CREATE'], (d) => {
        if (d.channel_id !== channelId || !d.author?.bot) return false;
        const t = JSON.stringify(d.embeds || []) + (d.content || '');
        return t.includes('pay.openai.com') || t.includes('试用链接') || t.includes('失败') || t.includes('积分不足') || t.includes('资格');
      }, 60000);
      await interact({ type: 5, nonce: nn(), guild_id: guildId, channel_id: channelId, application_id: modal.application.id, session_id: gw.sessionId, data: { id: modal.id, custom_id: modal.custom_id, components: comps } });

      const res = await resultP;
      const all = (res.content || '') + ' ' + JSON.stringify(res.embeds || []);
      const m = all.match(/https:\/\/pay\.openai\.com[^\s"\\|)]+/);
      return { link: m ? m[0] : null, title: res.embeds?.[0]?.title || '', raw: res.embeds?.[0]?.description || res.content || '' };
    } catch (e) {
      return { link: null, raw: e.message };
    }
  }
}

module.exports = { PipelineEngine };
```

- [ ] **Step 3: Commit**

```bash
git add server/engine.js server/logger.js
git commit -m "feat: PipelineEngine + LogCapture for web execution"
```

---

### Task 5: Execute & Results API

**Files:**
- Create: `server/routes/execute.js`
- Create: `server/routes/results.js`

- [ ] **Step 1: Create server/routes/execute.js**

```javascript
const express = require('express');
const { authMiddleware } = require('./auth');
const { PipelineEngine } = require('../engine');

let engine = null;

module.exports = function (io) {
  const router = express.Router();
  router.use(authMiddleware);

  router.get('/status', (req, res) => {
    res.json({ status: engine ? engine.getStatus() : 'idle' });
  });

  router.post('/', (req, res) => {
    if (engine && engine.getStatus() === 'running') {
      return res.status(409).json({ error: 'Already running' });
    }
    const { startFrom } = req.body;
    engine = new PipelineEngine();

    engine.on('log', (data) => io.emit('log', data));
    engine.on('account-status', (data) => io.emit('account-status', data));
    engine.on('complete', (data) => io.emit('execution-complete', data));

    engine.start(startFrom || 0).catch(err => {
      io.emit('log', { email: '', phase: '', message: `Fatal: ${err.message}`, timestamp: new Date().toISOString() });
    });

    res.json({ ok: true, message: 'Execution started' });
  });

  router.post('/stop', (req, res) => {
    if (!engine || engine.getStatus() !== 'running') {
      return res.status(400).json({ error: 'Not running' });
    }
    engine.stop();
    res.json({ ok: true, message: 'Stopping...' });
  });

  return router;
};
```

- [ ] **Step 2: Create server/routes/results.js**

```javascript
const express = require('express');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { authMiddleware } = require('./auth');
const router = express.Router();

const ROOT = path.join(__dirname, '..', '..');
const DISCORD_RESULTS = path.join(ROOT, 'discord-results.json');
const SESSIONS_DIR = path.join(ROOT, 'sessions');
const CPA_AUTH_DIR = path.join(ROOT, 'cpa-auth');

router.use(authMiddleware);

router.get('/', (req, res) => {
  let results = [];
  try { results = JSON.parse(fs.readFileSync(DISCORD_RESULTS, 'utf-8')); } catch {}
  // Enrich with session data
  for (const r of results) {
    const sanitized = r.email.replace(/[@.]/g, '_');
    const sessionFile = path.join(SESSIONS_DIR, `${sanitized}.json`);
    const authFile = path.join(CPA_AUTH_DIR, `codex-${r.email.replace(/@/g, '-at-').replace(/\./g, '-')}.json`);
    r.hasSession = fs.existsSync(sessionFile);
    r.hasAuthFile = fs.existsSync(authFile);
  }
  res.json(results);
});

router.get('/:email/auth-file', (req, res) => {
  const sanitized = req.params.email.replace(/@/g, '-at-').replace(/\./g, '-');
  const filePath = path.join(CPA_AUTH_DIR, `codex-${sanitized}.json`);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Auth file not found' });
  res.download(filePath);
});

router.get('/download-all', (req, res) => {
  if (!fs.existsSync(CPA_AUTH_DIR)) return res.status(404).json({ error: 'No auth files' });
  const files = fs.readdirSync(CPA_AUTH_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) return res.status(404).json({ error: 'No auth files' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename=cpa-auth-files.zip');
  const archive = archiver('zip');
  archive.pipe(res);
  for (const f of files) archive.file(path.join(CPA_AUTH_DIR, f), { name: f });
  archive.finalize();
});

router.post('/:email/retry', (req, res) => {
  // Retry is handled by starting execution with startFrom for that specific account
  // For now, return the account index
  const { parse } = require('csv-parse/sync');
  const csvPath = path.join(ROOT, 'accounts.csv');
  try {
    const content = fs.readFileSync(csvPath, 'utf-8');
    const accounts = parse(content, { columns: true, skip_empty_lines: true, trim: true });
    const idx = accounts.findIndex(a => a.email === req.params.email);
    if (idx === -1) return res.status(404).json({ error: 'Account not found' });
    res.json({ ok: true, startFrom: idx, message: `Use startFrom: ${idx} to retry` });
  } catch { res.status(500).json({ error: 'Failed to read accounts' }); }
});

module.exports = router;
```

- [ ] **Step 3: Commit**

```bash
git add server/routes/execute.js server/routes/results.js
git commit -m "feat: execute + results API routes"
```

---

### Task 6: Vue 3 Frontend Scaffold

**Files:**
- Create: `web/package.json`
- Create: `web/vite.config.js`
- Create: `web/index.html`
- Create: `web/src/main.js`
- Create: `web/src/App.vue`
- Create: `web/src/router.js`
- Create: `web/src/api.js`
- Create: `web/src/socket.js`

- [ ] **Step 1: Initialize Vue project**

```bash
cd E:\workspace\projects\demo\chatgpt-auto-login
mkdir -p web/src/views web/src/components
```

- [ ] **Step 2: Create web/package.json**

```json
{
  "name": "chatgpt-auto-login-web",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  },
  "dependencies": {
    "vue": "^3.5.0",
    "vue-router": "^4.5.0",
    "element-plus": "^2.9.0",
    "axios": "^1.7.0",
    "socket.io-client": "^4.8.0",
    "@element-plus/icons-vue": "^2.3.0"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.2.0",
    "vite": "^6.0.0"
  }
}
```

- [ ] **Step 3: Create web/vite.config.js**

```javascript
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
  build: {
    outDir: 'dist',
  },
})
```

- [ ] **Step 4: Create web/index.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ChatGPT Auto Login Dashboard</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/src/main.js"></script>
</body>
</html>
```

- [ ] **Step 5: Create web/src/main.js**

```javascript
import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import App from './App.vue'
import router from './router'

const app = createApp(App)
app.use(ElementPlus, { locale: zhCn })
app.use(router)
app.mount('#app')
```

- [ ] **Step 6: Create web/src/router.js**

```javascript
import { createRouter, createWebHashHistory } from 'vue-router'

const routes = [
  { path: '/login', component: () => import('./views/Login.vue') },
  { path: '/', component: () => import('./views/Dashboard.vue'), meta: { auth: true } },
  { path: '/accounts', component: () => import('./views/Accounts.vue'), meta: { auth: true } },
  { path: '/config', component: () => import('./views/Config.vue'), meta: { auth: true } },
  { path: '/execute', component: () => import('./views/Execute.vue'), meta: { auth: true } },
  { path: '/results', component: () => import('./views/Results.vue'), meta: { auth: true } },
]

const router = createRouter({ history: createWebHashHistory(), routes })

router.beforeEach((to) => {
  if (to.meta.auth && !localStorage.getItem('token')) return '/login'
})

export default router
```

- [ ] **Step 7: Create web/src/api.js**

```javascript
import axios from 'axios'

const api = axios.create({ baseURL: '/api' })

api.interceptors.request.use(config => {
  const token = localStorage.getItem('token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(r => r, err => {
  if (err.response?.status === 401) {
    localStorage.removeItem('token')
    window.location.hash = '#/login'
  }
  return Promise.reject(err)
})

export default api
```

- [ ] **Step 8: Create web/src/socket.js**

```javascript
import { io } from 'socket.io-client'
import { reactive } from 'vue'

export const state = reactive({
  logs: [],
  accountStatuses: {},
  connected: false,
})

const socket = io({ autoConnect: false })

socket.on('connect', () => { state.connected = true })
socket.on('disconnect', () => { state.connected = false })

socket.on('log', (data) => {
  state.logs.push(data)
  if (state.logs.length > 1000) state.logs.splice(0, 500)
})

socket.on('account-status', (data) => {
  state.accountStatuses[data.email] = data
})

socket.on('execution-complete', (data) => {
  state.logs.push({ email: '', phase: '', message: `Execution complete: ${JSON.stringify(data.summary)}`, timestamp: new Date().toISOString() })
})

export function connectSocket() { socket.connect() }
export function disconnectSocket() { socket.disconnect() }
export default socket
```

- [ ] **Step 9: Create web/src/App.vue**

```vue
<template>
  <router-view v-if="$route.path === '/login'" />
  <AppLayout v-else>
    <router-view />
  </AppLayout>
</template>

<script setup>
import AppLayout from './components/AppLayout.vue'
import { connectSocket } from './socket'
import { onMounted } from 'vue'

onMounted(() => {
  if (localStorage.getItem('token')) connectSocket()
})
</script>
```

- [ ] **Step 10: Create web/src/components/AppLayout.vue**

```vue
<template>
  <el-container style="height: 100vh">
    <el-aside width="200px" style="background: #304156">
      <div style="padding: 20px; color: #fff; font-size: 16px; font-weight: bold; text-align: center">
        GPT Dashboard
      </div>
      <el-menu :default-active="$route.path" router background-color="#304156" text-color="#bfcbd9" active-text-color="#409EFF">
        <el-menu-item index="/"><el-icon><Monitor /></el-icon><span>仪表盘</span></el-menu-item>
        <el-menu-item index="/accounts"><el-icon><User /></el-icon><span>账号管理</span></el-menu-item>
        <el-menu-item index="/config"><el-icon><Setting /></el-icon><span>配置设置</span></el-menu-item>
        <el-menu-item index="/execute"><el-icon><VideoPlay /></el-icon><span>执行控制</span></el-menu-item>
        <el-menu-item index="/results"><el-icon><Document /></el-icon><span>执行结果</span></el-menu-item>
      </el-menu>
    </el-aside>
    <el-main style="padding: 20px; background: #f0f2f5">
      <slot />
    </el-main>
  </el-container>
</template>

<script setup>
import { Monitor, User, Setting, VideoPlay, Document } from '@element-plus/icons-vue'
</script>
```

- [ ] **Step 11: Install frontend deps and commit**

```bash
cd web && npm install && cd ..
git add web/
git commit -m "feat: Vue 3 frontend scaffold with router, api, socket, layout"
```

---

### Task 7: Login + Dashboard + Config Pages

**Files:**
- Create: `web/src/views/Login.vue`
- Create: `web/src/views/Dashboard.vue`
- Create: `web/src/views/Config.vue`

- [ ] **Step 1: Create web/src/views/Login.vue**

```vue
<template>
  <div style="display:flex;justify-content:center;align-items:center;height:100vh;background:#f0f2f5">
    <el-card style="width: 400px">
      <template #header><h2 style="text-align:center;margin:0">ChatGPT Auto Login</h2></template>
      <el-form @submit.prevent="login">
        <el-form-item label="管理密码">
          <el-input v-model="password" type="password" placeholder="请输入管理密码" show-password />
        </el-form-item>
        <el-button type="primary" :loading="loading" @click="login" style="width:100%">登录</el-button>
      </el-form>
    </el-card>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import api from '../api'
import { connectSocket } from '../socket'

const password = ref('')
const loading = ref(false)
const router = useRouter()

async function login() {
  loading.value = true
  try {
    const { data } = await api.post('/auth/login', { password: password.value })
    localStorage.setItem('token', data.token)
    connectSocket()
    router.push('/')
  } catch {
    ElMessage.error('密码错误')
  } finally {
    loading.value = false
  }
}
</script>
```

- [ ] **Step 2: Create web/src/views/Dashboard.vue**

```vue
<template>
  <div>
    <h2>仪表盘</h2>
    <el-row :gutter="20" style="margin-bottom: 20px">
      <el-col :span="6" v-for="card in cards" :key="card.label">
        <el-card shadow="hover">
          <div style="font-size: 30px; font-weight: bold; color: #409EFF">{{ card.value }}</div>
          <div style="color: #909399; margin-top: 8px">{{ card.label }}</div>
        </el-card>
      </el-col>
    </el-row>
    <el-card>
      <template #header>最近执行结果</template>
      <el-table :data="results" stripe size="small" max-height="400">
        <el-table-column prop="email" label="邮箱" />
        <el-table-column prop="status" label="状态" width="140">
          <template #default="{ row }">
            <el-tag :type="statusType(row.status)">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import api from '../api'

const results = ref([])
const accounts = ref([])

onMounted(async () => {
  try { results.value = (await api.get('/results')).data } catch {}
  try { accounts.value = (await api.get('/accounts')).data } catch {}
})

const cards = computed(() => [
  { label: '总账号数', value: accounts.value.length },
  { label: 'Plus 账号', value: results.value.filter(r => r.status === 'ALREADY_PLUS' || r.status === 'SUCCESS').length },
  { label: '成功', value: results.value.filter(r => r.status === 'SUCCESS').length },
  { label: '失败', value: results.value.filter(r => r.status === 'ERROR').length },
])

function statusType(s) {
  if (s === 'SUCCESS' || s === 'ALREADY_PLUS') return 'success'
  if (s === 'ERROR') return 'danger'
  if (s === 'NO_LINK') return 'warning'
  return 'info'
}
</script>
```

- [ ] **Step 3: Create web/src/views/Config.vue**

```vue
<template>
  <div>
    <h2>配置设置</h2>
    <el-form label-width="160px" style="max-width: 600px">
      <el-divider>支付配置</el-divider>
      <el-form-item label="手机号"><el-input v-model="config.phone" /></el-form-item>
      <el-form-item label="SMS API"><el-input v-model="config.smsApiUrl" /></el-form-item>
      <el-form-item label="卡号"><el-input v-model="config.cardNumber" /></el-form-item>
      <el-form-item label="有效期"><el-input v-model="config.cardExpiry" placeholder="MM / YY" /></el-form-item>
      <el-form-item label="CVV"><el-input v-model="config.cardCvv" /></el-form-item>

      <el-divider>Discord 配置</el-divider>
      <el-form-item label="Token"><el-input v-model="config.discordToken" show-password /></el-form-item>
      <el-form-item label="Channel ID"><el-input v-model="config.discordChannelId" /></el-form-item>
      <el-form-item label="Message ID"><el-input v-model="config.discordMessageId" /></el-form-item>
      <el-form-item label="Guild ID"><el-input v-model="config.discordGuildId" /></el-form-item>
      <el-form-item label="App ID"><el-input v-model="config.discordAppId" /></el-form-item>

      <el-divider>CPA 配置</el-divider>
      <el-form-item label="启用 CPA OAuth"><el-switch v-model="config.enableCPA" /></el-form-item>
      <el-form-item label="CPA URL"><el-input v-model="config.cpaUrl" /></el-form-item>
      <el-form-item label="CPA 密钥"><el-input v-model="config.cpaKey" show-password /></el-form-item>

      <el-divider>Web 管理</el-divider>
      <el-form-item label="管理密码"><el-input v-model="config.webPassword" show-password /></el-form-item>

      <el-form-item>
        <el-button type="primary" :loading="saving" @click="save">保存配置</el-button>
      </el-form-item>
    </el-form>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'

const config = ref({})
const saving = ref(false)

onMounted(async () => {
  try { config.value = (await api.get('/config/raw')).data } catch {}
})

async function save() {
  saving.value = true
  try {
    await api.put('/config', config.value)
    ElMessage.success('配置已保存')
  } catch { ElMessage.error('保存失败') }
  finally { saving.value = false }
}
</script>
```

- [ ] **Step 4: Commit**

```bash
git add web/src/views/Login.vue web/src/views/Dashboard.vue web/src/views/Config.vue
git commit -m "feat: Login, Dashboard, Config pages"
```

---

### Task 8: Accounts Page

**Files:**
- Create: `web/src/views/Accounts.vue`

- [ ] **Step 1: Create web/src/views/Accounts.vue**

```vue
<template>
  <div>
    <h2>账号管理</h2>
    <el-row :gutter="10" style="margin-bottom: 16px">
      <el-col :span="4"><el-button type="primary" @click="showAdd = true">添加账号</el-button></el-col>
      <el-col :span="4"><el-button @click="showImport = true">批量导入</el-button></el-col>
      <el-col :span="4"><el-button @click="exportCSV">导出 CSV</el-button></el-col>
      <el-col :span="4"><el-tag>共 {{ accounts.length }} 个账号</el-tag></el-col>
    </el-row>

    <el-table :data="accounts" stripe border>
      <el-table-column prop="email" label="邮箱" />
      <el-table-column prop="loginType" label="类型" width="100">
        <template #default="{ row }"><el-tag :type="row.loginType==='google'?'':'warning'" size="small">{{ row.loginType }}</el-tag></template>
      </el-table-column>
      <el-table-column prop="password" label="密码" width="100" />
      <el-table-column label="操作" width="100">
        <template #default="{ row }">
          <el-popconfirm title="确定删除?" @confirm="del(row.email)">
            <template #reference><el-button size="small" type="danger" text>删除</el-button></template>
          </el-popconfirm>
        </template>
      </el-table-column>
    </el-table>

    <!-- Add Dialog -->
    <el-dialog v-model="showAdd" title="添加账号" width="500">
      <el-form label-width="100px">
        <el-form-item label="邮箱"><el-input v-model="form.email" /></el-form-item>
        <el-form-item label="密码"><el-input v-model="form.password" /></el-form-item>
        <el-form-item label="TOTP密钥"><el-input v-model="form.totp_secret" placeholder="Gmail 账号填写" /></el-form-item>
        <el-form-item label="Client ID"><el-input v-model="form.client_id" placeholder="Outlook 账号填写" /></el-form-item>
        <el-form-item label="Refresh Token"><el-input v-model="form.refresh_token" type="textarea" placeholder="Outlook 账号填写" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAdd = false">取消</el-button>
        <el-button type="primary" @click="add">添加</el-button>
      </template>
    </el-dialog>

    <!-- Import Dialog -->
    <el-dialog v-model="showImport" title="批量导入" width="600">
      <p style="color:#909399;margin-bottom:12px">每行一个账号，支持 email----password----client_id----refresh_token 格式</p>
      <el-input v-model="importText" type="textarea" :rows="10" placeholder="粘贴账号数据..." />
      <template #footer>
        <el-button @click="showImport = false">取消</el-button>
        <el-button type="primary" @click="importAccounts">导入</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'

const accounts = ref([])
const showAdd = ref(false)
const showImport = ref(false)
const importText = ref('')
const form = ref({ email: '', password: '', totp_secret: '', client_id: '', refresh_token: '' })

async function load() {
  try { accounts.value = (await api.get('/accounts')).data } catch {}
}
onMounted(load)

async function add() {
  try {
    await api.post('/accounts', form.value)
    ElMessage.success('已添加')
    showAdd.value = false
    form.value = { email: '', password: '', totp_secret: '', client_id: '', refresh_token: '' }
    load()
  } catch (e) { ElMessage.error(e.response?.data?.error || '添加失败') }
}

async function importAccounts() {
  try {
    const { data } = await api.post('/accounts/import', { text: importText.value })
    ElMessage.success(`导入 ${data.added} 个，共 ${data.total} 个`)
    showImport.value = false
    importText.value = ''
    load()
  } catch { ElMessage.error('导入失败') }
}

async function del(email) {
  try { await api.delete(`/accounts/${encodeURIComponent(email)}`); ElMessage.success('已删除'); load() }
  catch { ElMessage.error('删除失败') }
}

function exportCSV() { window.open('/api/accounts/export') }
</script>
```

- [ ] **Step 2: Commit**

```bash
git add web/src/views/Accounts.vue
git commit -m "feat: Accounts page — table, add, import, export, delete"
```

---

### Task 9: Execute Page + Real-time Logs

**Files:**
- Create: `web/src/views/Execute.vue`

- [ ] **Step 1: Create web/src/views/Execute.vue**

```vue
<template>
  <div>
    <h2>执行控制</h2>
    <el-row :gutter="10" style="margin-bottom: 16px">
      <el-col :span="3">
        <el-button type="primary" :disabled="running" @click="start">
          <el-icon><VideoPlay /></el-icon> 开始执行
        </el-button>
      </el-col>
      <el-col :span="3">
        <el-button type="danger" :disabled="!running" @click="stop">
          <el-icon><VideoPause /></el-icon> 停止
        </el-button>
      </el-col>
      <el-col :span="4">
        <el-input-number v-model="startFrom" :min="1" :disabled="running" size="small" />
        <span style="margin-left:8px;color:#909399;font-size:12px">从第 N 个开始</span>
      </el-col>
      <el-col :span="4">
        <el-tag :type="running ? 'warning' : 'info'">{{ running ? '运行中' : '空闲' }}</el-tag>
        <el-tag v-if="socketState.connected" type="success" style="margin-left:8px">已连接</el-tag>
      </el-col>
    </el-row>

    <!-- Account Progress Cards -->
    <div v-for="(status, email) in socketState.accountStatuses" :key="email" style="margin-bottom: 8px">
      <el-card shadow="never" body-style="padding: 12px">
        <el-row align="middle">
          <el-col :span="8"><strong>{{ email }}</strong></el-col>
          <el-col :span="4"><el-tag :type="statusTag(status.status)" size="small">{{ status.phase }}</el-tag></el-col>
          <el-col :span="4"><span style="color:#909399">{{ status.progress }}</span></el-col>
        </el-row>
      </el-card>
    </div>

    <!-- Log Stream -->
    <el-card style="margin-top: 16px">
      <template #header>
        <span>实时日志</span>
        <el-button size="small" style="float:right" @click="socketState.logs = []">清空</el-button>
      </template>
      <div ref="logBox" style="height: 400px; overflow-y: auto; font-family: monospace; font-size: 12px; background: #1e1e1e; color: #d4d4d4; padding: 12px; border-radius: 4px">
        <div v-for="(log, i) in socketState.logs" :key="i">
          <span style="color:#6a9955">{{ log.timestamp?.slice(11,19) }}</span>
          <span v-if="log.email" style="color:#569cd6"> [{{ log.email.split('@')[0] }}]</span>
          <span> {{ log.message }}</span>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, watch, nextTick } from 'vue'
import { VideoPlay, VideoPause } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import api from '../api'
import { state as socketState } from '../socket'

const running = ref(false)
const startFrom = ref(1)
const logBox = ref(null)

// Auto-scroll log
watch(() => socketState.logs.length, () => {
  nextTick(() => { if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight })
})

async function checkStatus() {
  try { const { data } = await api.get('/execute/status'); running.value = data.status === 'running' }
  catch {}
}
checkStatus()

async function start() {
  try {
    socketState.logs = []
    socketState.accountStatuses = {}
    await api.post('/execute', { startFrom: startFrom.value - 1 })
    running.value = true
    ElMessage.success('执行已启动')
  } catch (e) { ElMessage.error(e.response?.data?.error || '启动失败') }
}

async function stop() {
  try { await api.post('/execute/stop'); ElMessage.info('正在停止...') }
  catch { ElMessage.error('停止失败') }
}

function statusTag(s) {
  if (s === 'running') return 'warning'
  if (s === 'success') return 'success'
  if (s === 'failed') return 'danger'
  return 'info'
}
</script>
```

- [ ] **Step 2: Commit**

```bash
git add web/src/views/Execute.vue
git commit -m "feat: Execute page with real-time log stream"
```

---

### Task 10: Results Page

**Files:**
- Create: `web/src/views/Results.vue`

- [ ] **Step 1: Create web/src/views/Results.vue**

```vue
<template>
  <div>
    <h2>执行结果</h2>
    <el-row :gutter="10" style="margin-bottom: 16px">
      <el-col :span="4">
        <el-select v-model="filter" clearable placeholder="筛选状态" style="width:100%">
          <el-option label="SUCCESS" value="SUCCESS" />
          <el-option label="ALREADY_PLUS" value="ALREADY_PLUS" />
          <el-option label="NO_LINK" value="NO_LINK" />
          <el-option label="ERROR" value="ERROR" />
        </el-select>
      </el-col>
      <el-col :span="4"><el-button @click="downloadAll">下载所有 Auth JSON (ZIP)</el-button></el-col>
      <el-col :span="3"><el-button @click="load">刷新</el-button></el-col>
    </el-row>

    <el-table :data="filtered" stripe border>
      <el-table-column prop="email" label="邮箱" />
      <el-table-column prop="status" label="状态" width="140">
        <template #default="{ row }"><el-tag :type="statusType(row.status)" size="small">{{ row.status }}</el-tag></template>
      </el-table-column>
      <el-table-column label="Auth 文件" width="120">
        <template #default="{ row }">
          <el-button v-if="row.hasAuthFile" size="small" type="success" text @click="downloadAuth(row.email)">下载</el-button>
          <span v-else style="color:#909399">-</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="100">
        <template #default="{ row }">
          <el-button size="small" type="warning" text @click="retry(row.email)">重试</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'

const results = ref([])
const filter = ref('')

const filtered = computed(() => filter.value ? results.value.filter(r => r.status === filter.value) : results.value)

async function load() {
  try { results.value = (await api.get('/results')).data } catch {}
}
onMounted(load)

function statusType(s) {
  if (s === 'SUCCESS' || s === 'ALREADY_PLUS') return 'success'
  if (s === 'ERROR') return 'danger'
  if (s === 'NO_LINK') return 'warning'
  return 'info'
}

function downloadAuth(email) { window.open(`/api/results/${encodeURIComponent(email)}/auth-file`) }
function downloadAll() { window.open('/api/results/download-all') }

async function retry(email) {
  try {
    const { data } = await api.post(`/results/${encodeURIComponent(email)}/retry`)
    ElMessage.info(`请到执行页面从第 ${data.startFrom + 1} 个开始执行`)
  } catch { ElMessage.error('重试失败') }
}
</script>
```

- [ ] **Step 2: Commit**

```bash
git add web/src/views/Results.vue
git commit -m "feat: Results page with filter, download, retry"
```

---

### Task 11: Build, Integrate & Test

- [ ] **Step 1: Add npm scripts to root package.json**

Add to existing `package.json` scripts:

```json
{
  "scripts": {
    "start": "node index.js",
    "web": "node server/index.js",
    "web:dev": "cd web && npm run dev",
    "web:build": "cd web && npm run build"
  }
}
```

- [ ] **Step 2: Add webPassword to config.json**

Add `"webPassword": "admin"` to existing config.json.

- [ ] **Step 3: Build frontend**

```bash
cd web && npm run build && cd ..
```

- [ ] **Step 4: Test the full stack**

```bash
node server/index.js
```

Open `http://localhost:3000`, login with password, verify:
- Dashboard shows stats
- Accounts page lists CSV entries
- Config page shows settings
- Execute page starts pipeline with real-time logs
- Results page shows results with download

- [ ] **Step 5: Final commit and push**

```bash
git add -A
git commit -m "feat: complete web dashboard — all pages, build, integration"
git push
```
