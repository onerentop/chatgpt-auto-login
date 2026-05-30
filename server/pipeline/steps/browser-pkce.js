// server/pipeline/steps/browser-pkce.js
// P2 迁移：把 PipelineEngine（server/engine.js）中 PKCE 终止逻辑逐行搬运到独立 step。
//
// 行为来源：
//   engine.js 第 343–375 行  — already-Plus 路径（clearPaymentLink/clearAccessToken + enableOAuth
//                               判断 + fetchTokensViaPKCE 分支 + enableOAuth=false 兜底）
//   engine.js 第 592–626 行  — post-payment 路径（同上，但 log 字符串不同；post-pay 多一条
//                               else console.log("[p] PKCE failed, saving without refresh_token")
//                               at line 621 ）
//
// 禁止：不得改任何分支、log 字符串、状态名或顺序。注意 already-Plus 与 post-pay 两条路径的
// 不对称（log 字符串 / 额外 else 分支），均属真实行为，必须保留。
//
// 设计：本 step 是 browser-only 的 PKCE 终止器（通过 fetchTokensViaPKCE，NO add-phone）。
//   (A) ctx.flags.alreadyPlus === true   → plan-check 检测到已 Plus
//   (B) ctx.flags.alreadyPlus === false  → post-payment-success 路径（由 paypal-pay 支付完成路由）
//
// 对应清单（browser-engine.md）：D-K1..D-K7

'use strict';

const path = require('path');
const fs   = require('fs');

const { defineStep }      = require('../step');
// saveCPAAuthFile + fetchTokensViaPKCE 在 repo 根 utils.js（server/pipeline/steps/ 上三级）
const { saveCPAAuthFile, fetchTokensViaPKCE: _fetchTokensViaPKCE } = require('../../../utils');

// ROOT 相对于 server/pipeline/steps/ → 上三级到 repo 根
const ROOT = path.join(__dirname, '..', '..', '..');

// --------------------------------------------------------------------------
// browserPkceStep 工厂函数
// --------------------------------------------------------------------------

/**
 * browserPkceStep() 返回 defineStep({ id:'browser-pkce', label:'PKCE / 写凭证（浏览器）', shouldSkip, run })。
 *
 * ctx.deps 约定（由 engine-shell 在运行时注入）：
 *   emitStatus(data)          — 原始 engine.emitStatus（含 proxyNode/exitIp 注入）
 *   progress                  — 当前进度字符串，如 "3/10"
 *   runtimeCfg                — 本轮解析的 config.json（enableOAuth 读取点）
 *   resources.browser         — Playwright browser（browser login strategy 启动）
 *   statusDB                  — 用于 clearPaymentLink/clearAccessToken
 *
 * ctx.outputs.login 约定（由 browser login strategy 写入）：
 *   { accessToken, session, planType, lastOtp }
 *
 * ctx.flags 读取：
 *   alreadyPlus: true  — plan-check 设旗，表示账号已 Plus（skipped fetch/verify/pay）
 *
 * ctx.flags 写入：
 *   finalStatus — 本 step 计算的最终账号状态（runner-shell 用于循环末尾 emitStatus done）
 *
 * 测试接缝（仅供单元测试注入，生产不传）：
 *   ctx.deps.__fetchTokensViaPKCE  — 替换 fetchTokensViaPKCE，避免测试调 Playwright
 */
function browserPkceStep() {
  return defineStep({
    id: 'browser-pkce',
    label: 'PKCE / 写凭证（浏览器）',

    // shouldSkip: 永远返回 false（本 step 只有在 pipeline 到达它时才运行，
    // 即 already-Plus 或 post-payment-success；pipeline 在失败时不会到达本 step）。
    shouldSkip: () => false,

    async run(ctx) {
      const { account } = ctx;
      const { emitStatus, progress } = ctx.deps;
      const loginResult = ctx.outputs.login;
      const email = account.email;

      // ====================================================================
      // engine.js:344 (alreadyPlus) / 576-577 (post-pay — deferred here)
      // 两条路径在进入 PKCE 前均执行 clearPaymentLink + clearAccessToken
      // ====================================================================
      ctx.deps.statusDB.clearPaymentLink(email);
      ctx.deps.statusDB.clearAccessToken(email);

      // ====================================================================
      // engine.js:347 (alreadyPlus) / 575 (post-pay) — 默认 plus_no_rt
      // ====================================================================
      let finalStatus = 'plus_no_rt';

      // ====================================================================
      // engine.js:349-375 (alreadyPlus) / 594-626 (post-pay)
      // 每账号重读 config.json（与原始 latestCfg = JSON.parse(fs.readFileSync(...))等价）
      // ====================================================================
      const latestCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));

      // 测试接缝：允许注入替代实现，跳过 Playwright 调用
      const fetchPKCE = ctx.deps.__fetchTokensViaPKCE || _fetchTokensViaPKCE;

      if (latestCfg.enableOAuth) {
        // ------------------------------------------------------------------
        // engine.js:351 (alreadyPlus): `Running PKCE for already-Plus account...`
        // engine.js:597 (post-pay):    `Phase 4: PKCE OAuth...`
        // ------------------------------------------------------------------
        if (ctx.flags.alreadyPlus) {
          console.log(`${progress} Running PKCE for already-Plus account...`);
        } else {
          console.log(`${progress} Phase 4: PKCE OAuth...`);
        }

        // engine.js:352 (alreadyPlus) / 598 (post-pay)
        emitStatus({ email, status: 'running', phase: 'pkce', progress });

        // engine.js:353 (alreadyPlus) / 599 (post-pay)
        const pkceTokens = await fetchPKCE(ctx.deps.resources.browser, account, loginResult.lastOtp)
          .catch((e) => { console.log(`  [PKCE] Failed: ${e.message}`); return null; });

        if (pkceTokens?.refresh_token) {
          // engine.js:354-356 (alreadyPlus) — alreadyPlus does NOT log success message here
          // engine.js:600-603 (post-pay)    — post-pay DOES log success
          if (!ctx.flags.alreadyPlus) {
            // engine.js:601 — post-pay only
            console.log(`${progress} PKCE success, saving with refresh_token`);
          }
          // engine.js:355 (alreadyPlus) / 602 (post-pay)
          saveCPAAuthFile(email, pkceTokens.access_token, pkceTokens);
          finalStatus = 'plus';

        } else if (pkceTokens?.phonePoolEmpty) {
          // engine.js:358-361 (alreadyPlus) / 605-610 (post-pay)
          console.log(`${progress} PKCE: phone pool exhausted for this account`);
          emitStatus({ email, status: 'phone_pool_empty', phase: 'pkce', progress, reason: '号池已用尽或全部满' });
          saveCPAAuthFile(email, loginResult.accessToken, loginResult.session);
          finalStatus = 'phone_pool_empty';

        } else if (pkceTokens?.phoneVerifyFail) {
          // engine.js:362-366 (alreadyPlus) / 611-616 (post-pay)
          console.log(`${progress} PKCE: phone verify failed (${pkceTokens.phoneVerifyFail})`);
          emitStatus({ email, status: 'phone_verify_fail', phase: 'pkce', progress, reason: pkceTokens.phoneVerifyFail });
          saveCPAAuthFile(email, loginResult.accessToken, loginResult.session);
          finalStatus = 'phone_verify_fail';

        } else {
          // needsPhone (pool disabled) 或其它非成功路径 → plus_no_rt 兜底（保持既有行为）
          // engine.js:367-372 (alreadyPlus):
          //   if (pkceTokens?.needsPhone) log "requires phone..."
          //   else if (pkceTokens && !pkceTokens.refresh_token) log "returned no refresh_token"
          //   saveCPAAuthFile fallback
          //
          // engine.js:617-622 (post-pay) — 同上 + 一条额外 else:
          //   else console.log("PKCE failed, saving without refresh_token")  ← post-pay 独有
          if (pkceTokens?.needsPhone) {
            console.log(`${progress} PKCE requires phone verification (pool disabled)`);
          } else if (pkceTokens && !pkceTokens.refresh_token) {
            console.log(`${progress} PKCE returned no refresh_token`);
          } else if (!ctx.flags.alreadyPlus) {
            // engine.js:621 — post-pay 独有（alreadyPlus 路径无此 else 分支）
            console.log(`${progress} PKCE failed, saving without refresh_token`);
          }
          // engine.js:371 (alreadyPlus) / 622 (post-pay)
          saveCPAAuthFile(email, pkceTokens?.access_token || loginResult.accessToken, pkceTokens || loginResult.session);
          // finalStatus 保持 'plus_no_rt' 兜底
        }

      } else {
        // engine.js:373-374 (alreadyPlus) / 624-625 (post-pay)
        saveCPAAuthFile(email, loginResult.accessToken, loginResult.session);
        // finalStatus 保持 'plus_no_rt'
      }

      // 写入 ctx.flags 供 runner-shell 循环末尾 emitStatus done 使用
      ctx.flags.finalStatus = finalStatus;
      ctx.flags.finalReason = '';
      ctx.flags.finalPaymentLink = '';

      // 不触碰 ctx.deps.summary，不 emit terminal {status}/done
      // （runner-shell 的 P2.4 循环末尾统一 emit）
      return { ok: true };
    },
  });
}

module.exports = { browserPkceStep };
