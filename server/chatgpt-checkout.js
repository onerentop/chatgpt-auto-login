// Direct ChatGPT internal /backend-api/payments/checkout caller.
// Replacement for the Discord-bot path of obtaining a pay.openai.com link.
//
// The endpoint and request body shape come from reverse-engineering the
// official ChatGPT web client (see openai-plus-vxt extension). The promo
// `plus-1-month-free` only returns a link when the request's exit IP
// geolocates to Japan AND billing_details.country === 'JP'.
const proxyMgr = require('./proxy');

const ENDPOINT = 'https://chatgpt.com/backend-api/payments/checkout';

async function fetchCheckoutLink(accessToken, opts = {}) {
  const body = {
    entry_point: 'all_plans_pricing_modal',
    plan_name: 'chatgptplusplan',
    billing_details: {
      country: opts.country || 'JP',
      currency: opts.currency || 'JPY',
    },
    cancel_url: 'https://chatgpt.com/#pricing',
    checkout_ui_mode: 'hosted',
    promo_campaign: {
      promo_campaign_id: opts.promoCampaignId || 'plus-1-month-free',
      is_coupon_from_query_param: false,
    },
  };

  // Import both fetch and ProxyAgent from the same undici copy. Node's global
  // fetch uses a DIFFERENT (internal) undici, and its ProxyAgent/fetch interfaces
  // don't match the npm package's — leading to UND_ERR_INVALID_ARG at runtime.
  const { fetch: undiciFetch, ProxyAgent } = require('undici');
  const proxyUrl = proxyMgr.getProxyUrl();
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

  let res, text = '';
  try {
    res = await undiciFetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      },
      body: JSON.stringify(body),
      dispatcher,
    });
    text = await res.text();
  } catch (e) {
    return { link: '', title: '', raw: `ERROR: ${(e.message || 'fetch failed').slice(0, 200)}` };
  }

  const linkMatch = text.match(/https:\/\/pay\.openai\.com[^\s"\\)]+/);
  if (!linkMatch) {
    console.log(`[Checkout] No pay.openai.com link in response (status ${res.status}): ${text.slice(0, 200)}`);
  }
  return {
    link: linkMatch ? linkMatch[0] : '',
    title: '',
    raw: text.slice(0, 500),
  };
}

module.exports = { fetchCheckoutLink };
