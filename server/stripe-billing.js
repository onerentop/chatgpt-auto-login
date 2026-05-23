// Spawn stripe_billing.py to POST Stripe confirm endpoint via main proxy (7890 US).
// Returns the PayPal redirect URL for Phase 3b RPA.
const { spawn } = require('child_process');
const path = require('path');
const proxyMgr = require('./proxy');

const SCRIPT = path.join(__dirname, '..', 'stripe_billing.py');
// 3-POST chain (init → payment_methods → confirm); 25s covers worst-case Stripe latency.
const TIMEOUT_MS = 25000;

/**
 * Validate billing input shape. Used both by submitStripeBilling (defensive,
 * after payLink regex already extracts a valid cs_id) and by unit tests for
 * direct input validation.
 */
function validateBillingInput(input) {
  if (!input || typeof input !== 'object') return 'invalid_link';
  const cs = input.cs_id;
  const pk = input.pk;
  if (typeof cs !== 'string' || !/^cs_live_[A-Za-z0-9]+$/.test(cs)) return 'invalid_link';
  if (typeof pk !== 'string' || !/^pk_live_[A-Za-z0-9]+$/.test(pk)) return 'invalid_pk';
  return null;
}

function parseStripeResponse(parsed) {
  if (!parsed || typeof parsed !== 'object' || !parsed.status) {
    return { ok: false, reason: 'stripe_billing_unparsable' };
  }
  if (parsed.status === 'success') {
    const data = parsed.data || {};
    return {
      ok: true,
      paypal_redirect_url: data.paypal_redirect_url,
      payment_intent_id: data.payment_intent_id || null,
    };
  }
  return { ok: false, reason: parsed.reason || 'stripe_billing_error', raw: parsed.body };
}

function submitStripeBilling(payLink, pk, billing) {
  return new Promise((resolve) => {
    const csMatch = (payLink || '').match(/\/c\/pay\/(cs_live_[A-Za-z0-9]+)/);
    if (!csMatch) {
      resolve({ ok: false, reason: 'invalid_link' });
      return;
    }
    const input = {
      cs_id: csMatch[1],
      pk,
      country: billing.country || 'US',
      currency: billing.currency || 'USD',
      street: billing.street,
      city: billing.city,
      state: billing.state,
      zip: billing.zip,
      name: billing.name || 'Stripe Customer',
      email: billing.email || `customer-${Date.now()}@example.com`,
      proxy: proxyMgr.getProxyUrl() || '',
    };
    const validation = validateBillingInput(input);
    if (validation) {
      resolve({ ok: false, reason: validation });
      return;
    }

    const py = spawn('py', ['-3', SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      py.kill();
      resolve({ ok: false, reason: 'stripe_billing_timeout' });
    }, TIMEOUT_MS);

    py.stdout.on('data', (d) => {
      for (const line of d.toString().split('\n').filter((l) => l.trim())) {
        try {
          const p = JSON.parse(line);
          if (p.log) console.log(p.log);
          else stdout = line;
        } catch {
          stdout = line;
        }
      }
    });
    py.stderr.on('data', (d) => { stderr += d.toString(); });
    py.on('error', (e) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ ok: false, reason: 'spawn_error', raw: e.message?.slice(0, 200) });
    });
    py.on('close', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      try { resolve(parseStripeResponse(JSON.parse(stdout))); }
      catch { resolve({ ok: false, reason: 'stripe_billing_unparsable', raw: stderr.slice(-200) }); }
    });
    py.stdin.write(JSON.stringify(input));
    py.stdin.end();
  });
}

module.exports = { validateBillingInput, parseStripeResponse, submitStripeBilling };
