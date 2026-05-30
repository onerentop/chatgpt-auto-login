// server/pipeline/steps/paypal-verify.js
// P1 迁移：把 ProtocolEngine.start() 中的 Phase 2.5（Stripe $0 验证）行为逐行搬运到独立 step。
//
// 行为来源：protocol-engine.js 第 822–840 行（linkSource !== 'discord' 门控；
// emitStatus running/verify；verifyCheckoutIsFree 调用；!v.ok → verify_error；
// !v.is_free → no_promo；else log coupons）。
//
// 禁止：不得改任何分支、状态字符串、reason 文本或 emit payload 字段。若某处看起来冗余，保持原样。

'use strict';

const { defineStep } = require('../step');
const { verifyCheckoutIsFree } = require('../../stripe-verify');

// --------------------------------------------------------------------------
// paypalVerifyStep 工厂函数
// --------------------------------------------------------------------------

/**
 * paypalVerifyStep() 返回 defineStep({ id:'paypal-verify', label:'Stripe 验证 $0', shouldSkip, run })。
 *
 * ctx.deps 约定（由 engine-shell 在运行时注入）：
 *   emitStatus(data)       — 原始 engine.emitStatus（含 proxyNode/exitIp 注入）
 *   summary                — 共享可变计数器 { verifyError, noPromo, ... }
 *   progress               — 当前进度字符串，如 "3/10"
 *   linkSource             — 'api' 或 'discord'
 *
 * ctx.outputs['paypal-fetch'] 约定（由 paypal-fetch step 写入）：
 *   { link, pk, fetchResult, usedCachedLink }
 *
 * ctx.flags 读取：
 *   alreadyPlus            — true 时 shouldSkip 返回 true，跳过验证
 *
 * 测试接缝（仅供单元测试注入，生产不传）：
 *   ctx.deps.__verifyCheckoutIsFree — 替换真正的 verifyCheckoutIsFree，避免测试发起网络请求
 */
function paypalVerifyStep() {
  return defineStep({
    id: 'paypal-verify',
    label: 'Stripe 验证 $0',

    // shouldSkip:
    //   - 已 Plus 账号跳过（原始 protocol-engine.js 中 Phase 2.5 在 isPlusOrAbove 的 continue 之后，故不会执行）
    //   - Discord 路径跳过（原始代码用 if (linkSource !== 'discord') 门控整个 Phase 2.5）
    // 注意：ctx.deps 由 engine-shell 在步骤运行前注入，shouldSkip 调用时 ctx.deps 应已就绪。
    // 保守起见加 ctx.deps && 防御，避免在缺 deps 的极端单测场景下 TypeError。
    shouldSkip(ctx) {
      if (ctx.flags.alreadyPlus) return true;
      if (ctx.deps && ctx.deps.linkSource === 'discord') return true;
      return false;
    },

    async run(ctx) {
      const { account } = ctx;
      const {
        emitStatus,
        summary,
        progress,
      } = ctx.deps;

      // 测试接缝：允许注入替代实现，跳过真实 Stripe 调用
      const _verifyCheckoutIsFree = ctx.deps.__verifyCheckoutIsFree || verifyCheckoutIsFree;

      // 从 paypal-fetch step 的产物中取 link 和 pk
      const link = ctx.outputs['paypal-fetch'].link;
      const pk   = ctx.outputs['paypal-fetch'].pk;

      // ======================================================================
      // protocol-engine.js:824
      // emit running/verify
      // ======================================================================
      emitStatus({ email: account.email, status: 'running', phase: 'verify', progress });
      console.log(`[${progress}] Phase 2.5: Verifying $0 via Stripe init...`);

      // ======================================================================
      // protocol-engine.js:826
      // 调用 verifyCheckoutIsFree(link, fetchResult.pk)
      // 注意：原始代码用 fetchResult.pk；paypal-fetch 输出中 pk === fetchResult.pk || ''
      // ======================================================================
      const v = await _verifyCheckoutIsFree(link, pk);

      // ======================================================================
      // protocol-engine.js:827–831
      // !v.ok → verify_error
      // ======================================================================
      if (!v.ok) {
        console.log(`[${progress}] Verify failed: ${v.reason}`);
        emitStatus({ email: account.email, status: 'verify_error', phase: 'done', progress, paymentLink: link, reason: `Stripe init: ${v.reason}` });
        summary.verifyError++;
        return { ok: false, reason: `Stripe init: ${v.reason}` };
      }

      // ======================================================================
      // protocol-engine.js:833–838
      // v.ok 但 !v.is_free → no_promo
      // ======================================================================
      if (!v.is_free) {
        console.log(`[${progress}] Not free: amount_due=${v.amount_due} ${v.currency}`);
        emitStatus({ email: account.email, status: 'no_promo', phase: 'done', progress, paymentLink: link, reason: `amount_due=${v.amount_due} ${v.currency}` });
        summary.noPromo++;
        return { ok: false, reason: `amount_due=${v.amount_due} ${v.currency}` };
      }

      // ======================================================================
      // protocol-engine.js:839
      // v.ok && v.is_free → log coupons，进入 Phase 3
      // ======================================================================
      console.log(`[${progress}] ✓ Verified $0 + coupons=[${v.coupons.join(',')}]`);

      return { ok: true };
    },
  });
}

module.exports = { paypalVerifyStep };
