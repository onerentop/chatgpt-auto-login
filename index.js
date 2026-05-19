const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const readline = require('readline');
const WebSocket = require('ws');
const { chromium } = require('playwright');
const { loadAccounts, saveResult, saveSessionData, saveCPAAuthFile, fetchTokensViaPKCE, randomDelay } = require('./utils');
const { loginAccount } = require('./login');
const { autoPayment } = require('./payment');
const { registerToCPA } = require('./cpa');

// ========== Config ==========
const CSV_PATH = path.join(__dirname, 'accounts.csv');
const RESULTS_PATH = path.join(__dirname, 'results.csv');
const SESSIONS_DIR = path.join(__dirname, 'sessions');
const DISCORD_RESULTS = path.join(__dirname, 'discord-results.json');

const { CONFIG: PAY_CONFIG } = require('./payment');
const DISCORD_TOKEN = PAY_CONFIG.discordToken || '';
const CHANNEL_ID = PAY_CONFIG.discordChannelId || '';
const HUB_MESSAGE_ID = PAY_CONFIG.discordMessageId || '';
const GUILD_ID = PAY_CONFIG.discordGuildId || '';
const APP_ID = PAY_CONFIG.discordAppId || '';
const API_BASE = 'https://discord.com/api/v9';

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
];

// ========== Chrome ==========
function findChrome() {
  for (const p of CHROME_PATHS) if (fs.existsSync(p)) return p;
  return null;
}

function launchChrome(port, tempDir) {
  return spawn(findChrome(), [
    `--remote-debugging-port=${port}`, '--incognito',
    `--user-data-dir=${tempDir}`, '--no-first-run',
    '--no-default-browser-check', '--disable-default-apps',
    '--disable-popup-blocking', '--window-size=960,540', '--window-position=0,0', 'about:blank',
  ], { stdio: 'ignore', detached: false });
}

async function waitForCDP(port) {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`); }
    catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  throw new Error('CDP timeout');
}

function waitForEnter(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => { rl.close(); resolve(); });
  });
}

// ========== Discord Gateway ==========
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
      if (m.op === 0 && m.t === 'READY') {
        sessionId = m.d.session_id;
        resolve({ ws, sessionId, on, off, cleanup: () => { clearInterval(hb); ws.close(); } });
      }
      if (m.op === 0 && m.t) for (const f of (eh[m.t] || [])) f(m.d);
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
    const t = setTimeout(() => { cleanup(); reject(new Error(`Timeout`)); }, ms);
    const hs = {};
    function cleanup() { clearTimeout(t); for (const e of events) gw.off(e, hs[e]); }
    for (const e of events) {
      hs[e] = (d) => { if (filter(d)) { cleanup(); resolve(d); } };
      gw.on(e, hs[e]);
    }
  });
}

async function interact(body) {
  const r = await fetch(`${API_BASE}/interactions`, { method: 'POST', headers: discordHeaders, body: JSON.stringify(body) });
  if (r.status !== 204 && r.status !== 200) throw new Error(`Interaction ${r.status}: ${await r.text()}`);
}

// ========== Discord: get payment link ==========
async function getPaymentLink(gw, accessToken) {
  // 1. Click hub:chatgpt
  const menuP = waitFor(gw, 'MESSAGE_CREATE', (d) => d.author?.bot && d.components?.length > 0, 15000);
  await interact({ type: 3, nonce: nn(), guild_id: GUILD_ID, channel_id: CHANNEL_ID, message_flags: 0, message_id: HUB_MESSAGE_ID, application_id: APP_ID, session_id: gw.sessionId, data: { component_type: 2, custom_id: 'hub:chatgpt' } });
  const menu = await menuP;

  // 2. Find & click 美区 PLUS（免费试用）
  let btnId = null;
  for (const r of (menu.components || [])) for (const c of (r.components || [])) if (c.label?.includes('美区') && c.label?.includes('PLUS') && c.label?.includes('免费试用')) btnId = c.custom_id;
  if (!btnId) throw new Error('US Plus button not found');

  const modalP = waitFor(gw, 'INTERACTION_MODAL_CREATE', () => true, 15000);
  await new Promise((r) => setTimeout(r, 1500));
  await interact({ type: 3, nonce: nn(), guild_id: GUILD_ID, channel_id: CHANNEL_ID, message_flags: 64, message_id: menu.id, application_id: APP_ID, session_id: gw.sessionId, data: { component_type: 2, custom_id: btnId } });
  const modal = await modalP;

  // 3. Submit token
  const comps = modal.components.map((r) => ({ type: r.type, components: r.components.map((f) => ({ type: f.type, custom_id: f.custom_id, value: accessToken })) }));
  const resultP = waitForAny(gw, ['MESSAGE_UPDATE', 'MESSAGE_CREATE'], (d) => {
    if (d.channel_id !== CHANNEL_ID || !d.author?.bot) return false;
    const t = JSON.stringify(d.embeds || []) + (d.content || '');
    return t.includes('pay.openai.com') || t.includes('试用链接') || t.includes('失败') || t.includes('Fail') || t.includes('积分不足') || t.includes('资格');
  }, 60000);
  await interact({ type: 5, nonce: nn(), guild_id: GUILD_ID, channel_id: CHANNEL_ID, application_id: modal.application.id, session_id: gw.sessionId, data: { id: modal.id, custom_id: modal.custom_id, components: comps } });

  // 4. Extract link
  const res = await resultP;
  const all = (res.content || '') + ' ' + JSON.stringify(res.embeds || []);
  const m = all.match(/https:\/\/pay\.openai\.com[^\s"\\|)]+/);
  return { link: m ? m[0] : null, title: res.embeds?.[0]?.title || '', raw: res.embeds?.[0]?.description || res.content || '' };
}

// ========== Main ==========
async function main() {
  const startIndex = parseStartArg();
  const accounts = loadAccounts(CSV_PATH);
  if (accounts.length === 0) { console.log('No accounts in accounts.csv'); process.exit(1); }
  if (!findChrome()) { console.log('Chrome not found!'); process.exit(1); }
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

  console.log(`Loaded ${accounts.length} accounts. Starting from #${startIndex + 1}.`);
  console.log('Connecting to Discord Gateway...');
  const gw = await connectGateway();
  console.log('Discord connected!\n');

  const allResults = [];
  const basePort = 19222;

  try {
    for (let i = startIndex; i < accounts.length; i++) {
      const account = accounts[i];
      const p = `[${i + 1}/${accounts.length}]`;
      console.log(`${p} === ${account.email} ===`);

      const port = basePort + i;
      const tempDir = path.join(os.tmpdir(), `chatgpt-login-${Date.now()}`);
      let chromeProc = null, browser = null;
      let finalResult = { email: account.email, status: 'ERROR', paymentLink: '', reason: '' };

      try {
        // Phase 1: Login & get accessToken
        console.log(`${p} Phase 1: Login...`);
        chromeProc = launchChrome(port, tempDir);
        browser = await waitForCDP(port);
        const loginResult = await loginAccount(browser, account);
        saveResult(RESULTS_PATH, loginResult);
        saveSessionData(SESSIONS_DIR, loginResult);

        if (loginResult.status !== 'SUCCESS' || !loginResult.accessToken) {
          console.log(`${p} Login failed: ${loginResult.reason || loginResult.status}`);
          finalResult.reason = `Login: ${loginResult.reason || loginResult.status}`;
          allResults.push(finalResult);
          continue;
        }
        console.log(`${p} Login OK, accessToken obtained.`);

        // Check plan type from session
        const planType = loginResult.session?.account?.planType || loginResult.session?.chatgpt_plan_type || 'free';
        const isPlusOrAbove = ['plus', 'pro', 'team', 'enterprise'].includes(planType.toLowerCase());
        console.log(`${p} Plan: ${planType} (${isPlusOrAbove ? 'Plus member' : 'Not Plus'})`);

        const { CONFIG: payConfig } = require('./payment');

        if (isPlusOrAbove) {
          console.log(`${p} Already Plus! Skipping payment flow.`);
          finalResult = { email: account.email, status: 'ALREADY_PLUS', paymentLink: '', reason: '' };

          if (payConfig.enableCPA !== false) {
            console.log(`${p} Phase 4: CPA OAuth...`);
            try {
              const cpaOk = await registerToCPA(browser, account.email, account);
              if (cpaOk) console.log(`${p} CPA OAuth done.`);
              else console.log(`${p} CPA OAuth may have issues, check manually.`);
            } catch (e) {
              console.log(`${p} CPA error: ${e.message}`);
            }
          } else {
            console.log(`${p} CPA OAuth skipped. Running PKCE to get full tokens...`);
            const pkceTokens = await fetchTokensViaPKCE(browser, account, loginResult.lastOtp).catch((e) => { console.log(`  [PKCE] Failed: ${e.message}`); return null; });
            if (pkceTokens) {
              saveCPAAuthFile(account.email, pkceTokens.access_token, pkceTokens);
            } else {
              console.log(`${p} PKCE failed, saving with session token only`);
              saveCPAAuthFile(account.email, loginResult.accessToken, loginResult.session);
            }
          }
        } else {
          // Not Plus → payment flow
          // Phase 2: Discord bot → payment link
          console.log(`${p} Phase 2: Discord bot...`);
          const discord = await getPaymentLink(gw, loginResult.accessToken);

          if (discord.link) {
            console.log(`${p} ${discord.title}`);
            console.log(`${p} Link: ${discord.link.slice(0, 80)}...`);
            finalResult = { email: account.email, status: 'SUCCESS', paymentLink: discord.link, reason: '' };

            // Phase 3: Open payment link & auto-fill
            console.log(`${p} Phase 3: Opening payment page...`);
            const ctx = browser.contexts()[0];
            const pages = ctx.pages();
            const page = pages.length > 0 ? pages[0] : await ctx.newPage();
            await page.goto(discord.link, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await randomDelay(2000, 3000);

            console.log(`${p} Phase 3: Auto-filling payment...`);
            try {
              await autoPayment(page);
            } catch (e) {
              console.log(`${p} Auto-fill error: ${e.message}`);
            }

            console.log(`${p} Payment flow completed. Waiting 10s...`);
            await randomDelay(10000, 12000);

            // Phase 4: CPA OAuth or local auth file
            if (payConfig.enableCPA !== false) {
              console.log(`${p} Phase 4: CPA OAuth...`);
              try {
                const cpaOk = await registerToCPA(browser, account.email, account);
                if (cpaOk) console.log(`${p} CPA OAuth done.`);
                else console.log(`${p} CPA OAuth may have issues, check manually.`);
              } catch (e) {
                console.log(`${p} CPA error: ${e.message}`);
              }
            } else {
              console.log(`${p} CPA OAuth skipped. Running PKCE to get full tokens...`);
              const pkceTokens = await fetchTokensViaPKCE(browser, account, loginResult.lastOtp).catch((e) => { console.log(`  [PKCE] Failed: ${e.message}`); return null; });
              if (pkceTokens) {
                saveCPAAuthFile(account.email, pkceTokens.access_token, pkceTokens);
              } else {
                console.log(`${p} PKCE failed, saving with session token only`);
                saveCPAAuthFile(account.email, loginResult.accessToken, loginResult.session);
              }
            }
          } else {
            console.log(`${p} No link: ${discord.raw.slice(0, 150)}`);
            finalResult = { email: account.email, status: 'NO_LINK', paymentLink: '', reason: discord.raw.slice(0, 200) };
          }
        }
      } catch (error) {
        console.log(`${p} ERROR: ${error.message}`);
        finalResult.reason = error.message.slice(0, 200);
      } finally {
        if (browser) try { await browser.close(); } catch {}
        if (chromeProc) try { chromeProc.kill(); } catch {}
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
      }

      allResults.push(finalResult);
      console.log(`${p} ${account.email} → ${finalResult.status}\n`);

      if (i < accounts.length - 1) {
        const wait = 5 + Math.floor(Math.random() * 5);
        console.log(`  Waiting ${wait}s...\n`);
        await randomDelay(wait * 1000, wait * 1000 + 500);
      }
    }
  } finally {
    gw.cleanup();
  }

  // Save
  fs.writeFileSync(DISCORD_RESULTS, JSON.stringify(allResults, null, 2));

  // Summary
  const ok = allResults.filter((r) => r.status === 'SUCCESS').length;
  const noLink = allResults.filter((r) => r.status === 'NO_LINK').length;
  const err = allResults.filter((r) => r.status === 'ERROR').length;

  console.log('========================================');
  console.log(`  Success: ${ok}  |  No Link: ${noLink}  |  Error: ${err}`);
  console.log(`  Saved to: ${DISCORD_RESULTS}`);
  console.log('========================================');

  if (ok > 0) {
    console.log('\n$0 Payment Links:');
    for (const r of allResults.filter((r) => r.paymentLink)) {
      console.log(`  ${r.email}`);
      console.log(`  ${r.paymentLink}\n`);
    }
  }
}

function parseStartArg() {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--start');
  if (idx !== -1 && args[idx + 1]) { const n = parseInt(args[idx + 1], 10); if (n > 0) return n - 1; }
  return 0;
}

main().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
