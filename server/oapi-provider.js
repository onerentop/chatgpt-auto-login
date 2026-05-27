// v2.50.0 — oapi (sms.oapi.vip) SMS Relay provider
// 鉴权: X-API-Key: <cdk> header（CDK 兼作 API Key，用户验证可用）
// 所有 endpoint POST + JSON body { code: cdk }

const DEFAULT_BASE_URL = 'https://sms.oapi.vip/api.php';

async function _post(baseUrl, action, cdk) {
  const url = `${baseUrl || DEFAULT_BASE_URL}?action=${action}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'X-API-Key': cdk,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ code: cdk }),
  });
  if (!r.ok) {
    const e = new Error(`HTTP ${r.status}`);
    e._oapiCode = `http_${r.status}`;
    throw e;
  }
  const j = await r.json();
  if (!j.ok) {
    const e = new Error(j.error || 'oapi ok=false');
    e._oapiCode = 'api_fail';
    e._oapiBody = j;
    throw e;
  }
  return j;
}

async function takeOrder(cdk, baseUrl) {
  const j = await _post(baseUrl, 'open_get_phone', cdk);
  return { phone: '+' + String(j.phone).replace(/^\+/, ''), remaining: j.remaining };
}

async function pollOnce(cdk, baseUrl) {
  // 单次 poll —— ok=false 不抛错（正常轮询等待），返 null
  const url = `${baseUrl || DEFAULT_BASE_URL}?action=open_get_sms`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'X-API-Key': cdk, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: cdk }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  if (j.ok && j.code) return { code: String(j.code), remaining: j.remaining };
  return null;
}

async function changePhone(cdk, baseUrl) {
  // v1 不在路径上调用，仅暴露 API 供未来使用
  const j = await _post(baseUrl, 'open_change_phone', cdk);
  return { phone: '+' + String(j.phone).replace(/^\+/, ''), remaining: j.remaining };
}

module.exports = {
  takeOrder, pollOnce, changePhone,
  _DEFAULT_BASE_URL: DEFAULT_BASE_URL,
};
