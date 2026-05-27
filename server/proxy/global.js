// server/proxy/global.js
// 必须在所有其他 require 之前被 require — setGlobalDispatcher 必须在
// 第一次 fetch 之前调用，env 必须在 child_process.spawn 之前设置。
const fs = require('fs');
const path = require('path');
const { setGlobalDispatcher, EnvHttpProxyAgent } = require('undici');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config.json'), 'utf-8'));
  } catch { return {}; }
}

const config = loadConfig();
const SINGBOX_PORT = config.proxy?.localPort || 7890;
const SINGBOX_PROXY = `http://127.0.0.1:${SINGBOX_PORT}`;

if (process.env.HTTPS_PROXY && process.env.HTTPS_PROXY !== SINGBOX_PROXY) {
  console.warn(
    `[Proxy] 忽略继承的 HTTPS_PROXY=${process.env.HTTPS_PROXY}（可能来自系统代理 / Clash）— ` +
    `强制覆盖为 sing-box ${SINGBOX_PROXY}`
  );
}

process.env.HTTPS_PROXY = SINGBOX_PROXY;
process.env.HTTP_PROXY = SINGBOX_PROXY;
process.env.NO_PROXY = '127.0.0.1,localhost,.local';

// v2.50.2: IMAP_DIRECT — Python IMAP poll 跳过 sing-box 走直连
// 默认 true（直连 outlook.office365.com:993 更稳；sing-box 某些 outbound 节点
// 对 :993 端口转发 SSL 握手会 timeout）。config.imapDirect = false 显式切回 sing-box。
if (config.imapDirect !== false) {
  process.env.IMAP_DIRECT = '1';
}

setGlobalDispatcher(new EnvHttpProxyAgent());

module.exports = { SINGBOX_PROXY, SINGBOX_PORT };
