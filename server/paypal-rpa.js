// Spawn paypal_rpa.js (Node child) for isolated PayPal sub-flow.
const { spawn } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'paypal_rpa.js');
// 3 min cap; PayPal SMS + approval can take 30-90s; allow slack for slow PayPal.
const TIMEOUT_MS = 180000;

/**
 * Validate RPA input shape. Used both by runPayPalRpa (defensive) and
 * by unit tests for direct input validation.
 */
function validateRpaInput(input) {
  if (!input || typeof input !== 'object') return 'missing_paypal_url';
  if (typeof input.paypal_url !== 'string' || !input.paypal_url) return 'missing_paypal_url';
  if (!/^https?:\/\/(www\.)?paypal\.com\//.test(input.paypal_url)
      && !/^https?:\/\/pm-redirects\.stripe\.com\//.test(input.paypal_url)) {
    // pm-redirects.stripe.com is Stripe's PayPal handoff prefix (per Task 1 smoke test);
    // forwards to paypal.com after first hop. Accept both.
    return 'invalid_paypal_url';
  }
  if (!input.phone) return 'missing_phone';
  if (!input.sms_api_url) return 'missing_sms_api_url';
  if (!input.approval_url_pattern) return 'missing_approval_url_pattern';
  return null;
}

function parseRpaResponse(parsed) {
  if (!parsed || typeof parsed !== 'object' || !parsed.status) {
    return { ok: false, reason: 'rpa_unparsable' };
  }
  if (parsed.status === 'success') {
    return { ok: true, chatgpt_approval_url: (parsed.data || {}).chatgpt_approval_url };
  }
  return { ok: false, reason: parsed.reason || 'paypal_rpa_error', raw: parsed.detail };
}

function runPayPalRpa(opts) {
  return new Promise((resolve) => {
    const validation = validateRpaInput(opts);
    if (validation) {
      resolve({ ok: false, reason: validation });
      return;
    }

    const node = spawn('node', [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      node.kill();
      resolve({ ok: false, reason: 'rpa_timeout' });
    }, TIMEOUT_MS);

    node.stdout.on('data', (d) => {
      for (const line of d.toString().split('\n').filter((l) => l.trim())) {
        stdout = line;  // last non-empty line is the result
      }
    });
    node.stderr.on('data', (d) => {
      stderr += d.toString();
      const text = d.toString().trim();
      if (text) console.log(`  ${text}`);  // surface RPA log lines to server log
    });
    node.on('error', (e) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ ok: false, reason: 'spawn_error', raw: e.message?.slice(0, 200) });
    });
    node.on('close', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      try { resolve(parseRpaResponse(JSON.parse(stdout))); }
      catch { resolve({ ok: false, reason: 'rpa_unparsable', raw: stderr.slice(-200) }); }
    });
    node.stdin.write(JSON.stringify(opts));
    node.stdin.end();
  });
}

module.exports = { validateRpaInput, parseRpaResponse, runPayPalRpa };
