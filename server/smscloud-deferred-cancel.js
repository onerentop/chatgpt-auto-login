// v2.45.0 — 扩展：tick 顺带跑 smscloud_phone_cache 过期清理 + cancel rejected entry
// （v2.44.1 的 deferred queue cancel 行为保留）
//
// smscloud 平台要求 "下单 ≥2 分钟" 才能 cancel。OpenAI rate-limited 等场景
// 秒级 fail，直接 cancel 会被平台拒。本模块把 cancel 任务排进 in-memory queue，
// 后台 worker 每 30s 扫描，到 takenAtMs + 125s 后尝试 cancel；失败重试 3 次。
// 进程死掉时 queue 丢失 —— smscloud 平台端最终自然 timeout。
//
// v2.45.0 新增：tick 顺带跑 smscloud-pool.expireOldEntries (清理过期 active entry)
// + 扫 smscloud_phone_cache 中 status='rejected' 的行调 cancelOrder 并删除。

const READY_DELAY_MS = 125_000;
const TICK_INTERVAL_MS = 30_000;
const MAX_ATTEMPTS = 3;
const EXPIRY_MS = 18 * 60 * 1000;

const _queue = new Map();  // orderNo -> { apiKey, baseUrl, orderNo, takenAtMs, attempts }
let _timer = null;
let _ticking = false;
let _getDb = null;

function enqueue({ apiKey, baseUrl, orderNo, takenAtMs }) {
  if (!orderNo) return;
  if (_queue.has(orderNo)) return;
  _queue.set(orderNo, { apiKey, baseUrl, orderNo, takenAtMs, attempts: 0 });
  console.log(`[smscloud-deferred-cancel] enqueued orderNo=${orderNo} takenAtMs=${takenAtMs}`);
}

async function _processDeferredQueue() {
  const smscloud = require('./smscloud-provider');
  const now = Date.now();
  for (const entry of [..._queue.values()]) {
    if (now < entry.takenAtMs + READY_DELAY_MS) continue;
    entry.attempts++;
    try {
      await smscloud.cancelOrder(entry.orderNo, entry.apiKey, entry.baseUrl);
      _queue.delete(entry.orderNo);
      console.log(`[smscloud-deferred-cancel] cancelled orderNo=${entry.orderNo} ok`);
    } catch (e) {
      console.log(`[smscloud-deferred-cancel] cancel orderNo=${entry.orderNo} attempt=${entry.attempts}/${MAX_ATTEMPTS} failed: ${e?.message?.slice(0, 200)}`);
      if (entry.attempts >= MAX_ATTEMPTS) {
        _queue.delete(entry.orderNo);
        console.log(`[smscloud-deferred-cancel] dropped orderNo=${entry.orderNo} after ${MAX_ATTEMPTS} attempts`);
      }
    }
  }
}

async function _processCacheMaintenance(getDb) {
  if (!getDb) return;
  let db;
  try { db = getDb(); } catch { return; }
  if (!db) return;
  const smscloudPool = require('./smscloud-pool');
  const smscloud = require('./smscloud-provider');
  // 1) 过期 active entry 清理
  try {
    const r = smscloudPool.expireOldEntries(db, EXPIRY_MS);
    if (r.expired > 0) console.log(`[smscloud-deferred-cancel] expired ${r.expired} cache entry(s)`);
  } catch (e) { console.log(`[smscloud-deferred-cancel] expire err: ${e?.message?.slice(0, 200)}`); }
  // 2) rejected entry 调 cancelOrder + 删
  let rejectedRows;
  try {
    rejectedRows = db.exec("SELECT order_no, api_key, base_url, taken_at_ms FROM smscloud_phone_cache WHERE status='rejected'");
  } catch (e) { console.log(`[smscloud-deferred-cancel] query rejected err: ${e?.message?.slice(0, 200)}`); return; }
  if (!rejectedRows.length || !rejectedRows[0].values.length) return;
  for (const [orderNo, apiKey, baseUrl, takenAtMs] of rejectedRows[0].values) {
    if (Date.now() < takenAtMs + READY_DELAY_MS) {
      enqueue({ apiKey, baseUrl, orderNo, takenAtMs });
      continue;
    }
    try {
      const r = await smscloud.cancelOrder(orderNo, apiKey, baseUrl);
      if (r && r.deferred) {
        enqueue({ apiKey, baseUrl, orderNo, takenAtMs });
        continue;
      }
      db.run("DELETE FROM smscloud_phone_cache WHERE order_no = ?", [orderNo]);
      console.log(`[smscloud-deferred-cancel] cancelled+deleted rejected orderNo=${orderNo}`);
    } catch (e) {
      // v2.49: cancel 失败 force-delete cache row 避免无限 spam（脏数据 / 订单已 expire 等）
      // 代价：smscloud 平台订单可能未真正 cancel，但 entry status=rejected 已经不再业务复用，
      // 平台端订单自然 timeout 释放。优于无限 retry log spam。
      console.log(`[smscloud-deferred-cancel] rejected cancel orderNo=${orderNo} failed: ${e?.message?.slice(0, 200)}, force-deleting cache row`);
      try { db.run("DELETE FROM smscloud_phone_cache WHERE order_no = ?", [orderNo]); } catch {}
    }
  }
}

async function _tickOnce(getDb) {
  await _processDeferredQueue();
  await _processCacheMaintenance(getDb || _getDb);
}

function start(getDb) {
  if (_timer) return;
  _getDb = getDb || null;
  _timer = setInterval(async () => {
    if (_ticking) return;
    _ticking = true;
    try { await _tickOnce(_getDb); }
    catch (e) { console.log(`[smscloud-deferred-cancel] tick error: ${e?.message?.slice(0, 200)}`); }
    finally { _ticking = false; }
  }, TICK_INTERVAL_MS);
  _timer.unref?.();
  console.log(`[smscloud-deferred-cancel] started, tick=${TICK_INTERVAL_MS}ms`);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _getDb = null;
}

module.exports = { enqueue, start, stop, _tickOnce, _processDeferredQueue, _processCacheMaintenance, _queueForTest: () => _queue };
