const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const { CONFIG } = require('./payment');
const DISCORD_TOKEN = CONFIG.discordToken || '';
const CHANNEL_ID = CONFIG.discordChannelId || '';
const HUB_MESSAGE_ID = CONFIG.discordMessageId || '';
const GUILD_ID = CONFIG.discordGuildId || '';
const APP_ID = CONFIG.discordAppId || '';

const SESSIONS_DIR = path.join(__dirname, 'sessions');
const RESULTS_FILE = path.join(__dirname, 'discord-results.json');
const API_BASE = 'https://discord.com/api/v9';

const superProps = Buffer.from(JSON.stringify({
  os: 'Windows', browser: 'Chrome', device: '',
  browser_user_agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  browser_version: '131.0.0.0', os_version: '10',
  release_channel: 'stable', client_build_number: 335978,
})).toString('base64');

const headers = {
  'Authorization': DISCORD_TOKEN,
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'X-Super-Properties': superProps,
};

function nonce() {
  return String(BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)));
}

// ========== Gateway ==========

function connectGateway() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json');
    let hb = null, seq = null, sessionId = null;
    const eventHandlers = {};

    function on(event, fn) {
      if (!eventHandlers[event]) eventHandlers[event] = [];
      eventHandlers[event].push(fn);
    }
    function off(event, fn) {
      const arr = eventHandlers[event] || [];
      const i = arr.indexOf(fn);
      if (i !== -1) arr.splice(i, 1);
    }

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.s) seq = msg.s;

      if (msg.op === 10) {
        hb = setInterval(() => ws.send(JSON.stringify({ op: 1, d: seq })), msg.d.heartbeat_interval);
        ws.send(JSON.stringify({
          op: 2,
          d: { token: DISCORD_TOKEN, properties: { os: 'Windows', browser: 'Chrome', device: '' }, presence: { status: 'online', afk: false } },
        }));
      }

      if (msg.op === 0 && msg.t === 'READY') {
        sessionId = msg.d.session_id;
        resolve({ ws, sessionId, on, off, cleanup: () => { clearInterval(hb); ws.close(); } });
      }

      if (msg.op === 0 && msg.t) {
        for (const fn of (eventHandlers[msg.t] || [])) fn(msg.d);
      }
    });

    ws.on('error', reject);
    setTimeout(() => reject(new Error('Gateway timeout')), 30000);
  });
}

function waitFor(gw, event, filter, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { gw.off(event, handler); reject(new Error(`Timeout: ${event}`)); }, timeoutMs);
    function handler(data) {
      if (filter(data)) {
        clearTimeout(timer);
        gw.off(event, handler);
        resolve(data);
      }
    }
    gw.on(event, handler);
  });
}

function waitForAny(gw, events, filter, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Timeout: ${events.join(',')}`)); }, timeoutMs);
    const handlers = {};
    function cleanup() { clearTimeout(timer); for (const e of events) gw.off(e, handlers[e]); }
    for (const event of events) {
      handlers[event] = (data) => {
        if (filter(data)) { cleanup(); resolve(data); }
      };
      gw.on(event, handlers[event]);
    }
  });
}

async function interact(payload) {
  const res = await fetch(`${API_BASE}/interactions`, { method: 'POST', headers, body: JSON.stringify(payload) });
  if (res.status !== 204 && res.status !== 200) {
    throw new Error(`Interaction ${res.status}: ${await res.text()}`);
  }
}

// ========== Core Flow ==========

async function processToken(gw, accessToken, email) {
  // Step 1: Click hub:chatgpt to get the region menu
  console.log(`  [1/4] Opening region menu...`);
  const menuPromise = waitFor(gw, 'MESSAGE_CREATE', (d) => d.author?.bot && d.components?.length > 0, 15000);

  await interact({
    type: 3, nonce: nonce(),
    guild_id: GUILD_ID, channel_id: CHANNEL_ID,
    message_flags: 0, message_id: HUB_MESSAGE_ID,
    application_id: APP_ID, session_id: gw.sessionId,
    data: { component_type: 2, custom_id: 'hub:chatgpt' },
  });

  const menu = await menuPromise;

  // Step 2: Find and click "美区 PLUS（免费试用）"
  let targetBtnId = null;
  for (const row of (menu.components || [])) {
    for (const c of (row.components || [])) {
      if (c.label && c.label.includes('美区') && c.label.includes('PLUS') && c.label.includes('免费试用')) {
        targetBtnId = c.custom_id;
      }
    }
  }
  if (!targetBtnId) throw new Error('US Plus free trial button not found');

  console.log(`  [2/4] Clicking US Plus free trial...`);
  const modalPromise = waitFor(gw, 'INTERACTION_MODAL_CREATE', () => true, 15000);

  await new Promise((r) => setTimeout(r, 1500));
  await interact({
    type: 3, nonce: nonce(),
    guild_id: GUILD_ID, channel_id: CHANNEL_ID,
    message_flags: 64, message_id: menu.id,
    application_id: APP_ID, session_id: gw.sessionId,
    data: { component_type: 2, custom_id: targetBtnId },
  });

  const modal = await modalPromise;

  // Step 3: Submit modal with accessToken
  console.log(`  [3/4] Submitting accessToken...`);
  const modalComponents = modal.components.map((row) => ({
    type: row.type,
    components: row.components.map((field) => ({
      type: field.type,
      custom_id: field.custom_id,
      value: accessToken,
    })),
  }));

  // Bot replies via MESSAGE_UPDATE (ephemeral edit) with embed containing the link
  const resultPromise = waitForAny(gw,
    ['MESSAGE_UPDATE', 'MESSAGE_CREATE'],
    (d) => {
      if (d.channel_id !== CHANNEL_ID) return false;
      if (!d.author?.bot) return false;
      const text = JSON.stringify(d.embeds || []) + (d.content || '');
      return text.includes('pay.openai.com') || text.includes('试用链接') || text.includes('失败') || text.includes('Fail') || text.includes('error') || text.includes('积分不足') || text.includes('资格');
    },
    60000
  );

  await interact({
    type: 5, nonce: nonce(),
    guild_id: GUILD_ID, channel_id: CHANNEL_ID,
    application_id: modal.application.id, session_id: gw.sessionId,
    data: { id: modal.id, custom_id: modal.custom_id, components: modalComponents },
  });

  // Step 4: Wait for bot response
  console.log(`  [4/4] Waiting for bot response...`);
  const result = await resultPromise;

  const allText = (result.content || '') + ' ' + JSON.stringify(result.embeds || []);
  // Extract URL from inside spoiler tags ||url|| or plain text
  const urlMatch = allText.match(/https:\/\/pay\.openai\.com[^\s"\\|)]+/);
  const link = urlMatch ? urlMatch[0] : null;

  if (link) {
    const title = result.embeds?.[0]?.title || '';
    console.log(`  [4/4] ${title} - Link received!`);
    return { link, raw: title };
  } else {
    const errText = result.embeds?.[0]?.description || result.content || '';
    console.log(`  [4/4] Response: ${errText.slice(0, 200)}`);
    return { link: null, raw: errText.slice(0, 500) };
  }
}

// ========== Main ==========

async function main() {
  const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  const sessions = files
    .map((f) => JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8')))
    .filter((s) => s.accessToken);

  if (sessions.length === 0) {
    console.log('No sessions found. Run index.js first.');
    process.exit(1);
  }

  console.log(`Found ${sessions.length} tokens to process.\n`);
  console.log('Connecting to Discord Gateway...');
  const gw = await connectGateway();
  console.log('Connected!\n');

  const results = [];

  try {
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      const p = `[${i + 1}/${sessions.length}]`;
      console.log(`${p} ${s.email}`);

      try {
        const result = await processToken(gw, s.accessToken, s.email);
        results.push({ email: s.email, status: result.link ? 'SUCCESS' : 'NO_LINK', paymentLink: result.link || '', raw: result.raw });
        console.log(`${p} ${s.email} - ${result.link ? 'OK' : 'NO LINK'}\n`);
      } catch (err) {
        results.push({ email: s.email, status: 'ERROR', paymentLink: '', raw: err.message });
        console.log(`${p} ${s.email} - ERROR: ${err.message}\n`);
      }

      if (i < sessions.length - 1) {
        const delay = 8000 + Math.random() * 7000;
        console.log(`  Wait ${(delay / 1000).toFixed(0)}s...\n`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  } finally {
    gw.cleanup();
  }

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));

  console.log('\n========== Results ==========');
  const ok = results.filter((r) => r.status === 'SUCCESS').length;
  console.log(`  Success: ${ok} / ${results.length}`);
  console.log(`  Saved to: ${RESULTS_FILE}`);
  if (ok > 0) {
    console.log('\nPayment Links:');
    for (const r of results.filter((r) => r.paymentLink)) {
      console.log(`  ${r.email}: ${r.paymentLink}`);
    }
  }
  console.log('=============================\n');
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
