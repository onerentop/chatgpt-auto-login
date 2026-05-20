// Discord Gateway + payment link fetching (shared by both engines)
const WebSocket = require('ws');
const { CONFIG: PAY_CONFIG } = require('../payment');

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
  'Authorization': DISCORD_TOKEN,
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'X-Super-Properties': superProps,
};

function nn() {
  return String(BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)));
}

function connectGateway() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://gateway.discord.gg/?v=9&encoding=json');
    let hb = null, seq = null, sessionId = null;
    const eh = {};
    function on(e, f) { if (!eh[e]) eh[e] = []; eh[e].push(f); }
    function off(e, f) { const a = eh[e] || []; const i = a.indexOf(f); if (i !== -1) a.splice(i, 1); }
    const gwTimeout = setTimeout(() => { if (hb) clearInterval(hb); ws.close(); reject(new Error('Gateway timeout')); }, 30000);
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.s) seq = m.s;
      if (m.op === 10) {
        hb = setInterval(() => ws.send(JSON.stringify({ op: 1, d: seq })), m.d.heartbeat_interval);
        ws.send(JSON.stringify({ op: 2, d: { token: DISCORD_TOKEN, properties: { os: 'Windows', browser: 'Chrome', device: '' }, presence: { status: 'online', afk: false } } }));
      }
      if (m.op === 0 && m.t === 'READY') {
        clearTimeout(gwTimeout);
        sessionId = m.d.session_id;
        ws.removeAllListeners('error');
        ws.on('error', (err) => console.log(`[Gateway] WS error: ${err.message}`));
        resolve({ ws, sessionId, on, off, cleanup: () => { clearInterval(hb); ws.close(); } });
      }
      if (m.op === 0 && m.t) { for (const f of (eh[m.t] || [])) f(m.d); }
    });
    ws.on('error', reject);
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
  for (const r of (menu.components || [])) {
    for (const c of (r.components || [])) {
      if (c.label?.includes('美区') && c.label?.includes('PLUS') && c.label?.includes('免费试用')) btnId = c.custom_id;
    }
  }
  if (!btnId) throw new Error('US Plus button not found');
  const modalP = waitFor(gw, 'INTERACTION_MODAL_CREATE', () => true, 15000);
  await new Promise(r => setTimeout(r, 1500));
  await interact({ type: 3, nonce: nn(), guild_id: GUILD_ID, channel_id: CHANNEL_ID, message_flags: 64, message_id: menu.id, application_id: APP_ID, session_id: gw.sessionId, data: { component_type: 2, custom_id: btnId } });
  const modal = await modalP;
  const comps = modal.components.map((r) => ({
    type: r.type,
    components: r.components.map((f) => ({ type: f.type, custom_id: f.custom_id, value: accessToken })),
  }));
  const resultP = waitForAny(gw, ['MESSAGE_UPDATE', 'MESSAGE_CREATE'], (d) => {
    if (d.channel_id !== CHANNEL_ID || !d.author?.bot) return false;
    const t = JSON.stringify(d.embeds || []) + (d.content || '');
    return t.includes('pay.openai.com') || t.includes('试用链接') || t.includes('失败') || t.includes('Fail') || t.includes('积分不足') || t.includes('资格');
  }, 60000);
  await new Promise(r => setTimeout(r, 1000));
  await interact({ type: 5, nonce: nn(), guild_id: GUILD_ID, channel_id: CHANNEL_ID, application_id: modal.application.id, session_id: gw.sessionId, data: { id: modal.id, custom_id: modal.custom_id, components: comps } });
  const result = await resultP;
  const all = (result.content || '') + ' ' + JSON.stringify(result.embeds || []);
  const linkMatch = all.match(/https:\/\/pay\.openai\.com[^\s"\\|)]+/);
  const title = result.embeds?.[0]?.title || '';
  if (title) console.log(`[Discord] Title: ${title}`);
  if (!linkMatch) {
    console.log(`[Discord] No link found. Content: ${(result.content || '').slice(0, 150)}`);
    console.log(`[Discord] Embeds: ${JSON.stringify(result.embeds || []).slice(0, 300)}`);
  }
  return {
    link: linkMatch ? linkMatch[0] : '',
    title: result.embeds?.[0]?.title || '',
    raw: result.embeds?.[0]?.description || result.content || '',
  };
}

module.exports = { connectGateway, waitFor, waitForAny, interact, getPaymentLink };
