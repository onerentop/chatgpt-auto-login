/**
 * PipelineEngine - Core execution engine for the web dashboard.
 *
 * Wraps the same pipeline logic as the CLI index.js, but as an EventEmitter
 * so the Express/Socket.IO layer can stream progress to the frontend.
 *
 * Events emitted:
 *   'log'            → { email, phase, message, timestamp }
 *   'account-status' → { email, status, phase, progress, paymentLink?, reason? }
 *   'complete'       → { summary: { total, success, noLink, error } }
 */
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { LogCapture } = require('./logger');
const { connectGateway, getPaymentLink } = require('./discord-gateway');
const { fetchCheckoutLink } = require('./chatgpt-checkout');
const { verifyCheckoutIsFree } = require('./stripe-verify');
const { launchChrome, waitForCDP, findChrome } = require('./chrome');
const proxyMgr = require('./proxy');

const {
  saveCPAAuthFile,
  fetchTokensViaPKCE,
  randomDelay,
} = require('../utils');
const { statusDB } = require('./db');
const { loginAccount } = require('../login');
const { autoPayment } = require('../payment');
const { registerToCPA } = require('../cpa');

// ========== Paths ==========
const ROOT = path.join(__dirname, '..');

// ========== PipelineEngine ==========
function getDB() { return require('./db'); }

class PipelineEngine extends EventEmitter {
  constructor() {
    super();
    this.status = 'idle';
    this.stopFlag = false;
    this.logCapture = new LogCapture();
    this._runId = '';
    this._chromeProc = null;
    this._browser = null;
    this._abortController = null;
  }

  emitStatus(data) {
    this.emit('account-status', data);
    try { getDB().statusDB.set(data.email, data); } catch (e) { console.log(`[WARN] statusDB.set: ${e.message?.slice(0, 60)}`); }
  }

  /**
   * @returns {'idle' | 'running' | 'stopping'}
   */
  getStatus() {
    return this.status;
  }

  /**
   * Force stop — kill Chrome, close connections, reset immediately.
   */
  stop() {
    if (this.status !== 'idle') {
      this.stopFlag = true;
      if (this._abortController) try { this._abortController.abort(); } catch {}
      this.status = 'stopping';
      console.log('Force stopping pipeline...');

      // Kill Chrome processes launched by this engine
      if (this._chromeProc) {
        try { this._chromeProc.kill(); } catch {}
        this._chromeProc = null;
      }
      // Close browser CDP connection
      if (this._browser) {
        try { this._browser.close(); } catch {}
        this._browser = null;
      }
      this._abortController = null;
      // Close Discord Gateway
      if (this._gw) {
        try { this._gw.cleanup(); } catch {}
        this._gw = null;
      }
      // Clean temp dir
      if (this._tempDir) {
        try { fs.rmSync(this._tempDir, { recursive: true, force: true }); } catch {}
        this._tempDir = null;
      }

      // Reset any "running" accounts in DB to idle
      try {
        const { statusDB } = require('./db');
        if (statusDB.resetRunning) statusDB.resetRunning();
      } catch {}

      this.logCapture.stop();
      this.status = 'idle';
      this.emit('log', { email: '', phase: '', message: 'Pipeline force stopped.', timestamp: new Date().toISOString() });
    }
  }

  /**
   * Run the full pipeline starting from the given account index.
   * @param {number} startFrom - Zero-based account index to start from.
   */
  async start(startFrom = 0, filterEmails = null) {
    if (this.status !== 'idle') {
      throw new Error(`Engine is already ${this.status}`);
    }

    this.status = 'running';
    this.stopFlag = false;
    this._abortController = new AbortController();
    this._runId = `run_${Date.now()}`;

    let currentEmail = '';
    let currentPhase = '';

    // Cleanup old logs
    try { getDB().logsDB.cleanup(); } catch (e) { console.log(`[WARN] logsDB.cleanup: ${e.message?.slice(0, 60)}`); }

    // Hook console.log → emit 'log' events + write to per-account log files
    const logHandler = (message) => {
      const entry = {
        email: currentEmail,
        phase: currentPhase,
        message,
        timestamp: new Date().toISOString(),
      };
      this.emit('log', entry);

      // Save to DB
      if (currentEmail) {
        try { getDB().logsDB.add(currentEmail, currentPhase, message, entry.timestamp, this._runId); } catch (e) { console.log(`[WARN] logsDB.add: ${e.message?.slice(0, 60)}`); }
      }
    };
    this.logCapture.onLog(logHandler);
    this.logCapture.start();

    const allResults = [];
    const basePort = 19222;
    let gw = null;

    try {
      // Load accounts
      const { accountsDB } = require('./db');
      const accounts = accountsDB.list().map(a => ({
        email: a.email,
        password: a.password,
        loginType: a.login_type === 'google' ? 'google' : 'outlook',
        totp_secret: a.totp_secret || '',
        client_id: a.client_id || '',
        refresh_token: a.refresh_token || '',
      }));
      if (accounts.length === 0) throw new Error('No accounts in database');
      if (!findChrome()) throw new Error('Chrome not found!');

      // Filter by selected emails if provided
      let filtered = accounts;
      if (filterEmails && filterEmails.length > 0) {
        const emailSet = new Set(filterEmails.map(e => e.toLowerCase()));
        filtered = accounts.filter(a => emailSet.has(a.email.toLowerCase()));
      }
      if (filtered.length === 0) throw new Error('No matching accounts to execute');

      console.log(`Loaded ${filtered.length} accounts to process.`);

      // Determine payment-link source from config; default 'api' (direct ChatGPT call).
      // 'discord' falls back to the legacy WebSocket bot path.
      const rootCfgForSource = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
      const linkSource = rootCfgForSource.paymentLinkSource || 'api';
      console.log(`Payment link source: ${linkSource}`);

      // Connect Discord Gateway only when needed.
      if (linkSource === 'discord') {
        currentPhase = 'discord-connect';
        console.log('Connecting to Discord Gateway...');
        gw = await connectGateway();
        this._gw = gw;
        console.log('Discord connected!');
      }

      // Process each account
      for (let i = 0; i < filtered.length; i++) {
        if (this.stopFlag) {
          console.log('Stop requested, breaking out of loop.');
          break;
        }

        const account = filtered[i];
        currentEmail = account.email;
        const progress = `${i + 1}/${filtered.length}`;
        const p = `[${progress}]`;

        // Snapshot the persisted row BEFORE any emitStatus call wipes status
        // to 'running'. The cache-check further down reads this snapshot, not
        // the live DB row, so the user's previous failure (verify_error etc.)
        // remains visible after we transition into the new run.
        const prevPersisted = statusDB.get(account.email) || {};

        // Cached-login fast path: if a previous login persisted a JWT and the
        // exp is still in the future (with 60s buffer), reconstitute
        // loginResult from the DB and skip the browser login entirely.
        const JWT_BUFFER_SEC_LOGIN = 60;
        let loginResult = null;
        if (prevPersisted.last_access_token) {
          const { decodeJwtExp } = require('./liveness/checker');
          const exp = decodeJwtExp(prevPersisted.last_access_token);
          if (exp > Date.now() / 1000 + JWT_BUFFER_SEC_LOGIN) {
            let session = null;
            try { session = JSON.parse(prevPersisted.last_session_json || '{}'); }
            catch { session = null; }
            if (session) {
              loginResult = {
                accessToken: prevPersisted.last_access_token,
                session,
                lastOtp: '',
              };
              const minLeft = Math.floor((exp - Date.now() / 1000) / 60);
              console.log(`${p} Phase 1: reusing cached access token (exp in ${minLeft} min)`);
              this.emitStatus({ email: account.email, status: 'running', phase: 'cached-login', progress });
            }
          }
        }

        console.log(`${p} === ${account.email} ===`);

        const port = basePort + i;
        const tempDir = path.join(os.tmpdir(), `chatgpt-login-${Date.now()}`);
        this._chromeProc = null;
        this._browser = null;
        this._tempDir = tempDir;
        let finalResult = { email: account.email, status: 'error', paymentLink: '', reason: '' };
        let browser = null;

        // Rotate proxy node before each account (if proxy enabled)
        if (proxyMgr.getState().enabled) {
          try {
            const node = await proxyMgr.rotate();
            console.log(`${p} Proxy rotated → ${node}`);
          } catch (e) {
            console.log(`${p} Proxy rotate failed: ${e.message?.slice(0, 60)}`);
          }
        }

        try {
          if (this.stopFlag) break;
          if (!loginResult) {
          // Phase 1: Login & get accessToken
          currentPhase = 'login';
          this.emitStatus( {
            email: account.email,
            status: 'running',
            phase: 'login',
            progress,
          });
          console.log(`${p} Phase 1: Login...`);
          this._chromeProc = launchChrome(port, tempDir, { proxyServer: proxyMgr.getProxyUrl() || undefined });
          this._browser = await waitForCDP(port);
          browser = this._browser;
          loginResult = await loginAccount(browser, account);

          if (loginResult.status !== 'success' || !loginResult.accessToken) {
            const isDeactivated = loginResult.status === 'deactivated';
            const statusOut = isDeactivated ? 'deactivated' : 'error';
            console.log(`${p} Login ${isDeactivated ? 'account_deactivated' : 'failed'}: ${loginResult.reason || loginResult.status}`);
            // T9: 失败 reason 是网络类才算节点错误；deactivated / 密码错误等不算
            if (!isDeactivated && proxyMgr.isProxyNetError(loginResult.reason)) {
              if (proxyMgr.getState().enabled) {
                try { proxyMgr.recordBadAttempt(proxyMgr.getState().currentNode, 'main', 'login_net_error'); } catch {}
              }
            } else if (isDeactivated) {
              // deactivated 是账号问题，节点工作正常
              if (proxyMgr.getState().enabled) {
                try { proxyMgr.recordGoodAttempt(proxyMgr.getState().currentNode, 'main'); } catch {}
              }
            }
            finalResult.status = statusOut;
            finalResult.reason = isDeactivated ? 'account_deactivated' : `Login: ${loginResult.reason || loginResult.status}`;
            allResults.push(finalResult);

            this.emitStatus({
              email: account.email,
              status: statusOut,
              phase: isDeactivated ? 'done' : 'login',
              progress,
              reason: finalResult.reason,
            });
            continue;
          }
          // G2: 登录成功
          if (proxyMgr.getState().enabled) {
            try { proxyMgr.recordGoodAttempt(proxyMgr.getState().currentNode, 'main'); } catch {}
          }
          console.log(`${p} Login OK, accessToken obtained.`);
          } // end if (!loginResult)

          // Persist the freshly-obtained token so the next retry can skip
          // the browser login entirely. status: 'running' explicitly passed;
          // without it, statusDB.set's destructuring default would revert
          // status to 'idle' and the running-account would flicker off the
          // UI for one frame.
          if (loginResult && loginResult.accessToken) {
            statusDB.set(account.email, {
              status: 'running',
              phase: 'login',
              progress,
              accessToken: loginResult.accessToken,
              sessionJson: JSON.stringify(loginResult.session || {}),
            });
          }

          // Check plan type from session
          const planType =
            loginResult.session?.account?.planType ||
            loginResult.session?.chatgpt_plan_type ||
            'free';
          const isPlusOrAbove = ['plus', 'pro', 'team', 'enterprise'].includes(planType.toLowerCase());
          console.log(`${p} Plan: ${planType} (${isPlusOrAbove ? 'Plus member' : 'Not Plus'})`);

          if (isPlusOrAbove) {
            statusDB.clearPaymentLink(account.email);
            statusDB.clearAccessToken(account.email);
            console.log(`${p} Already Plus!`);
            finalResult = { email: account.email, status: 'plus_no_rt', paymentLink: '', reason: '' };

            const latestCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
            if (latestCfg.enableOAuth) {
              console.log(`${p} Running PKCE for already-Plus account...`);
              this.emitStatus({ email: account.email, status: 'running', phase: 'pkce', progress });
              const pkceTokens = await fetchTokensViaPKCE(browser, account, loginResult.lastOtp).catch((e) => { console.log(`  [PKCE] Failed: ${e.message}`); return null; });
              if (pkceTokens && !pkceTokens.needsPhone && pkceTokens.refresh_token) {
                saveCPAAuthFile(account.email, pkceTokens.access_token, pkceTokens);
                finalResult.status = 'plus';
              } else {
                if (pkceTokens?.needsPhone) console.log(`${p} PKCE requires phone verification`);
                else if (pkceTokens && !pkceTokens.refresh_token) console.log(`${p} PKCE returned no refresh_token`);
                saveCPAAuthFile(account.email, pkceTokens?.access_token || loginResult.accessToken, pkceTokens || loginResult.session);
              }
            } else {
              saveCPAAuthFile(account.email, loginResult.accessToken, loginResult.session);
            }

            if (latestCfg.enableCPA) {
              console.log(`${p} CPA registration...`);
              this.emitStatus({ email: account.email, status: 'running', phase: 'cpa', progress });
              try {
                const cpaOk = await registerToCPA(browser, account.email, account);
                if (cpaOk) console.log(`${p} CPA OAuth done.`);
                else console.log(`${p} CPA OAuth may have issues, check manually.`);
              } catch (e) {
                console.log(`${p} CPA error: ${e.message}`);
              }
            }
          } else {
            // Not Plus → full payment flow
            // Phase 2: payment link fetch (retry up to 3 times on transient errors)
            currentPhase = linkSource === 'discord' ? 'discord' : 'checkout';
            console.log(`${p} Phase 2: payment link via ${linkSource}...`);
            // Cache check: skip Phase 2 fetch + Phase 2.5 verify when this
            // account previously failed in Phase 3+ and has a usable Stripe
            // link in the DB. Phase 3's NOT_FREE_TRIAL detector handles
            // stale links (becomes status='no_link', which is not in
            // REUSE_STATUSES → next retry forces full refetch).
            const REUSE_STATUSES = new Set(['error', 'aborted', 'paypal_captcha', 'verify_error']);
            let usedCachedLink = false;

            this.emitStatus({ email: account.email, status: 'running', phase: currentPhase, progress });
            let discord;  // keep variable name to minimize downstream diff
            if (prevPersisted.payment_link && REUSE_STATUSES.has(prevPersisted.status)) {
              discord = { link: prevPersisted.payment_link, pk: prevPersisted.payment_link_pk || '', title: 'cached', raw: '' };
              usedCachedLink = true;
              console.log(`${p} Phase 2: reusing cached payment link (was ${prevPersisted.status} at ${prevPersisted.payment_link_at})`);
            }
            if (!usedCachedLink) {
              for (let dRetry = 0; dRetry < 3; dRetry++) {
                try {
                  if (dRetry > 0) console.log(`${p} Link fetch retry ${dRetry + 1}/3...`);
                  if (linkSource === 'discord') {
                    discord = await getPaymentLink(gw, loginResult.accessToken);
                  } else {
                    discord = await fetchCheckoutLink(loginResult.accessToken);
                  }
                  break;
                } catch (de) {
                  console.log(`${p} Link fetch error: ${de.message?.slice(0, 60)}`);
                  if (dRetry < 2 && (de.message?.includes('Timeout') || de.message?.includes('fetch'))) {
                    await new Promise(r => setTimeout(r, 2000));
                    continue;
                  }
                  throw de;
                }
              }
            }

            if (discord.noJpProxy) {
              // === Phase 2.5 分支 A: JP 不可用 ===
              console.log(`${p} No JP proxy — skipping account`);
              finalResult = {
                email: account.email,
                status: 'no_jp_proxy',
                paymentLink: '',
                reason: 'JP checkout channel unavailable',
              };
            } else if (!discord.link) {
              // === 分支 B: 拿不到 link（现有 no_link 行为）===
              console.log(`${p} No link: ${discord.raw.slice(0, 150)}`);
              finalResult = {
                email: account.email,
                status: 'no_link',
                paymentLink: '',
                reason: discord.raw.slice(0, 200),
              };
            } else {
              // === 分支 C: 拿到 link → Phase 2.5 Stripe 验证 ===
              console.log(`${p} ${discord.title}`);
              console.log(`${p} Link: ${discord.link.slice(0, 80)}...`);
              // Persist link to DB immediately so verify_error / Phase 3 retries
              // can skip Phase 2 next time. Guard with !usedCachedLink so a
              // cached-link rerun doesn't refresh payment_link_at.
              if (!usedCachedLink) {
                statusDB.set(account.email, {
                  status: 'running', phase: 'verify', progress,
                  paymentLink: discord.link, paymentLinkPk: discord.pk || '',
                });
              }
              // Discord path: bot is authority for $0 eligibility (it only returns $0 links).
              // API path: enforce Phase 2.5 verify to fail-fast on non-$0 links.
              let v;
              if (linkSource === 'discord') {
                console.log(`${p} Phase 2.5: skipped (Discord path — bot is eligibility authority)`);
                v = { ok: true, is_free: true, coupons: [] };
              } else {
                currentPhase = 'verify';
                console.log(`${p} Phase 2.5: Verifying $0 via Stripe init...`);
                this.emitStatus({ email: account.email, status: 'running', phase: 'verify', progress });
                v = await verifyCheckoutIsFree(discord.link, discord.pk);
              }

              if (!v.ok) {
                // C1: Stripe init 失败
                console.log(`${p} Verify failed: ${v.reason}`);
                finalResult = {
                  email: account.email,
                  status: 'verify_error',
                  paymentLink: discord.link,
                  reason: `Stripe init: ${v.reason}`,
                };
              } else if (!v.is_free) {
                // C2: link 不是 $0
                console.log(`${p} Not free: amount_due=${v.amount_due} ${v.currency}`);
                finalResult = {
                  email: account.email,
                  status: 'no_promo',
                  paymentLink: discord.link,
                  reason: `amount_due=${v.amount_due} ${v.currency}`,
                };
              } else {
                // C3: 验证通过 → 进入 Phase 3（原有 Phase 3 + Phase 4 代码块整体放在这里，不变）
                console.log(`${p} ✓ Verified $0 + coupons=[${v.coupons.join(',')}]`);
                finalResult = { email: account.email, status: 'error', paymentLink: discord.link, reason: '' };

                // Phase 3: Open payment link & auto-fill
                currentPhase = 'payment';
                console.log(`${p} Phase 3: Opening payment page...`);
                this.emitStatus({ email: account.email, status: 'running', phase: 'payment', progress });
                const ctx = browser.contexts()[0];
                const pages = ctx.pages();
                const page = pages.length > 0 ? pages[0] : await ctx.newPage();
                await page.goto(discord.link, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

                // Node-level connectivity failure: if the page landed on
                // chrome-error (ERR_CONNECTION_CLOSED, ERR_TIMED_OUT, etc.)
                // or stayed on about:blank, the current sing-box node can't
                // reach pay.openai.com. Blacklist it, rotate, and retry once
                // before giving up. Mirrors protocol-engine.js so browser
                // mode doesn't burn an account on a single bad node.
                let pageUrl = page.url();
                if (pageUrl.startsWith('chrome-error://') || pageUrl === 'about:blank') {
                  const badNode = proxyMgr.getState().currentNode;
                  console.log(`${p} Payment page unreachable via ${badNode} (${pageUrl.slice(0, 40)}); counting + rotating + retrying`);
                  if (proxyMgr.getState().enabled) {
                    try { proxyMgr.recordBadAttempt(badNode, 'main', 'payment_unreachable'); } catch {}
                    try { const n = await proxyMgr.rotate(); console.log(`${p} Retrying payment on ${n}`); } catch {}
                  }
                  await page.goto(discord.link, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                  pageUrl = page.url();
                  if (pageUrl.startsWith('chrome-error://') || pageUrl === 'about:blank') {
                    if (proxyMgr.getState().enabled) {
                      try { proxyMgr.recordBadAttempt(proxyMgr.getState().currentNode, 'main', 'payment_unreachable'); } catch {}
                    }
                    throw new Error(`Payment page unreachable after node rotation (${pageUrl.slice(0, 40)})`);
                  }
                  if (proxyMgr.getState().enabled) {
                    try { proxyMgr.recordGoodAttempt(proxyMgr.getState().currentNode, 'main'); } catch {}
                  }
                } else {
                  if (proxyMgr.getState().enabled) {
                    try { proxyMgr.recordGoodAttempt(proxyMgr.getState().currentNode, 'main'); } catch {}
                  }
                }

                // Pre-warm: let Stripe paint the PayPal accordion before
                // autoPayment's readiness checks run. Soft timeout — failure
                // just means slow load; autoPayment's waitForPageReady will
                // still wait on the actual required elements.
                try { await page.locator('text=PayPal').first().waitFor({ state: 'visible', timeout: 15000 }); } catch {}
                await randomDelay(2000, 3000);

                console.log(`${p} Phase 3: Auto-filling payment...`);
                let paymentOk = false;
                let paymentReason = '';
                let paymentStatus = '';
                try {
                  const freshCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));
                  const phoneSlot = freshCfg.phoneSlots?.[0] || { phone: freshCfg.phone, smsApiUrl: freshCfg.smsApiUrl };
                  const payResult = await autoPayment(page, { phone: phoneSlot.phone, smsApiUrl: phoneSlot.smsApiUrl, email: account.email }, { signal: this._abortController.signal }) || {};
                  paymentOk = !!payResult.success;
                  paymentReason = payResult.reason || '';
                  paymentStatus = payResult.status || '';
                } catch (e) {
                  if (e.code === 'NOT_FREE_TRIAL') {
                    console.log(`${p} ${e.message}`);
                    finalResult.status = 'no_link';
                    finalResult.reason = e.message;
                    allResults.push(finalResult);
                    this.emitStatus({ email: account.email, status: 'no_link', phase: 'done', progress, reason: e.message });
                    summary.noLink = (summary.noLink || 0) + 1;
                    continue;
                  }
                  console.log(`${p} Auto-fill error: ${e.message}`);
                  paymentReason = e.message?.slice(0, 100) || 'exception';
                }

                if (paymentOk) {
                  statusDB.clearPaymentLink(account.email);
                  statusDB.clearAccessToken(account.email);
                  finalResult.status = 'plus_no_rt';
                  console.log(`${p} Payment succeeded (redirect_status=succeeded)`);
                } else if (paymentStatus === 'aborted') {
                  finalResult.status = 'aborted';
                  finalResult.reason = 'Stopped by user';
                  console.log(`${p} Payment aborted by user`);
                  this.emitStatus({ email: account.email, status: 'aborted', phase: 'payment', progress, reason: 'Stopped by user' });
                } else {
                  finalResult.status = paymentStatus || 'error';
                  finalResult.reason = paymentReason || 'Payment not completed';
                  console.log(`${p} Payment failed: ${finalResult.reason}, skipping auth file generation`);
                }

                // Phase 4: OAuth (PKCE) + CPA (only on payment success)
                if (paymentOk) {
                  currentPhase = 'oauth';
                  const latestCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf-8'));

                  if (latestCfg.enableOAuth) {
                    console.log(`${p} Phase 4: PKCE OAuth...`);
                    this.emitStatus({ email: account.email, status: 'running', phase: 'pkce', progress });
                    const pkceTokens = await fetchTokensViaPKCE(browser, account, loginResult.lastOtp).catch((e) => { console.log(`  [PKCE] Failed: ${e.message}`); return null; });
                    if (pkceTokens && !pkceTokens.needsPhone && pkceTokens.refresh_token) {
                      console.log(`${p} PKCE success, saving with refresh_token`);
                      saveCPAAuthFile(account.email, pkceTokens.access_token, pkceTokens);
                      finalResult.status = 'plus';
                    } else {
                      if (pkceTokens?.needsPhone) console.log(`${p} PKCE requires phone verification`);
                      else if (pkceTokens && !pkceTokens.refresh_token) console.log(`${p} PKCE returned no refresh_token`);
                      else console.log(`${p} PKCE failed, saving without refresh_token`);
                      saveCPAAuthFile(account.email, pkceTokens?.access_token || loginResult.accessToken, pkceTokens || loginResult.session);
                    }
                  } else {
                    saveCPAAuthFile(account.email, loginResult.accessToken, loginResult.session);
                  }

                  if (latestCfg.enableCPA) {
                    console.log(`${p} Phase 4: CPA registration...`);
                    try {
                      const cpaOk = await registerToCPA(browser, account.email, account);
                      if (cpaOk) console.log(`${p} CPA OAuth done.`);
                      else console.log(`${p} CPA OAuth may have issues, check manually.`);
                    } catch (e) {
                      console.log(`${p} CPA error: ${e.message}`);
                    }
                  }
                }
              }
            }
          }
        } catch (error) {
          console.log(`${p} ERROR: ${error.message}`);
          if (!finalResult.status) finalResult.status = 'error';
          finalResult.reason = error.message.slice(0, 200);
        } finally {
          if (this._browser) try { await this._browser.close(); } catch {}
          if (this._chromeProc) try { this._chromeProc.kill(); } catch {}
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
          this._browser = null;
          this._chromeProc = null;
          this._tempDir = null;
        }

        allResults.push(finalResult);
        console.log(`${p} ${account.email} → ${finalResult.status}`);

        // Emit final account status
        this.emitStatus( {
          email: account.email,
          status: finalResult.status,
          phase: 'done',
          progress,
          paymentLink: finalResult.paymentLink || undefined,
          reason: finalResult.reason || undefined,
        });

        // Random delay between accounts
        if (i < filtered.length - 1 && !this.stopFlag) {
          const wait = 5 + Math.floor(Math.random() * 3);
          console.log(`  Waiting ${wait}s...`);
          await randomDelay(wait * 1000, wait * 1000 + 500);
        }
      }
    } catch (err) {
      // Emit directly to avoid console.log loops if logger is misbehaving
      const msg = `[Engine] FATAL: ${err.message}`;
      this.emit('log', { email: '', phase: 'error', message: msg, timestamp: new Date().toISOString() });
      this.emit('log', { email: '', phase: 'error', message: `[Engine] Stack: ${err.stack?.split('\n').slice(0, 3).join(' | ')}`, timestamp: new Date().toISOString() });
    } finally {
      if (gw) gw.cleanup();

      // Stop log capture
      this.logCapture.stop();
      this.logCapture.offLog(logHandler);

      // Build summary
      const summary = {
        total: allResults.length,
        success: allResults.filter((r) => r.status === 'plus' || r.status === 'plus_no_rt').length,
        noLink: allResults.filter((r) => r.status === 'no_link').length,
        error: allResults.filter((r) => r.status === 'error' || r.status === 'deactivated').length,
        noJpProxy: allResults.filter((r) => r.status === 'no_jp_proxy').length,
        noPromo: allResults.filter((r) => r.status === 'no_promo').length,
        verifyError: allResults.filter((r) => r.status === 'verify_error').length,
        aborted: allResults.filter((r) => r.status === 'aborted').length,
      };

      console.log('========================================');
      console.log(`  Success: ${summary.success}  |  No Link: ${summary.noLink}  |  Error: ${summary.error}  |  Aborted: ${summary.aborted}`);
      console.log(`  No-JP: ${summary.noJpProxy}  |  No-Promo: ${summary.noPromo}  |  Verify-Err: ${summary.verifyError}`);
      console.log('========================================');

      this.emit('complete', { summary });

      // Flush logs to DB
      try { getDB().logsDB.flush(); } catch (e) { console.log(`[WARN] logsDB.flush: ${e.message?.slice(0, 60)}`); }

      // Reset state
      this.status = 'idle';
      this.stopFlag = false;
    }
  }
}

module.exports = { PipelineEngine };
