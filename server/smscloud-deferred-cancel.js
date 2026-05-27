// v2.44.1 — smscloud cancelOrder 延迟兜底
// smscloud 平台要求 "下单 ≥2 分钟" 才能 cancel。OpenAI rate-limited 等场景
// 秒级 fail，直接 cancel 会被平台拒。本模块把 cancel 任务排进 in-memory queue，
// 后台 worker 每 30s 扫描，到 takenAtMs + 125s 后尝试 cancel；失败重试 3 次。
// 进程死掉时 queue 丢失 —— smscloud 平台端最终自然 timeout。

const READY_DELAY_MS = 125_000;
const TICK_INTERVAL_MS = 30_000;
const MAX_ATTEMPTS = 3;

const _queue = new Map();  // orderNo -> { apiKey, baseUrl, orderNo, takenAtMs, attempts }
let _timer = null;

function enqueue({ apiKey, baseUrl, orderNo, takenAtMs }) {
  if (!orderNo) return;
  if (_queue.has(orderNo)) return;
  _queue.set(orderNo, { apiKey, baseUrl, orderNo, takenAtMs, attempts: 0 });
  console.log(`[smscloud-deferred-cancel] enqueued orderNo=${orderNo} takenAtMs=${takenAtMs}`);
}

async function _tickOnce() {
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

function start() {
  if (_timer) return;
  _timer = setInterval(() => { _tickOnce().catch(() => {}); }, TICK_INTERVAL_MS);
  _timer.unref?.();
  console.log(`[smscloud-deferred-cancel] started, tick=${TICK_INTERVAL_MS}ms`);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { enqueue, start, stop, _tickOnce, _queueForTest: () => _queue };
