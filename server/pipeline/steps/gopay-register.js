// server/pipeline/steps/gopay-register.js
// P3 迁移：GoPay 钱包注册步 — 对应 gopay-engine.js runOne() 中的 Phase 4（gopay_activate）。
//
// 行为来源：
//   gopay-engine.js:52–101  — runOne() 中 _setPhase('gopay_activate')、gopayInput 构建、
//                             _spawnPython 调用、result.status 分流（success / 其他）
//   gopay_activate.py:428–441 — mode='register' 输入 {mode,access_token,pin}，
//                              输出 {status:'registered', account, proxy, phone}
//                              或  {status:'gopay_reg_fail', phone, detail}
//
// 注意：gopay-engine 原始逻辑在同一次 _spawnPython 调用里执行"register + pay"（mode 默认 full）。
// 新的三步拆分把 register 与 pay 分开以便细粒度断点续跑和测试。
// shouldSkip → () => false（见注释）。
'use strict';

const path = require('path');
const fs   = require('fs');

const { defineStep }               = require('../step');
const { spawnGopay, GOPAY_SCRIPT } = require('./_gopay-spawn');

// config.json 路径（repo 根）
const CONFIG_PATH = path.join(__dirname, '..', '..', '..', 'config.json');

// ==========================================================================
// gopayRegisterStep 工厂函数
// ==========================================================================

/**
 * gopayRegisterStep() 返回 defineStep({ id:'gopay-register', ... })。
 *
 * ctx.outputs.login 约定（由 login step 写入）：
 *   { accessToken, session, planType }
 *
 * ctx.deps 约定：
 *   emitStatus(data)        — 发送状态事件
 *   progress                — 当前进度字符串，如 "1/5"
 *   abortController         — { signal } 可选；abort → spawnGopay 返回 {status:'aborted'}
 *
 * ctx.outputs 写入（成功时）：
 *   ctx.outputs['gopay-register'] = { account, proxy, phone }
 *
 * ctx.flags 写入（失败时）：
 *   ctx.flags.finalStatus  = result.status（如 'gopay_reg_fail' / 'error' / 'timeout' / 'aborted'）
 *   ctx.flags.finalReason  = result.detail || ''
 */
function gopayRegisterStep() {
  return defineStep({
    id:    'gopay-register',
    label: 'GoPay 钱包注册',

    // shouldSkip: 目前 GoPay 路径没有持久化"register 已完成"的 checkpoint。
    // resume 颗粒度在本 step 边界（即：如果整条流水线重跑，register 会重新执行）。
    // 等 DB/checkpoint 迁移完成后再在此处检查 ctx.prevPersisted.gopayAccount。
    shouldSkip: () => false,

    async run(ctx) {
      const { emitStatus, progress, abortController } = ctx.deps;
      const { account } = ctx;

      // 读取 accessToken（由 login step 写入 ctx.outputs.login）
      const accessToken = ctx.outputs.login?.accessToken;

      // 每次 run 时从磁盘重新读 config，确保拿到最新 pin（与 gopay-engine.js:73 一致）
      let pin = '147258';
      try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
        pin = cfg.gopay?.defaultPin || '147258';
      } catch {
        // config 读取失败时使用默认 pin，不中断流程
      }

      // 发出 running 事件（镜像 gopay-engine._setPhase('gopay_activate')）
      emitStatus({ email: account.email, status: 'running', phase: 'gopay_register', progress });

      // 调用 spawnGopay（mode:'register'）
      const result = await spawnGopay(
        GOPAY_SCRIPT,
        { mode: 'register', access_token: accessToken, pin },
        {
          timeoutMs: 600000,
          signal:    abortController?.signal,
          onLog:     (m) => console.log(m),
        },
      );

      if (result.status === 'registered') {
        // 成功：把 Python 返回的 account/proxy/phone 存入 outputs 供下游 step 使用
        ctx.outputs['gopay-register'] = {
          account: result.account,
          proxy:   result.proxy,
          phone:   result.phone,
        };
        return { ok: true };
      }

      // 失败路径（gopay_reg_fail / error / timeout / aborted）
      // 镜像 gopay-engine.js:89 — _addResult(account, gopayResult.status || 'gopay_pay_fail', gopayResult.detail)
      const failStatus = result.status || 'gopay_reg_fail';
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

module.exports = { gopayRegisterStep };
