// server/pipeline/steps/gopay-verify.js
// P3 迁移：GoPay Plus 验证终止步 — 对应 gopay-engine.js runOne() 中的 verify_plus phase。
//
// 行为来源：
//   gopay-engine.js:83–87  — _setPhase('verify_plus') + _addResult(account,'plus_gopay',null,{phone,transactionStatus})
//
// 这是 GoPay 流水线的终止成功步（terminal success finalizer）。
//   - 无 Python spawn（仅标记状态 + 发送事件）。
//   - 镜像 gopay-engine 的最终 emit：status='plus_gopay'，携带 phone。
//   - 无 PKCE（GoPay 路径不做 OAuth/PKCE）。
//   - shouldSkip → () => false（见注释）。
'use strict';

const { defineStep } = require('../step');

// ==========================================================================
// gopayVerifyStep 工厂函数
// ==========================================================================

/**
 * gopayVerifyStep() 返回 defineStep({ id:'gopay-verify', ... })。
 *
 * ctx.outputs['gopay-pay'] 约定（由 gopay-pay step 写入）：
 *   { phone, transaction_status }
 *
 * ctx.deps 约定：
 *   emitStatus(data)  — 发送状态事件
 *   progress          — 当前进度字符串
 *
 * ctx.flags 写入：
 *   ctx.flags.finalStatus = 'plus_gopay'
 *   ctx.flags.finalReason = ''
 */
function gopayVerifyStep() {
  return defineStep({
    id:    'gopay-verify',
    label: 'GoPay Plus 验证',

    // shouldSkip: 本步是终止步，永远不跳过。
    // 若将来引入"已验证 Plus"的持久化 checkpoint，可在此检查
    // ctx.prevPersisted.status === 'plus_gopay' 以跳过重复验证。
    shouldSkip: () => false,

    async run(ctx) {
      const { emitStatus, progress } = ctx.deps;
      const { account } = ctx;

      // 读取 gopay-pay 的输出（phone 随 plus_gopay 事件一起携带）
      const payOut = ctx.outputs['gopay-pay'] || {};
      const phone  = payOut.phone;

      // 发出 running 事件（镜像 gopay-engine._setPhase('verify_plus')）
      emitStatus({ email: account.email, status: 'running', phase: 'verify_plus', progress });

      // 设置终止成功状态（镜像 gopay-engine._addResult(account,'plus_gopay',null,{phone,...})）
      ctx.flags.finalStatus = 'plus_gopay';
      ctx.flags.finalReason = '';

      // 发出终止事件（携带 phone，镜像 gopay-engine result.phone）
      emitStatus({
        email:    account.email,
        status:   'plus_gopay',
        phase:    'done',
        progress,
        phone,
      });

      return { ok: true };
    },
  });
}

module.exports = { gopayVerifyStep };
