// server/pipeline/steps/cpa.js
// P2 迁移：把 PipelineEngine（server/engine.js）中 CPA 注册逻辑逐行搬运到独立 step。
//
// 行为来源：
//   engine.js 第 377–387 行  — already-Plus 路径（emitStatus running/cpa + registerToCPA）
//   engine.js 第 628–637 行  — post-payment 路径（仅 registerToCPA，NOT emit running/cpa）
//
// 关键不对称（保留）：
//   already-Plus:  log "[p] CPA registration..."     + emitStatus running/cpa（engine.js:378-379）
//   post-payment:  log "[p] Phase 4: CPA registration..."   不 emit running/cpa（engine.js:629）
//
// 禁止：不得改任何分支、log 字符串、emit 顺序。协议模式不会包含本 step（shouldSkip 有防护）。
//
// 对应清单（browser-engine.md）：B6 D-K5 / C2

'use strict';

const path = require('path');
const fs   = require('fs');

const { defineStep } = require('../step');
// registerToCPA 在 repo 根 cpa.js（server/pipeline/steps/ 上三级）
const { registerToCPA: _registerToCPA } = require('../../../cpa');

// ROOT 相对于 server/pipeline/steps/ → 上三级到 repo 根
const ROOT = path.join(__dirname, '..', '..', '..');

// --------------------------------------------------------------------------
// cpaStep 工厂函数
// --------------------------------------------------------------------------

/**
 * cpaStep() 返回 defineStep({ id:'cpa', label:'CPA 注册（浏览器）', shouldSkip, run })。
 *
 * ctx.deps 约定（由 engine-shell 在运行时注入）：
 *   emitStatus(data)      — 原始 engine.emitStatus（含 proxyNode/exitIp 注入）
 *   progress              — 当前进度字符串，如 "3/10"
 *   resources.browser     — Playwright browser（browser login strategy 启动）
 *
 * ctx.flags 读取：
 *   alreadyPlus: true  — plan-check 设旗；决定 emit 行为（asymmetry）
 *
 * 测试接缝（仅供单元测试注入，生产不传）：
 *   ctx.deps.__registerToCPA  — 替换 registerToCPA，避免测试调 Playwright/CDP
 */
function cpaStep() {
  return defineStep({
    id: 'cpa',
    label: 'CPA 注册（浏览器）',

    // shouldSkip: 读 config.json enableCPA 字段（每账号重读）；
    // 若 enableCPA=false 或 browser 不可用（协议模式），跳过本 step。
    shouldSkip(ctx) {
      let enableCPA = false;
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
        enableCPA = !!cfg.enableCPA;
      } catch {}
      return !enableCPA || !ctx.deps.resources.browser;
    },

    async run(ctx) {
      const { account } = ctx;
      const { emitStatus, progress } = ctx.deps;
      const email = account.email;

      // 测试接缝：允许注入替代实现，跳过 Playwright 调用
      const registerCPA = ctx.deps.__registerToCPA || _registerToCPA;

      // ====================================================================
      // 关键不对称（browser-engine.md D-K5）：
      //
      // already-Plus 路径（engine.js:378-379）：
      //   console.log "[p] CPA registration..."
      //   emitStatus { status:'running', phase:'cpa', progress }
      //
      // post-payment 路径（engine.js:629）：
      //   console.log "[p] Phase 4: CPA registration..."
      //   （无 emitStatus running/cpa）
      // ====================================================================
      if (ctx.flags.alreadyPlus) {
        // engine.js:378
        console.log(`${progress} CPA registration...`);
        // engine.js:379
        emitStatus({ email, status: 'running', phase: 'cpa', progress });
      } else {
        // engine.js:629
        console.log(`${progress} Phase 4: CPA registration...`);
      }

      // engine.js:380-386 (alreadyPlus) / 630-636 (post-pay) — try/catch 共同逻辑
      try {
        const cpaOk = await registerCPA(ctx.deps.resources.browser, email, account);
        if (cpaOk) console.log(`${progress} CPA OAuth done.`);
        else console.log(`${progress} CPA OAuth may have issues, check manually.`);
      } catch (e) {
        console.log(`${progress} CPA error: ${e.message}`);
      }

      // CPA 不改变 ctx.flags.finalStatus
      return { ok: true };
    },
  });
}

module.exports = { cpaStep };
