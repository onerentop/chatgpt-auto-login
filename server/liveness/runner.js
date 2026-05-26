// server/liveness/runner.js
// Batch dispatcher for liveness probes. Pure orchestration: takes injectable
// checker / lightLogin / codexFile / statusDB / io.

// v2.41.4: 5 并发触发 OpenAI/Cloudflare 限速所有 IP 风控 → 改 1 顺序 + 3s 间隔。
// 慢但稳；用户量大需要并发可手动改这两个常量或后续做 env 配置。
const CONCURRENCY = 1;
const THROTTLE_MS = 3_000;

const REASON_MAX = 60;
function clipReason(s) { return String(s || '').slice(0, REASON_MAX); }

const SUMMARY_KEYS = ['plus', 'canceled', 'deactivated', 'login_fail', 'token_expired', 'proxy_error', 'network_error', 'unknown'];

function emptySummary() {
  const s = {};
  for (const k of SUMMARY_KEYS) s[k] = 0;
  return s;
}

const NETWORK_RETRY_MAX = 3;
const NETWORK_RETRY_DELAY_MS = 2_000;

function createRunner({ io, statusDB, accountsDB, checker, lightLogin, codexFile, config, livenessLogsDB, proxyMgr }) {
  // proxyMgr is optional — lazy-require fallback keeps the production wiring
  // working without explicit injection (mirrors checker.js:12-18 lazy pattern).
  function getProxyMgr() {
    if (proxyMgr) return proxyMgr;
    try { return require('../proxy'); } catch { return null; }
  }
  let state = {
    running: false,
    batchId: null,
    total: 0,
    done: 0,
    failed: 0,
    summary: emptySummary(),
    startedAt: null,
    abortCtrl: null,
    queue: [],
  };

  function snapshot() {
    return {
      running: state.running, batchId: state.batchId, total: state.total,
      done: state.done, summary: { ...state.summary }, startedAt: state.startedAt,
    };
  }

  // Sleep that wakes up early if the runner is aborted.
  function abortableSleep(ms, signal) {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }

  // Single probe → verifyDeactivated → lightLogin pass. Returns a result
  // object {alive_status, alive_reason} without writing to DB or emitting
  // terminal events. Outer dispatchOne wraps this in a retry loop.
  async function dispatchOnceInner(email, account, onLog, abortSignal) {
    let result = null;
    try {
      const existing = await codexFile.read(email);
      const tok = existing?.access_token || '';

      let probeRes = null;
      if (tok) probeRes = await checker.probe(tok, { signal: abortSignal, onLog });

      // Case 2 deactivated detection: when probe returns token_expired, spawn a
      // lightweight Step 0-2 signin (no OTP) to discriminate "token genuinely
      // expired" from "OpenAI revoked the token because they banned the account".
      // verifyDeactivated network errors do NOT override the probe verdict —
      // we stay with token_expired in that case.
      if (probeRes && probeRes.alive_status === 'token_expired') {
        const verifyRes = await checker.verifyDeactivated(account, { signal: abortSignal, onLog });
        if (verifyRes.status === 'deactivated') {
          probeRes = { alive_status: 'deactivated', alive_reason: 'account_deactivated' };
          // After this overwrite, needsRelogin below evaluates to false: tok is
          // present and probeRes.alive_status is now 'deactivated', not
          // 'token_expired'. lightLogin is correctly skipped. If you ever
          // refactor the overwrite, re-verify the needsRelogin gate.
        }
      }

      const needsRelogin = !tok || (probeRes && probeRes.alive_status === 'token_expired');
      if (needsRelogin) {
        try {
          const fresh = await lightLogin(account, {
            protocolMode: config.protocolMode,
            proxyUrl: getProxyMgr()?.getProxyUrl(),
            signal: abortSignal,
          });
          await codexFile.write(email, {
            accessToken: fresh.accessToken,
            accountId: fresh.accountId,
            expiresAtIso: fresh.expiresAtIso,
          });
          probeRes = await checker.probe(fresh.accessToken, { signal: abortSignal, onLog });
        } catch (e) {
          const msg = String(e?.message || e);
          if (e?.name === 'LivenessLoginNotImplementedError' || /not.*implemented/i.test(msg) || /not yet supported/i.test(msg)) {
            // Protocol-mode lightLogin is a stub. If the original probe already
            // gave a real answer (token_expired from 401), preserve it instead
            // of overwriting with a vague "not yet supported" string — the
            // user cares whether the account is dead, not whether our re-login
            // path is implemented yet.
            if (probeRes && probeRes.alive_status === 'token_expired') {
              result = probeRes;
            } else {
              result = { alive_status: 'login_fail', alive_reason: 'liveness not yet supported in protocol mode' };
            }
          } else if (/bad password/i.test(msg)) result = { alive_status: 'login_fail', alive_reason: 'bad password' };
          else if (/no password/i.test(msg)) result = { alive_status: 'login_fail', alive_reason: 'no password' };
          else if (/outlook oauth missing/i.test(msg)) result = { alive_status: 'login_fail', alive_reason: 'outlook oauth missing' };
          else if (/otp/i.test(msg)) result = { alive_status: 'login_fail', alive_reason: msg.includes('timeout') ? 'otp timeout' : 'otp fail' };
          else if (/captcha/i.test(msg)) result = { alive_status: 'login_fail', alive_reason: 'captcha' };
          else if (/no session/i.test(msg)) result = { alive_status: 'login_fail', alive_reason: 'no session after login' };
          else if (/oauth.*\/error|oauth\s*error|OAuth.*redirect/i.test(msg)) {
            result = { alive_status: 'login_fail', alive_reason: 'OAuth /error page' };
          }
          else if (/proxy reset|ECONNRESET/i.test(msg)) result = { alive_status: 'proxy_error', alive_reason: 'proxy reset (login)' };
          else result = { alive_status: 'network_error', alive_reason: `unexpected: ${msg.slice(0, 40)}` };
        }
      }
      if (!result) result = probeRes || { alive_status: 'network_error', alive_reason: 'no probe result' };
    } catch (e) {
      result = { alive_status: 'network_error', alive_reason: `unexpected: ${String(e?.message || e).slice(0, 40)}` };
    }
    return result;
  }

  async function dispatchOne(email) {
    if (state.abortCtrl?.signal.aborted) return;
    const account = accountsDB.get(email);
    if (!account) { state.done++; state.failed++; io.emit('liveness-progress', { done: state.done, total: state.total, failed: state.failed }); return; }

    io.emit('liveness-status', { email, alive_status: 'checking', alive_reason: '' });
    statusDB.setAlive(email, { alive_status: 'checking', alive_reason: '' });

    const onLog = (level, message) => {
      const lvl = level || 'info';
      io.emit('liveness-log', { email, level: lvl, message });
      try { livenessLogsDB?.add({ email, level: lvl, message }); } catch {}
    };

    let result;
    for (let attempt = 1; attempt <= NETWORK_RETRY_MAX; attempt++) {
      if (state.abortCtrl?.signal.aborted) return;
      result = await dispatchOnceInner(email, account, onLog, state.abortCtrl.signal);
      if (result.alive_status !== 'network_error') break;

      // v2.31.1: 每次 net_error attempt 立即 vote bad；blacklisted=true 时 await rotate
      // 切到下一节点（双保险，proxy 内部已 fire-and-forget rotate，这里显式再 await）。
      try {
        const pm = getProxyMgr();
        if (pm && pm.getState().enabled) {
          const currentNode = pm.getState().currentNode;
          if (currentNode) {
            const vote = pm.recordBadAttempt(currentNode, 'main', `liveness_net_error_a${attempt}`);
            if (vote?.blacklisted) {
              try { await pm.rotate?.(); } catch {}
            }
          }
        }
      } catch {}

      if (attempt < NETWORK_RETRY_MAX) {
        onLog('warning', `network_error: ${result.alive_reason} — retrying ${attempt}/${NETWORK_RETRY_MAX} in ${NETWORK_RETRY_DELAY_MS / 1000}s`);
        await abortableSleep(NETWORK_RETRY_DELAY_MS, state.abortCtrl.signal);
      }
    }

    if (state.abortCtrl?.signal.aborted) return;

    // If the execution pipeline already determined this account is
    // OpenAI-banned (status='deactivated'), surface that as alive_status
    // 'deactivated' even though the probe returned 401 / token_expired.
    // A 401 on a deactivated account is just confirmation, not a separate
    // "token problem" — let the UI show 已删除 in both dimensions.
    try {
      const persisted = statusDB.get(email);
      if (persisted?.status === 'deactivated' && (result.alive_status === 'token_expired' || result.alive_status === 'login_fail')) {
        result = { alive_status: 'deactivated', alive_reason: 'account_deactivated' };
      }
    } catch {}

    // v2.31.1: bad vote 已在 retry loop 内逐 attempt 投出；此处仅 good vote
    // 负责终态非 net_error 时清空 failCount。proxy_error 本应 retry 但当前
    // break 条件只看 network_error —— proxy_error 不在此投 bad（YAGNI，
    // 实际由 sing-box 自己判定，retry 翻盘概率极低）。
    try {
      const pm = getProxyMgr();
      if (pm && pm.getState().enabled) {
        const currentNode = pm.getState().currentNode;
        if (currentNode) {
          if (
            result.alive_status === 'plus' ||
            result.alive_status === 'canceled' ||
            result.alive_status === 'token_expired' ||
            result.alive_status === 'login_fail' ||
            result.alive_status === 'deactivated'
          ) {
            pm.recordGoodAttempt(currentNode, 'main');
          }
        }
      }
    } catch {}

    result.alive_reason = clipReason(result.alive_reason);

    // v2.32.0: 把 alive 终态同步到 status 字段（Execute.vue 可见）。
    // 测活是 ground truth —— 用户跑测活就是想刷新视图，按映射表无条件
    // 覆盖 status；唯一例外：alive=plus 且 status=plus_no_rt 时保留
    // plus_no_rt（plus_no_rt 含"Plus 但没拿到 refresh_token"语义，alive=plus
    // 验证不到 RT 状态，不该降级覆盖）。
    try {
      const aliveToStatus = {
        plus: 'plus',
        deactivated: 'deactivated',
        canceled: 'canceled',
        token_expired: 'token_expired',
        login_fail: 'login_fail',
      };
      const mapped = aliveToStatus[result.alive_status];
      if (mapped) {
        const persisted = statusDB.get(email);
        const skipDowngrade = (mapped === 'plus' && persisted?.status === 'plus_no_rt');
        if (!skipDowngrade) {
          statusDB.set(email, {
            status: mapped,
            phase: '',
            progress: 0,
            reason: result.alive_reason || '',
          });
          io.emit('account-status', {
            email,
            status: mapped,
            phase: '',
            progress: 0,
            reason: result.alive_reason || '',
          });
        }
      }
    } catch {}

    statusDB.setAlive(email, result);
    state.done++;
    if (result.alive_status !== 'plus') state.failed++;
    if (state.summary[result.alive_status] !== undefined) state.summary[result.alive_status]++;
    io.emit('liveness-status', { email, alive_status: result.alive_status, alive_reason: result.alive_reason });
    io.emit('liveness-progress', { done: state.done, total: state.total, failed: state.failed });
  }

  async function runBatch(emails) {
    state.queue = emails.slice();
    state.startedAt = new Date().toISOString();

    const workers = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      workers.push((async () => {
        while (state.queue.length > 0 && !state.abortCtrl.signal.aborted) {
          const email = state.queue.shift();
          if (!email) break;
          await dispatchOne(email);
          if (state.queue.length > 0 && !state.abortCtrl.signal.aborted) {
            await new Promise((r) => setTimeout(r, THROTTLE_MS));
          }
        }
      })());
    }
    await Promise.allSettled(workers);
    const durationMs = Date.now() - new Date(state.startedAt).getTime();
    io.emit('liveness-complete', { total: state.total, summary: { ...state.summary }, durationMs });
    state.running = false;
    state.batchId = null;
  }

  function start(emails) {
    if (state.running) throw new Error('liveness already running');
    state = {
      running: true,
      batchId: `batch-${Date.now()}`,
      total: emails.length,
      done: 0,
      failed: 0,
      summary: emptySummary(),
      startedAt: null,
      abortCtrl: new AbortController(),
      queue: [],
    };
    runBatch(emails);
    return { batchId: state.batchId, total: state.total };
  }

  function stop() {
    if (!state.running) return { stopped: 0 };
    const stopped = state.queue.length;
    state.abortCtrl.abort();
    state.queue = [];
    return { stopped };
  }

  return { start, stop, status: snapshot };
}

module.exports = { createRunner };
