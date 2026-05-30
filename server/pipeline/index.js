// server/pipeline/index.js
const { defineStep } = require('./step');
const { loginStep }       = require('./steps/login');
const { planCheckStep }   = require('./steps/plan-check');
const { paypalFetchStep } = require('./steps/paypal-fetch');
const { paypalVerifyStep }= require('./steps/paypal-verify');
const { paypalPayStep }   = require('./steps/paypal-pay');
const { paypalPkceStep }  = require('./steps/paypal-pkce');
const { browserPkceStep } = require('./steps/browser-pkce');
const { cpaStep }         = require('./steps/cpa');

// 占位 step：gopay 路径等尚未迁移的步。throw 确保未迁移的步不会被静默当成功。
function placeholder(id, label) {
  return defineStep({ id, label, run: async () => { throw new Error(`step ${id} not migrated yet`); } });
}

function buildPipeline({ login = 'protocol', payment = 'paypal' } = {}) {
  if (payment === 'gopay') {
    // gopay 路径暂未迁移，仍使用占位 step
    return [
      placeholder('login', '登录 + 获取 access token'),
      placeholder('plan-check', '套餐检查'),
      placeholder('gopay-register', 'GoPay 钱包注册'),
      placeholder('gopay-pay', '拿 snap + 付款'),
      placeholder('gopay-verify', '验证 Plus'),
    ];
  }
  // paypal 路径：使用真实迁移后的 step 模块。
  if (login === 'browser') {
    // browser 引擎管道：login(browser策略) → plan-check → paypal-fetch → paypal-verify
    // → paypal-pay → browser-pkce → cpa
    // browser-pkce 替换 paypal-pkce（Playwright fetchTokensViaPKCE，无 add-phone）
    // cpa 是浏览器引擎独有（协议引擎无此步，shouldSkip 在无 browser 时跳过）
    return [
      loginStep({ login: 'browser' }),
      planCheckStep(),
      paypalFetchStep(),
      paypalVerifyStep(),
      paypalPayStep(),
      browserPkceStep(),
      cpaStep(),
    ];
  }
  // protocol 路径（默认）：使用 paypal-pkce finalizer（Python spawn PKCE + add-phone）
  return [
    loginStep({ login: 'protocol' }),
    planCheckStep(),
    paypalFetchStep(),
    paypalVerifyStep(),
    paypalPayStep(),
    paypalPkceStep(),
  ];
}

module.exports = { buildPipeline };
