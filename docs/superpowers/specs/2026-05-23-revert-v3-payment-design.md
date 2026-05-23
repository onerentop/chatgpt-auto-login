# Revert v3.0.0 Payment Architecture (Spec)

**Date:** 2026-05-23
**Status:** Approved → execute
**Predecessor:** v3.0.0 dev branch (26 commits ahead of master)

## Goal

Roll back the v3 payment-protocol expansion and its docs adaptation, keeping only the `chatgpt_register/` vendoring (4 commits). End state ≡ master + 4 D commits.

## Operation

```bash
git revert --no-commit 196cff2^..6057486
git commit -m "revert(v3.0.0): roll back payment expansion + v3 docs (keep chatgpt_register vendor)"
```

Single squashed revert commit; no force-push needed.

## Scope: 22 commits to revert (oldest → newest)

### Group A — v3 core payment architecture (15 commits)
- `196cff2` chore: branch off + playwright-core
- `f546f46` feat: stripe_billing.py
- `bd64a14` feat: server/stripe-billing.js + tests
- `1cbf81d` fix: stripe-billing reason namespace
- `1950a5a` feat: pkce_oauth.py
- `f728aba` feat: server/pkce-oauth.js
- `43d085e` feat: manual_approval.py
- `f6e1bec` feat: server/manual-approval.js
- `f48e038` feat: paypal_rpa.js (Node RPA)
- `7067c5e` fix: paypal_rpa reason namespace
- `990fb9a` feat: server/paypal-rpa.js spawner
- `c1d7f2d` refactor: payment.js export fetchAddress
- `41d309d` feat: protocol-engine.js Phase 3+4 rewrite
- `eb7a6c6` feat: web dashboard 2 new statuses
- `7262955` docs: CHANGELOG v3.0.0

### Group B — post-release paypal_rpa tweaks (5 commits)
- `80439fa` fix: 4 e2e production bugs
- `cee9998` fix: paypal_rpa true incognito
- `a75da9a` feat: paypal_rpa window 1/4 screen
- `4c8a12b` feat: paypal_rpa fail-fast on PayPal genericError
- `4e852dd` feat: paypal_rpa retry+fail-fast on Filled:none

### Group C — v3 docs (2 commits)
- `a4843e5` docs: README + start.bat v3 update
- `6057486` feat: start.bat curl_cffi auto-install + first-run guide

### Group D — NOT reverted, stays on dev (4 commits)
- `cba3408` chatgpt_register multi-path discovery (intermediate)
- `2780521` chatgpt_register remove external dep (intermediate)
- `ed9682e` vendor chatgpt_register
- `1fb5519` slim chatgpt_register to sentinel only

## Files affected by the revert

**Deleted**: `stripe_billing.py`, `paypal_rpa.js`, `manual_approval.py`, `pkce_oauth.py`, `server/stripe-billing.js`, `server/paypal-rpa.js`, `server/manual-approval.js`, `server/pkce-oauth.js`, `server/__tests__/{stripe-billing,paypal-rpa,manual-approval,pkce-oauth}.test.js`

**Restored to v2.19.1 baseline**:
- `protocol-engine.js` — Phase 3+4 reverts to single-Chrome autoPayment
- `payment.js` — drops `fetchAddress` export
- `web/src/status.js` — drops `stripe_billing_error` / `activation_error` TYPE/LABEL entries
- `web/src/views/{Dashboard,Accounts,Execute,Results}.vue` — drop the 2 new options/KPI cards
- `README.md` — back to v2.19.1 description
- `start.bat` — back to v2.19.1 baseline
- `docs/CHANGELOG.md` — v3.0.0 entry removed
- `package.json` + `package-lock.json` — `playwright-core` dependency removed

**Untouched by revert** (D commits modify these):
- `protocol_register.py` — D's stdout-redirect + vendored import logic stays
- `chatgpt_register/` — vendored package stays
- `.gitignore` — D's dedupe stays

## Risk assessment

- **File overlap A∩D**: none. D touches `protocol_register.py` + new `chatgpt_register/` + `.gitignore` (dedupe). A+B+C touches none of these. Expect 0 conflicts.
- **Build risk**: revert will modify `package.json` to drop `playwright-core` but `node_modules/playwright-core/` remains on disk. Harmless.
- **Server start**: post-revert, `node server/index.js` reverts to v2.19.1 behavior; PipelineEngine + protocol mode (without v3 modules) both function as in v2.19.1.

## Acceptance criteria

1. ✅ `git revert --no-commit 196cff2^..6057486` completes with zero conflicts
2. ✅ Single new commit on dev
3. ✅ Final `git diff master..dev` shows ONLY the 4 D-group changes (protocol_register.py + chatgpt_register/* + .gitignore)
4. ✅ `node --check protocol-engine.js` passes
5. ✅ `node server/index.js` boots without SyntaxError or `Cannot find module`
6. ✅ v2.19.1 tag still points to the unchanged commit (not in the revert range)

## Out of scope

- `git push --force` — not needed; this is a forward-only revert
- Updating v3.0.0 tag — tag points to `7262955` (CHANGELOG), now superseded by revert; tag stays but its semantic value diminishes. User can `git tag -d v3.0.0` manually later if desired.
- `npm uninstall playwright-core` — package.json revert removes the dep declaration; `node_modules/` cleanup is optional
