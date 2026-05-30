// server/pipeline/steps/plan-check.js
// P1 迁移：把 ProtocolEngine.start() 中的已-Plus 检测行为（protocol-engine.js:726-741）搬运到独立 step。
//
// 行为来源：protocol-engine.js 第 726–741 行（isPlusOrAbove 判断 + 路由）。
//
// 设计：flag-routing 模式。
//   - plan-check 只负责"检测 + 设旗"，不执行 clearPaymentLink / clearAccessToken /
//     _finalizePkce / saveCPAAuthFile / summary.success++。
//   - 已-Plus 路径的终止动作（clear + pkce/save + success）全部由 paypal-pkce step 通过
//     ctx.flags.alreadyPlus === true 分支处理（BY DESIGN，非遗漏）。
//
// 禁止：不得改任何分支、状态字符串或 planType 列表。若某处看起来冗余，保持原样。

'use strict';

const { defineStep } = require('../step');

// --------------------------------------------------------------------------
// planCheckStep 工厂函数
// --------------------------------------------------------------------------

/**
 * planCheckStep() 返回 defineStep({ id:'plan-check', label:'套餐检查', run, shouldSkip })。
 *
 * ctx.outputs.login 约定（由 login step 写入）：
 *   { accessToken, session, planType }
 *
 * ctx.flags 写入：
 *   alreadyPlus: true   —— 若 planType 在已-Plus 层级列表中（否则不写该字段）
 *
 * 注意：本 step 不调用 emitStatus、不修改 summary、不操作 statusDB。
 *   原始代码在 isPlusOrAbove 块内的所有终止动作（clearPaymentLink、clearAccessToken、
 *   _finalizePkce / saveCPAAuthFile、summary.success++、continue）均由 paypal-pkce step
 *   通过 ctx.flags.alreadyPlus 路由执行，下游的 paypal-fetch / paypal-verify / paypal-pay
 *   step 应在 shouldSkip() 中检查 ctx.flags.alreadyPlus 以跳过各自逻辑。
 */
function planCheckStep() {
  return defineStep({
    id: 'plan-check',
    label: '套餐检查',

    // shouldSkip 永远返回 false：plan-check 开销极低，且每次都需要判断当前 planType。
    shouldSkip: () => false,

    async run(ctx) {
      const result = ctx.outputs.login;

      // protocol-engine.js:727 — 原文逐字：isPlusOrAbove 计算
      const isPlusOrAbove = ['plus', 'pro', 'team', 'enterprise'].includes(
        (result.planType || 'free').toLowerCase()
      );

      if (isPlusOrAbove) {
        // 设旗，供下游步骤路由。
        // 已-Plus 的终止动作（clearPaymentLink + clearAccessToken + _finalizePkce/saveCPAAuthFile
        // + summary.success++）由 paypal-pkce step 在 alreadyPlus 分支中统一处理（BY DESIGN）。
        ctx.flags.alreadyPlus = true;
      }

      // 无论 isPlusOrAbove 是否为真，均返回 ok:true；
      // 路由决策由下游各 step 的 shouldSkip() 完成。
      return { ok: true };
    },
  });
}

module.exports = { planCheckStep };
