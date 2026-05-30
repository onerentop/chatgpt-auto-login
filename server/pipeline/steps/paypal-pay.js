// server/pipeline/steps/paypal-pay.js
// P1 迁移：把 ProtocolEngine.start() 中的 Phase 3（支付）行为逐行搬运到独立 step。
//
// 行为来源：protocol-engine.js 第 842–960 行（findFreePort + tempDir; emit running/payment;
// launchChrome + waitForCDP; 存 this._chromeProc/_browser/_tempDir; page.goto;
// chrome-error/about:blank retry-once with rotate + recordBadAttempt/recordGoodAttempt G3;
// PayPal locator wait + randomDelay; per-account config.json re-read (freshCfg);
// autoPayment; NOT_FREE_TRIAL handling; 5 result branches; outer catch; finally cleanup）。
//
// 禁止：不得改任何分支、重试次数、状态字符串、错误消息或顺序。若某处看起来冗余，保持原样。
//
// 设计：success-finalization 是 DEFERRED 的（延迟到 paypal-pkce step）。
// 原始 paymentResult.success 分支（line 917-927）中的
// clearPaymentLink + clearAccessToken + _finalizePkce/saveCPAAuthFile + summary.success++
// 全部移至 paypal-pkce step，后者通过 ctx.outputs['paypal-pay'].paymentSuccess 路由。
// 这是 BY DESIGN，不是遗漏。

'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const { defineStep } = require('../step');
const { launchChrome, waitForCDP, findFreePort } = require('../../chrome');
// utils.js は repo 根（server/ より上）にある。server/pipeline/steps/ から ../../../utils
const { randomDelay } = require('../../../utils');
const { killTree } = require('../../process-utils');

// ROOT 相对于 server/pipeline/steps/ → 上三级到 repo 根
const ROOT = path.join(__dirname, '..', '..', '..');

// --------------------------------------------------------------------------
// paypalPayStep 工厂函数
// --------------------------------------------------------------------------

/**
 * paypalPayStep() 返回 defineStep({ id:'paypal-pay', label:'支付', shouldSkip, run })。
 *
 * ctx.deps 约定（由 engine-shell 在运行时注入）：
 *   emitStatus(data)       — 原始 engine.emitStatus（含 proxyNode/exitIp 注入）
 *   summary                — 共享可变计数器 { error, noLink, aborted (懒初始化), ... }
 *   progress               — 当前进度字符串，如 "3/10"
 *   proxyMgr               — require('../../proxy') 的同一实例
 *   abortController        — AbortController（原始 this._abortController），signal 传给 autoPayment
 *   resources              — 可变袋；本步存入 resources.chromeProc / resources.browser / resources.tempDir
 *                            finally 中清回 null（镜像原始 this._browser=null 等）
 *   runtimeCfg             — 本轮解析的 config.json（enableOAuth 等 — 由 paypal-pkce step 消费）
 *
 * ctx.outputs['paypal-fetch'] 约定（由 paypal-fetch step 写入）：
 *   { link, pk, fetchResult, usedCachedLink }
 *
 * ctx.flags 读取：
 *   alreadyPlus            — true 时 shouldSkip 返回 true（已 Plus 账号跳过支付）
 *
 * ctx.outputs['paypal-pay'] 写入（成功时）：
 *   { paymentSuccess: true }  — paypal-pkce step 读取此字段决定是否做成功收尾
 *
 * 测试接缝（仅供单元测试注入，生产不传）：
 *   ctx.deps.__launchChrome  — 替换真正的 launchChrome，避免测试启动真实 Chrome
 *   ctx.deps.__waitForCDP   — 替换真正的 waitForCDP，避免测试等待 CDP
 *   ctx.deps.__findFreePort — 替换真正的 findFreePort，避免测试占用端口
 *   ctx.deps.__autoPayment  — 替换真正的 autoPayment，避免测试运行真实支付流程
 */
function paypalPayStep() {
  return defineStep({
    id: 'paypal-pay',
    label: '支付',

    // shouldSkip: 已 Plus 账号跳过支付（paypal-pkce step 处理 already-Plus 成功收尾）。
    shouldSkip(ctx) {
      return !!ctx.flags.alreadyPlus;
    },

    async run(ctx) {
      const { account } = ctx;
      const {
        emitStatus,
        summary,
        progress,
        proxyMgr,
        abortController,
        resources,
      } = ctx.deps;

      // 测试接缝：允许注入替代实现，跳过真实 Chrome / autoPayment
      const _launchChrome  = ctx.deps.__launchChrome  || launchChrome;
      const _waitForCDP    = ctx.deps.__waitForCDP    || waitForCDP;
      const _findFreePort  = ctx.deps.__findFreePort  || findFreePort;
      // autoPayment 是懒加载的，以避免在模块加载时解析 payment.js 内部依赖
      // payment.js は repo 根にある。server/pipeline/steps/ から ../../../payment
      const _autoPayment   = ctx.deps.__autoPayment   || require('../../../payment').autoPayment;

      // 从 paypal-fetch step 的产物中取 link
      const link = ctx.outputs['paypal-fetch'].link;

      // ======================================================================
      // protocol-engine.js:847-848
      // findFreePort: avoid colliding with any chrome already listening on
      // 9222 (e.g. superpowers-chrome MCP), which would otherwise silently
      // make Playwright connect to the wrong browser and run the entire
      // payment flow in the wrong incognito session.
      // ======================================================================
      // D-Pay3: port/tempDir 仅在 protocol 路径（need launch）时生成；
      // browser 模式下若已有 resources.browser，这两个变量不会被 launch 路径使用，
      // 但 finally 的 tempDir 清理需要局部变量存在（browser 模式 finally 是 no-op，
      // 所以实际上不影响，只是提前生成以简化分支）。
      const port    = await _findFreePort();
      const tempDir = path.join(os.tmpdir(), `proto-pay-${Date.now()}-${Math.floor(Math.random() * 100000)}`);
      let chromeProc = null, browser = null;

      try {
        // ====================================================================
        // protocol-engine.js:851
        // ====================================================================
        emitStatus({ email: account.email, status: 'running', phase: 'payment', progress });
        console.log(`[${progress}] Opening payment: ${link}`);

        // ====================================================================
        // protocol-engine.js:853-858
        // v2.42: 不再显式传 proxyServer，launchChrome 默认读 process.env.HTTPS_PROXY
        // 存入 resources 袋（镜像原始 this._chromeProc/_browser/_tempDir）
        //
        // D-Pay1 (browser-engine.md C1): browser mode 下 login strategy 可能已在
        // Phase 1 启动了 Chrome 并写入 resources.browser（engine.js:271-281）；
        // 或缓存登录跳过了 Phase 1（resources.browser===null），此时需要懒启动
        // （engine.js:499-505）。仅当 resources.browser 为 null（协议模式 + 浏览器
        // 缓存登录懒启动）时才执行 launchChrome，否则直接复用已有 browser。
        // ====================================================================
        if (ctx.deps.resources.browser) {
          // browser mode: Phase 1 已启动 Chrome，复用已有 browser/chromeProc/tempDir
          // （engine.js:507 直接 browser.contexts()[0]，不 re-launch）
          browser    = ctx.deps.resources.browser;
          chromeProc = ctx.deps.resources.chromeProc;
          // tempDir 已由 login strategy 持有，不用本地 tempDir 变量（finally no-op）
        } else {
          // protocol mode（或浏览器缓存登录懒启动）：正常 launchChrome + waitForCDP
          chromeProc = _launchChrome(port, tempDir, {});
          browser    = await _waitForCDP(port);
          resources.chromeProc = chromeProc;
          resources.browser    = browser;
          resources.tempDir    = tempDir;
        }

        const bCtx = browser.contexts()[0];
        const page = bCtx.pages()[0] || await bCtx.newPage();

        // ====================================================================
        // protocol-engine.js:862
        // ====================================================================
        await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

        // ====================================================================
        // protocol-engine.js:867-892
        // If the page landed on chrome-error (ERR_CONNECTION_CLOSED, etc.) the
        // current proxy node can't reach pay.openai.com. Blacklist it, rotate,
        // and retry once on a fresh route before giving up.
        // ====================================================================
        let pageUrl = page.url();
        if (pageUrl.startsWith('chrome-error://') || pageUrl === 'about:blank') {
          const badNode = proxyMgr.getState().currentNode;
          console.log(`[${progress}] Payment page unreachable via ${badNode} (${pageUrl.slice(0, 40)}); counting + rotating + retrying`);
          if (proxyMgr.getState().enabled) {
            try { proxyMgr.recordBadAttempt(badNode, 'main', 'payment_unreachable'); } catch {}
            try { const n = await proxyMgr.rotate(); console.log(`[${progress}] Retrying payment on ${n}`); } catch {}
          }
          await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          pageUrl = page.url();
          if (pageUrl.startsWith('chrome-error://') || pageUrl === 'about:blank') {
            if (proxyMgr.getState().enabled) {
              try { proxyMgr.recordBadAttempt(proxyMgr.getState().currentNode, 'main', 'payment_unreachable'); } catch {}
            }
            throw new Error(`Payment page unreachable after node rotation (${pageUrl.slice(0, 40)})`);
          }
          // 重试后真实页面打开 → 算 G3 成功
          if (proxyMgr.getState().enabled) {
            try { proxyMgr.recordGoodAttempt(proxyMgr.getState().currentNode, 'main'); } catch {}
          }
        } else {
          // G3: 一次到位也算成功
          if (proxyMgr.getState().enabled) {
            try { proxyMgr.recordGoodAttempt(proxyMgr.getState().currentNode, 'main'); } catch {}
          }
        }

        // ====================================================================
        // protocol-engine.js:894-895
        // ====================================================================
        try { await page.locator('text=PayPal').first().waitFor({ state: 'visible', timeout: 15000 }); } catch {}
        await randomDelay(2000, 3000);

        console.log(`[${progress}] Auto-filling payment...`);

        // ====================================================================
        // protocol-engine.js:898-915
        // v2.43.3: 每账号重读 config.json (mirror PipelineEngine server/engine.js:548-550).
        //   让用户运行时改 config (e.g. 切手机号池) 不用重启 batch。
        //   ROOT 已在模块顶部定义（repo 根，与原始 protocol-engine.js __dirname 等价）。
        // ====================================================================
        let paymentResult = { success: false };
        try {
          const freshCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
          const slot = freshCfg.phoneSlots?.[0] || { phone: freshCfg.phone, smsApiUrl: freshCfg.smsApiUrl };
          paymentResult = await _autoPayment(page, { phone: slot.phone, smsApiUrl: slot.smsApiUrl, email: account.email }, { signal: abortController.signal }) || { success: false };
        } catch (e) {
          if (e.code === 'NOT_FREE_TRIAL') {
            // Link is not a $0 trial — treat as no_link (same outcome as Discord
            // failing to produce a link). Don't fill cards on a paid subscription page.
            console.log(`[${progress}] ${e.message}`);
            paymentResult = { success: false, notFreeTrial: true, reason: e.message };
          } else {
            console.log(`[${progress}] Payment error: ${e.message?.slice(0, 60)}`);
          }
        }

        // ====================================================================
        // protocol-engine.js:917-944
        // 五路结果分流：
        //
        // (1) success → DEFERRED to paypal-pkce step（BY DESIGN，非遗漏）。
        //     原始 line 917-927 的
        //       clearPaymentLink + clearAccessToken + _finalizePkce/saveCPAAuthFile + summary.success++
        //     由 paypal-pkce step 通过 ctx.outputs['paypal-pay'].paymentSuccess 路由执行。
        //     本 step 仅写 { paymentSuccess: true } 到 outputs 并 return { ok: true }。
        //
        // (2) aborted → emit aborted/payment + summary.aborted++ + ok:false
        // (3) notFreeTrial → emit no_link/done + summary.noLink++ + ok:false
        // (4) status passthrough → emit {status}/payment + summary.error++ + ok:false
        // (5) else (no status) → emit error/payment + summary.error++ + ok:false
        // ====================================================================
        if (paymentResult.success) {
          // SUCCESS: 成功收尾（clear + pkce/save + summary.success++）DEFERRED 到 paypal-pkce step。
          // paypal-pkce step 读取 ctx.outputs['paypal-pay'].paymentSuccess === true 作为路由信号。
          ctx.outputs['paypal-pay'] = { paymentSuccess: true };
          return { ok: true };
        } else if (paymentResult.status === 'aborted') {
          console.log(`[${progress}] Payment aborted by user`);
          emitStatus({ email: account.email, status: 'aborted', phase: 'payment', progress, reason: 'Stopped by user' });
          summary.aborted = (summary.aborted || 0) + 1;
          ctx.flags.finalStatus = 'aborted';
          ctx.flags.finalReason = 'Stopped by user';
          ctx.flags.finalPaymentLink = '';
          return { ok: false, reason: 'aborted' };
        } else if (paymentResult.notFreeTrial) {
          emitStatus({ email: account.email, status: 'no_link', phase: 'done', progress, reason: paymentResult.reason });
          summary.noLink++;
          ctx.flags.finalStatus = 'no_link';
          ctx.flags.finalReason = paymentResult.reason;
          ctx.flags.finalPaymentLink = '';
          return { ok: false, reason: 'not_free_trial' };
        } else if (paymentResult.status) {
          const reason = paymentResult.reason || 'Payment not completed';
          console.log(`[${progress}] Payment incomplete: ${reason}`);
          emitStatus({ email: account.email, status: paymentResult.status, phase: 'payment', progress, reason });
          summary.error++;
          ctx.flags.finalStatus = paymentResult.status;
          ctx.flags.finalReason = reason;
          ctx.flags.finalPaymentLink = '';
          return { ok: false, reason };
        } else {
          const reason = paymentResult.reason || 'Payment not completed';
          console.log(`[${progress}] Payment incomplete: ${reason}`);
          emitStatus({ email: account.email, status: 'error', phase: 'payment', progress, reason });
          summary.error++;
          ctx.flags.finalStatus = 'error';
          ctx.flags.finalReason = reason;
          ctx.flags.finalPaymentLink = '';
          return { ok: false, reason };
        }
      } catch (e) {
        // ====================================================================
        // protocol-engine.js:946-949
        // 外层 catch：非 autoPayment 内部异常（如 chrome-error retry 耗尽抛出）
        // ====================================================================
        console.log(`[${progress}] ${account.email} error: ${e.message?.slice(0, 500)}`);
        emitStatus({ email: account.email, status: 'error', phase: 'payment', progress, reason: e.message });
        summary.error++;
        ctx.flags.finalStatus = 'error';
        ctx.flags.finalReason = e.message;
        ctx.flags.finalPaymentLink = '';
        return { ok: false, reason: e.message };
      } finally {
        // ====================================================================
        // protocol-engine.js:950-960
        // finally 必须在 success/failure 所有路径上运行（镜像原始行为）。
        // Windows: chromeProc.kill() = SIGTERM, which Chrome's GUI/renderer
        // subprocesses ignore (see process-utils.js header). Without killTree,
        // the parent chrome.exe lingers and Chrome auto-opens an about:blank
        // tab to replace the CDP-closed page — visible as a phantom window.
        //
        // D-Pay1 / C1 (browser-engine.md): browser mode 下 Chrome 生命周期由
        // engine-shell 的账号循环 finally（engine.js:647-657）统一管理，
        // paypal-pkce step 之后的 CPA 阶段仍需要 browser，本 step 的 finally
        // 必须是 no-op（不关闭 browser，不 null resources）。
        // ctx.deps.browserMode 为 falsy（协议模式）时，执行原有清理逻辑不变。
        // ====================================================================
        if (!ctx.deps.browserMode) {
          // protocol mode（或未迁移的浏览器模式）：原有清理逻辑，字节完全相同
          if (browser) try { await browser.close(); } catch {}
          if (chromeProc) try { killTree(chromeProc.pid); } catch {}
          if (chromeProc) try { chromeProc.kill(); } catch {}
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
          // 清空 resources 袋（镜像原始 this._browser=null 等）
          resources.browser    = null;
          resources.chromeProc = null;
          resources.tempDir    = null;
        }
        // browser mode: engine-shell 账号循环 finally（engine.js:647-657）负责清理；
        // resources.browser/chromeProc/tempDir 保持存在，供 paypal-pkce + CPA step 使用。
      }
    },
  });
}

module.exports = { paypalPayStep };
