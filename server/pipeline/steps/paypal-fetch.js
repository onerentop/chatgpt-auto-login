// server/pipeline/steps/paypal-fetch.js
// P1 迁移：把 ProtocolEngine.start() 中的 Phase 2（获取支付链接）行为逐行搬运到独立 step。
//
// 行为来源：protocol-engine.js 第 744–820 行（emit running/discord|checkout；Discord gateway
// 重连；REUSE_STATUSES 缓存链接快路径；3 次重试循环 getPaymentLink/fetchCheckoutLink；
// noJpProxy/no_link/transient-retry-with-2s-backoff/error；if(!link) gate；
// persist-before-verify）。
//
// 禁止：不得改任何分支、重试次数、状态字符串、错误消息或顺序。若某处看起来冗余，保持原样。

'use strict';

const { defineStep } = require('../step');
const { connectGateway, getPaymentLink } = require('../../discord-gateway');
const { fetchCheckoutLink } = require('../../chatgpt-checkout');

// --------------------------------------------------------------------------
// paypalFetchStep 工厂函数
// --------------------------------------------------------------------------

/**
 * paypalFetchStep() 返回 defineStep({ id:'paypal-fetch', label:'获取支付链接', shouldSkip, run })。
 *
 * ctx.deps 约定（由 engine-shell 在运行时注入）：
 *   emitStatus(data)       — 原始 engine.emitStatus（含 proxyNode/exitIp 注入）
 *   summary                — 共享可变计数器 { noLink, noJpProxy, error, ... }
 *   progress               — 当前进度字符串，如 "3/10"
 *   linkSource             — 'api' 或 'discord'
 *   resources              — 可变袋；Discord gateway 在 ctx.deps.resources.gw
 *   statusDB               — DB handle（persist-before-verify 用）
 *
 * ctx.outputs.login 约定（由 login step 写入）：
 *   { accessToken, session, planType }
 *
 * ctx.flags 读取：
 *   alreadyPlus            — true 时 shouldSkip 返回 true，跳过链接获取
 *
 * 测试接缝（仅供单元测试注入，生产不传）：
 *   ctx.deps.__fetchCheckoutLink  — 替换真正的 fetchCheckoutLink，避免测试发起网络请求
 *   ctx.deps.__getPaymentLink     — 替换真正的 getPaymentLink，避免测试连 Discord
 *   ctx.deps.__connectGateway     — 替换真正的 connectGateway，避免测试重连 Discord
 */
function paypalFetchStep() {
  return defineStep({
    id: 'paypal-fetch',
    label: '获取支付链接',

    // shouldSkip: 已 Plus 账号不需要获取支付链接。
    // 注意：缓存链接复用（REUSE_STATUSES 快路径）不是 shouldSkip —— 它在 run() 内部处理，
    // 以保留 emitStatus running/checkout|discord 的字节级别一致性。
    shouldSkip(ctx) {
      return !!ctx.flags.alreadyPlus;
    },

    async run(ctx) {
      const { account, email } = ctx;
      const {
        emitStatus,
        summary,
        progress,
        linkSource,
        resources,
        statusDB,
      } = ctx.deps;

      // 测试接缝：允许注入替代实现，跳过真实网络调用
      const _fetchCheckoutLink = ctx.deps.__fetchCheckoutLink || fetchCheckoutLink;
      const _getPaymentLink    = ctx.deps.__getPaymentLink    || getPaymentLink;
      const _connectGateway    = ctx.deps.__connectGateway    || connectGateway;

      // ======================================================================
      // protocol-engine.js:744-745
      // Phase 2: Payment link (retry up to 3 times on transient errors)
      // ======================================================================
      const phaseTag = linkSource === 'discord' ? 'discord' : 'checkout';
      emitStatus({ email: account.email, status: 'running', phase: phaseTag, progress });
      console.log(`[${progress}] ${phaseTag === 'discord' ? 'Discord' : 'Checkout'}: ${account.email}...`);
      let link;
      let fetchResult = null;

      // ======================================================================
      // protocol-engine.js:751-756
      // Reconnect Gateway only when using Discord path
      // ======================================================================
      if (linkSource === 'discord' && resources.gw?.ws?.readyState !== 1) {
        console.log(`[${progress}] Gateway disconnected, reconnecting...`);
        try { resources.gw?.cleanup(); } catch {}
        resources.gw = await _connectGateway();
        console.log(`[${progress}] Gateway reconnected`);
      }

      // ======================================================================
      // protocol-engine.js:758-770
      // Cache check: if this account failed in Phase 3+ on a previous run,
      // it may have a usable Stripe link still in the DB. Reuse it to skip
      // Phase 2 (fetch) + Phase 2.5 (verify). Phase 3's NOT_FREE_TRIAL
      // detector handles stale links by throwing → status='no_link', which
      // won't be in REUSE_STATUSES on the next retry → forced full refetch.
      // ======================================================================
      const REUSE_STATUSES = new Set(['error', 'aborted', 'paypal_captcha', 'verify_error']);
      let usedCachedLink = false;
      const prevPersisted = ctx.getPersisted();
      if (prevPersisted.payment_link && REUSE_STATUSES.has(prevPersisted.status)) {
        link = prevPersisted.payment_link;
        fetchResult = { link, pk: prevPersisted.payment_link_pk || '', title: 'cached', raw: '' };
        usedCachedLink = true;
        console.log(`[${progress}] Phase 2: reusing cached payment link (was ${prevPersisted.status} at ${prevPersisted.payment_link_at})`);
      }

      // ======================================================================
      // protocol-engine.js:772-808
      // 链接获取循环（最多 3 次），仅非缓存命中时进入
      // ======================================================================
      let linkFetchOk = usedCachedLink;
      if (!usedCachedLink) {
        for (let dRetry = 0; dRetry < 3; dRetry++) {
          try {
            if (dRetry > 0) console.log(`[${progress}] Link fetch retry ${dRetry + 1}/3...`);
            if (linkSource === 'discord') {
              fetchResult = await _getPaymentLink(resources.gw, ctx.outputs.login.accessToken);
            } else {
              fetchResult = await _fetchCheckoutLink(ctx.outputs.login.accessToken);
            }
            link = fetchResult.link;
            if (link) console.log(`[${progress}] ${fetchResult.title || 'Link obtained'}`);
            console.log(`[${progress}] Link: ${link || 'none'}`);
            if (fetchResult.noJpProxy) {
              console.log(`[${progress}] No JP proxy — skipping account`);
              emitStatus({ email: account.email, status: 'no_jp_proxy', phase: 'done', progress, reason: 'JP checkout channel unavailable' });
              summary.noJpProxy++;
            } else if (!link) {
              console.log(`[${progress}] ${(fetchResult.raw || 'No link').slice(0, 500)}`);
              emitStatus({ email: account.email, status: 'no_link', phase: 'done', progress, reason: fetchResult.raw });
              summary.noLink++;
            }
            linkFetchOk = true;
            break;
          } catch (e) {
            console.log(`[${progress}] Link fetch error: ${e.message?.slice(0, 60)}`);
            if (dRetry < 2 && (e.message?.includes('Timeout') || e.message?.includes('fetch'))) {
              await new Promise(r2 => setTimeout(r2, 2000));
              continue;
            }
            emitStatus({ email: account.email, status: 'error', phase: phaseTag, progress, reason: e.message });
            summary.error++;
            linkFetchOk = true;
            break;
          }
        }
      }

      // ======================================================================
      // protocol-engine.js:809
      // Gate: if no valid link obtained (noJpProxy/noLink/error branches all
      // end without setting link), abort this account.
      // ======================================================================
      if (!link) {
        // Determine reason for reporting
        let reason;
        if (fetchResult && fetchResult.noJpProxy) {
          reason = 'no_jp_proxy';
        } else if (fetchResult && !fetchResult.link) {
          reason = 'no_link';
        } else {
          reason = 'fetch_error';
        }
        return { ok: false, reason };
      }

      // ======================================================================
      // protocol-engine.js:811-820
      // Persist link to DB immediately so verify_error / Phase 3 retries
      // can skip Phase 2 next time. This is intentionally BEFORE verify —
      // if verify fails, the link is still cached for the next retry to
      // try (verify_error is one of REUSE_STATUSES).
      // ======================================================================
      if (link && !usedCachedLink) {
        statusDB.set(account.email, {
          status: 'running', phase: 'verify', progress,
          paymentLink: link, paymentLinkPk: fetchResult.pk || '',
        });
      }

      // ======================================================================
      // 成功：将产物写入 ctx.outputs['paypal-fetch']
      // ======================================================================
      ctx.outputs['paypal-fetch'] = {
        link,
        pk: fetchResult.pk || '',
        fetchResult,
        usedCachedLink,
      };

      return { ok: true };
    },
  });
}

module.exports = { paypalFetchStep };
