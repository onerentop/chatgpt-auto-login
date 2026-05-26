// v2.44.0 — smscloud 远程接码 provider (smscloud.sbs)
// API: https://smscloud.sbs/docx/ — HTTP header apiKey + GET REST
// 鉴权: header `apiKey: <key>`
// 响应: { code, message, data } — code === 0 success
//
// 跟 zhusms-provider.js 不同点:
//   - 无 session/cookie，纯 apiKey + GET
//   - 全 endpoint GET（不是 POST form）
//   - id 字段是 string（zhusms 也 string），但 base URL 是 /api/system 前缀

const DEFAULT_BASE_URL = 'https://smscloud.sbs/api/system';

async function _get(url, apiKey) {
  // fetch 走全局 undici dispatcher (HTTPS_PROXY env 自动经 sing-box)
  const r = await fetch(url, {
    method: 'GET',
    headers: {
      'apiKey': apiKey,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
  });
  if (!r.ok) {
    const e = new Error(`HTTP ${r.status}`);
    e._smscloudCode = 'network_error';
    throw e;
  }
  const j = await r.json();
  if (j.code !== 0) {
    const e = new Error(j.message || `code=${j.code}`);
    e._smscloudCode = String(j.code);
    throw e;
  }
  return j.data;
}

async function takeOrder(apiKey, baseUrl, serviceCode, countryCode) {
  const url = `${baseUrl || DEFAULT_BASE_URL}/public/sms/getNumber?serviceCode=${encodeURIComponent(serviceCode)}&countryCode=${encodeURIComponent(countryCode)}`;
  const data = await _get(url, apiKey);
  // 标准化为 zhusms takeOrder 兼容 shape: { order_no, phone, raw }
  return {
    order_no: String(data.id),
    phone: '+' + String(data.phoneNumber).replace(/^\+/, ''),
    raw: data,
  };
}

async function pollOrderSms(orderNo, apiKey, baseUrl, { pollIntervalMs = 3000, maxAttempts = 30, signal } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    if (signal?.aborted) throw new Error('aborted');
    try {
      const data = await _get(`${baseUrl || DEFAULT_BASE_URL}/public/sms/orders/sync/${orderNo}`, apiKey);
      if (data && data.code) return String(data.code);
    } catch (e) {
      // 静默 retry — 短信未到不算错误，code=未到 时 _get 会抛但 retry
      if (e._smscloudCode === 'network_error') {
        // 网络错也继续 retry (不阻塞业务)
      }
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }
  return null;
}

async function cancelOrder(orderNo, apiKey, baseUrl) {
  await _get(`${baseUrl || DEFAULT_BASE_URL}/public/sms/orders/cancel/${orderNo}`, apiKey);
}

async function finishOrder(orderNo, apiKey, baseUrl) {
  await _get(`${baseUrl || DEFAULT_BASE_URL}/public/sms/orders/finish/${orderNo}`, apiKey);
}

async function getBalance(apiKey, baseUrl) {
  const data = await _get(`${baseUrl || DEFAULT_BASE_URL}/public/sms/balance`, apiKey);
  return data?.balance;
}

async function listServices(apiKey, baseUrl) {
  return await _get(`${baseUrl || DEFAULT_BASE_URL}/public/sms/services`, apiKey);
}

async function listCountries(apiKey, baseUrl) {
  return await _get(`${baseUrl || DEFAULT_BASE_URL}/public/sms/countries`, apiKey);
}

module.exports = {
  takeOrder, pollOrderSms, cancelOrder, finishOrder, getBalance,
  listServices, listCountries,
  _DEFAULT_BASE_URL: DEFAULT_BASE_URL,  // test 用
};
