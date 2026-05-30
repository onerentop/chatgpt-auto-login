// server/pipeline/steps/gopay-pay.js
// P3 迁移：GoPay Midtrans 支付步 — 对应 gopay-engine.js runOne() 中 Phase 3+5（pay 部分）。
//
// 行为来源：
//   gopay-engine.js:82–90  — result.status==='success' 分支（_setPhase('verify_plus') 在下一步）
//   gopay_activate.py:443–471 — mode='pay' 输入 {mode,access_token,pin,account,proxy}，
//                               输出 {status:'success', phone, transaction_status}
//                               或  {status:'gopay_pay_fail'/'gopay_fraud', phone, detail}
//
// 注意：
//   - 成功时不设 finalStatus（终止 'plus_gopay' 由 gopay-verify step 设置，
//     镜像 gopay-engine 的 verify_plus phase → _addResult(..., 'plus_gopay')）。
//   - shouldSkip → () => false（见注释）。
'use strict';

const path = require('path');
const fs   = require('fs');

const { defineStep }               = require('../step');
const { spawnGopay, GOPAY_SCRIPT } = require('./_gopay-spawn');

// config.json 路径（repo 根）
const CONFIG_PATH = path.join(__dirname, '..', '..', '..', 'config.json');

// ==========================================================================
// gopayPayStep 工厂函数
// ==========================================================================

/**
 * gopayPayStep() 返回 defineStep({ id:'gopay-pay', ... })。
 *
 * ctx.outputs.login 约定（由 login step 写入）：
 *   { accessToken }
 *
 * ctx.outputs['gopay-register'] 约定（由 gopay-register step 写入）：
 *   { account, proxy, phone }
 *
 * ctx.deps 约定：
 *   emitStatus(data)  — 发送状态事件
 *   progress          — 当前进度字符串
 *   abortController   — { signal } 可选
 *
 * ctx.outputs 写入（成功时）：
 *   ctx.outputs['gopay-pay'] = { phone, transaction_status }
 *   注意：不设 finalStatus（由 gopay-verify step 设为 'plus_gopay'）
 *
 * ctx.flags 写入（失败时）：
 *   ctx.flags.finalStatus = result.status（如 'gopay_pay_fail' / 'gopay_fraud' / 'error' / 'timeout' / 'aborted'）
 *   ctx.flags.finalReason = result.detail || ''
 */
function gopayPayStep() {
  return defineStep({
    id:    'gopay-pay',
    label: 'GoPay Midtrans 支付',

    // shouldSkip: 若账号已是 Plus（plan-check 设 ctx.flags.alreadyPlus=true），
    // 跳过 pay（与 gopay-register 一致，均在 alreadyPlus 时跳过）。
    shouldSkip: (ctx) => !!ctx.flags.alreadyPlus,

    async run(ctx) {
      const { emitStatus, progress, abortController } = ctx.deps;
      const { account } = ctx;

      // 读取上游 login step 的 accessToken
      const accessToken = ctx.outputs.login?.accessToken;

      // 读取 gopay-register step 的输出
      const registerOut = ctx.outputs['gopay-register'] || {};
      const gopayAccount = registerOut.account;
      const proxy        = registerOut.proxy || '';

      // 每次 run 时从磁盘重新读 config（与 gopay-engine.js:73 一致）
      let pin = '147258';
      try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        pin = cfg.gopay?.defaultPin || '147258';
      } catch {
        // config 读取失败时使用默认 pin，不中断流程
      }

      // 发出 running 事件（镜像 gopay-engine 在同阶段发出的 phase 标识）
      emitStatus({ email: account.email, status: 'running', phase: 'gopay_pay', progress });

      // 调用 spawnGopay（mode:'pay'）
      const result = await spawnGopay(
        GOPAY_SCRIPT,
        { mode: 'pay', access_token: accessToken, pin, account: gopayAccount, proxy },
        {
          timeoutMs: 600000,
          signal:    abortController?.signal,
          onLog:     (m) => console.log(m),
        },
      );

      if (result.status === 'success') {
        // 成功：写 outputs 供 gopay-verify 读取；
        // 不设 finalStatus（由 gopay-verify 设置 'plus_gopay'，
        // 镜像 gopay-engine.js:83 — this._setPhase('verify_plus') 在 success 分支之后）
        ctx.outputs['gopay-pay'] = {
          phone:              result.phone,
          transaction_status: result.transaction_status,
        };
        return { ok: true };
      }

      // 失败路径（gopay_pay_fail / gopay_fraud / error / timeout / aborted）
      // 镜像 gopay-engine.js:89 — _addResult(account, gopayResult.status || 'gopay_pay_fail', gopayResult.detail)
      const failStatus = result.status || 'gopay_pay_fail';
      const failReason = result.detail || '';

      ctx.flags.finalStatus = failStatus;
      ctx.flags.finalReason = failReason;

      emitStatus({
        email:    account.email,
        status:   failStatus,
        phase:    'done',
        progress,
        reason:   failReason,
      });

      return { ok: false, reason: failReason };
    },
  });
}

module.exports = { gopayPayStep };
