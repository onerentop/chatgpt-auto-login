// Spawn stripe_init.py to probe Stripe payment_pages/{cs}/init for amount_due.
// Goes through main proxy (US, 7890) — cs_live invoice is locked at creation,
// so the source IP for the init probe doesn't affect amount_due.
const { spawn } = require('child_process');
const path = require('path');
const proxyMgr = require('./proxy');

const SCRIPT = path.join(__dirname, '..', 'stripe_init.py');
const TIMEOUT_MS = 15000;

function extractCsId(link) {
  if (typeof link !== 'string' || !link) return null;
  const m = link.match(/\/c\/pay\/(cs_live_[A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

function parseInitResponse(data) {
  const inv = data && data.invoice;
  if (!inv || typeof inv.amount_due !== 'number') {
    return { ok: false, reason: 'no_invoice' };
  }
  const pm = Array.isArray(data.payment_method_types) ? data.payment_method_types : [];
  const coupons = (inv.total_discount_amounts || [])
    .map(d => d && d.coupon && d.coupon.name)
    .filter(Boolean);
  return {
    ok: true,
    is_free: inv.amount_due === 0,
    amount_due: inv.amount_due,
    currency: inv.currency,
    has_paypal: pm.includes('paypal'),
    coupons,
  };
}

function verifyCheckoutIsFree(link, pk) {
  return new Promise((resolve) => {
    const csId = extractCsId(link);
    if (!csId) {
      resolve({ ok: false, reason: 'invalid_link' });
      return;
    }
    if (typeof pk !== 'string' || !/^pk_live_[A-Za-z0-9]+$/.test(pk)) {
      resolve({ ok: false, reason: 'invalid_pk' });
      return;
    }
    // v2.42: 不再显式传 proxy，stripe_init.py 走 HTTPS_PROXY env (curl_cffi 自动识别)
    // Captured at function entry: if an external caller (e.g., UI Rotate button) rotates
    // mid-call during the up-to-15s Python wait, we'll attribute the outcome to the node
    // that was actually used for the Stripe request — not whatever node is current when
    // Python returns. Trade-off: misses the case where rotation IS the right node to
    // blame (rare, requires external concurrent action; engine flows are sequential).
    const currentNode = proxyMgr.getState().currentNode || '';
    const reportFail = (reason) => {
      if (currentNode && proxyMgr.getState().enabled) {
        try { proxyMgr.recordBadAttempt(currentNode, 'main', reason); } catch {}
      }
    };
    const reportOk = () => {
      if (currentNode && proxyMgr.getState().enabled) {
        try { proxyMgr.recordGoodAttempt(currentNode, 'main'); } catch {}
      }
    };
    const py = spawn('py', ['-3', SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      py.kill();
      reportFail('stripe_init_timeout');
      resolve({ ok: false, reason: 'stripe_init_timeout' });
    }, TIMEOUT_MS);

    py.stdout.on('data', (data) => {
      for (const line of data.toString().split('\n').filter(l => l.trim())) {
        try {
          const p = JSON.parse(line);
          if (p.log) console.log(p.log);
          else stdout = line;
        } catch {
          stdout = line;
        }
      }
    });
    py.stderr.on('data', (data) => { stderr += data.toString(); });
    py.on('error', (e) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      // spawn_error = 本地 Python 问题，不是节点问题，不调 reportFail
      resolve({ ok: false, reason: 'spawn_error', raw: e.message?.slice(0, 200) });
    });
    py.on('close', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      let parsed;
      try { parsed = JSON.parse(stdout); }
      catch {
        reportFail('stripe_init_unparsable');
        resolve({ ok: false, reason: 'stripe_init_unparsable', raw: stderr.slice(-200) });
        return;
      }
      if (parsed.status !== 'success') {
        const reason = parsed.reason || 'stripe_init_error';
        reportFail(reason);
        if (/init_http_40[13]/.test(reason)) {
          resolve({ ok: false, reason: 'stripe_init_403' });
          return;
        }
        resolve({ ok: false, reason });
        return;
      }
      // G5: 节点可达 + Stripe 响应解析成功
      reportOk();
      resolve(parseInitResponse(parsed.data));
    });
    py.stdin.write(JSON.stringify({ cs_id: csId, pk }));
    py.stdin.end();
  });
}

module.exports = { extractCsId, parseInitResponse, verifyCheckoutIsFree };
