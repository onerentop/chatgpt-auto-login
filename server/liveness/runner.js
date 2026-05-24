// server/liveness/runner.js
// Batch dispatcher for liveness probes. Pure orchestration: takes injectable
// checker / lightLogin / codexFile / statusDB / io.

const CONCURRENCY = 3;
const THROTTLE_MS = 1_000;

const REASON_MAX = 60;
function clipReason(s) { return String(s || '').slice(0, REASON_MAX); }

const SUMMARY_KEYS = ['plus', 'canceled', 'login_fail', 'token_expired', 'proxy_error', 'network_error', 'unknown'];

function emptySummary() {
  const s = {};
  for (const k of SUMMARY_KEYS) s[k] = 0;
  return s;
}

function createRunner({ io, statusDB, accountsDB, checker, lightLogin, codexFile, config }) {
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

  async function dispatchOne(email) {
    if (state.abortCtrl?.signal.aborted) return;
    const account = accountsDB.get(email);
    if (!account) { state.done++; state.failed++; io.emit('liveness-progress', { done: state.done, total: state.total, failed: state.failed }); return; }

    io.emit('liveness-status', { email, alive_status: 'checking', alive_reason: '' });
    statusDB.setAlive(email, { alive_status: 'checking', alive_reason: '' });

    let result;
    try {
      const existing = await codexFile.read(email);
      const tok = existing?.access_token || '';

      let probeRes = null;
      if (tok) probeRes = await checker.probe(tok, { signal: state.abortCtrl.signal });

      const needsRelogin = !tok || (probeRes && probeRes.alive_status === 'token_expired');
      if (needsRelogin) {
        try {
          const fresh = await lightLogin(account, {
            protocolMode: config.protocolMode,
            signal: state.abortCtrl.signal,
          });
          await codexFile.write(email, {
            accessToken: fresh.accessToken,
            accountId: fresh.accountId,
            expiresAtIso: fresh.expiresAtIso,
          });
          probeRes = await checker.probe(fresh.accessToken, { signal: state.abortCtrl.signal });
        } catch (e) {
          const msg = String(e?.message || e);
          if (e?.name === 'LivenessLoginNotImplementedError' || /not.*implemented/i.test(msg)) {
            result = { alive_status: 'login_fail', alive_reason: 'liveness not yet supported in protocol mode' };
          } else if (/bad password/i.test(msg)) result = { alive_status: 'login_fail', alive_reason: 'bad password' };
          else if (/no password/i.test(msg)) result = { alive_status: 'login_fail', alive_reason: 'no password' };
          else if (/outlook oauth missing/i.test(msg)) result = { alive_status: 'login_fail', alive_reason: 'outlook oauth missing' };
          else if (/otp/i.test(msg)) result = { alive_status: 'login_fail', alive_reason: msg.includes('timeout') ? 'otp timeout' : 'otp fail' };
          else if (/captcha/i.test(msg)) result = { alive_status: 'login_fail', alive_reason: 'captcha' };
          else if (/no session/i.test(msg)) result = { alive_status: 'login_fail', alive_reason: 'no session after login' };
          else if (/proxy reset|ECONNRESET/i.test(msg)) result = { alive_status: 'proxy_error', alive_reason: 'proxy reset (login)' };
          else result = { alive_status: 'network_error', alive_reason: `unexpected: ${msg.slice(0, 40)}` };
        }
      }
      if (!result) result = probeRes || { alive_status: 'network_error', alive_reason: 'no probe result' };
    } catch (e) {
      result = { alive_status: 'network_error', alive_reason: `unexpected: ${String(e?.message || e).slice(0, 40)}` };
    }

    if (state.abortCtrl?.signal.aborted) return;
    result.alive_reason = clipReason(result.alive_reason);
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
