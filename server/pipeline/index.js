// server/pipeline/index.js
const { defineStep } = require('./step');

// 占位 step：P1-P3 用真实模块替换。throw 确保未迁移的步不会被静默当成功。
function placeholder(id, label) {
  return defineStep({ id, label, run: async () => { throw new Error(`step ${id} not migrated yet`); } });
}

// P1-P3 完成后，这里改成 require('./steps/login') 等真实模块。
function buildPipeline({ login = 'protocol', payment = 'paypal' } = {}) {
  const loginStep = placeholder('login', '登录 + 获取 access token');   // 注入 login 策略在 P1/P2
  const planCheck = placeholder('plan-check', '套餐检查');
  if (payment === 'gopay') {
    return [
      loginStep,
      planCheck,
      placeholder('gopay-register', 'GoPay 钱包注册'),
      placeholder('gopay-pay', '拿 snap + 付款'),
      placeholder('gopay-verify', '验证 Plus'),
    ];
  }
  return [
    loginStep,
    planCheck,
    placeholder('paypal-fetch', '获取支付链接'),
    placeholder('paypal-verify', 'Stripe 验证 $0'),
    placeholder('paypal-pay', '支付'),
    placeholder('paypal-pkce', 'PKCE / 凭证'),
  ];
}

module.exports = { buildPipeline };
