// Spawn manual_approval.py to confirm ChatGPT Plus subscription activation.
const { spawn } = require('child_process');
const path = require('path');
const proxyMgr = require('./proxy');

const SCRIPT = path.join(__dirname, '..', 'manual_approval.py');
// > Python's 30s poll cap, plus margin for spawn + first HTTP roundtrip
const TIMEOUT_MS = 45000;

/**
 * Validate approval input shape. Used both by confirmSubscriptionActivation
 * (defensive) and by unit tests for direct input validation.
 */
function validateApprovalInput(input) {
  if (!input || typeof input !== 'object') return 'invalid_access_token';
  if (typeof input.access_token !== 'string' || !input.access_token.startsWith('eyJ')) {
    return 'invalid_access_token';
  }
  if (typeof input.approval_url !== 'string' || !input.approval_url) {
    return 'missing_approval_url';
  }
  return null;
}

function parseApprovalResponse(parsed) {
  if (!parsed || typeof parsed !== 'object' || !parsed.status) {
    return { ok: false, reason: 'approval_unparsable' };
  }
  if (parsed.status === 'success') {
    const data = parsed.data || {};
    return { ok: true, plan_type: data.plan_type, is_subscribed: !!data.is_subscribed };
  }
  return { ok: false, reason: parsed.reason || 'approval_error', raw: parsed.body };
}

function confirmSubscriptionActivation(accessToken, approvalUrl) {
  return new Promise((resolve) => {
    const input = {
      access_token: accessToken,
      approval_url: approvalUrl,
      proxy: proxyMgr.getProxyUrl() || '',
      poll_interval_ms: 2000,
      max_wait_ms: 30000,
    };
    const validation = validateApprovalInput(input);
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
      resolve({ ok: false, reason: 'approval_timeout' });
    }, TIMEOUT_MS);

    py.stdout.on('data', (d) => {
      for (const line of d.toString().split('\n').filter((l) => l.trim())) {
        try {
          const p = JSON.parse(line);
          if (p.log) console.log(p.log);
          else stdout = line;
        } catch { stdout = line; }
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
      try { resolve(parseApprovalResponse(JSON.parse(stdout))); }
      catch { resolve({ ok: false, reason: 'approval_unparsable', raw: stderr.slice(-200) }); }
    });
    py.stdin.write(JSON.stringify(input));
    py.stdin.end();
  });
}

module.exports = { validateApprovalInput, parseApprovalResponse, confirmSubscriptionActivation };
