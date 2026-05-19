# Web Dashboard for ChatGPT Auto-Login Pipeline

## Overview

A web-based management interface for the existing ChatGPT auto-login pipeline. Provides visual configuration, batch account management, real-time execution monitoring, and result export.

## Tech Stack

- **Backend**: Express.js + Socket.IO (same Node.js process as existing pipeline)
- **Frontend**: Vue 3 + Element Plus + Vite
- **Auth**: Simple password protection (single management key)
- **Deployment**: Single process — Express serves Vue build + API + WebSocket

## Pages

### 1. Dashboard

Summary statistics: total accounts, Plus count, free count, success/fail rates. Recent execution history with timestamps.

### 2. Accounts Management

- Table view of all accounts from accounts.csv
- Columns: email, login type (auto-detected), password (masked), status
- Add single account via form
- Bulk import: paste text area (email----password----client_id----refresh_token format) or upload CSV
- Delete individual or selected accounts
- Export as CSV

### 3. Configuration

Visual form for config.json, grouped into sections:

- **Payment**: phone, smsApiUrl, cardNumber, cardExpiry, cardCvv
- **Discord**: discordToken, discordChannelId, discordMessageId, discordGuildId, discordAppId
- **CPA**: enableCPA toggle, cpaUrl, cpaKey
- Sensitive fields masked with show/hide toggle
- Save button writes to config.json

### 4. Execution Control

- Start button (optional: start from account N)
- Stop button (graceful stop after current account)
- Real-time log stream via Socket.IO
- Per-account collapsible panels showing:
  - Current phase (1-4) with progress indicator
  - Status badge (running/success/failed/skipped)
  - Detailed log messages
- Overall progress bar (N/total accounts)

### 5. Results

- Table of execution results from discord-results.json + sessions/
- Columns: email, status, plan type, payment link, duration, CPA auth
- Filter by status (SUCCESS, ALREADY_PLUS, NO_LINK, ERROR)
- Actions per row:
  - Retry single account
  - Download CPA auth JSON
  - View session details (modal)
- Bulk actions:
  - Download all CPA auth files as ZIP
  - Export results as CSV
  - Retry all failed accounts

## Backend API

### Authentication

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/auth/login | Verify password, return JWT |

### Accounts

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/accounts | List all accounts |
| POST | /api/accounts | Add single account |
| POST | /api/accounts/import | Bulk import (CSV text or ---- format) |
| DELETE | /api/accounts/:email | Delete account |
| GET | /api/accounts/export | Export as CSV |

### Configuration

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/config | Get config (sensitive fields masked) |
| PUT | /api/config | Update config |

### Execution

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/execute | Start execution (body: { startFrom? }) |
| POST | /api/execute/stop | Stop after current account |
| GET | /api/execute/status | Current state (idle/running/stopping) |

### Results

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/results | List all results |
| POST | /api/results/:email/retry | Retry single account |
| GET | /api/results/:email/auth-file | Download CPA auth JSON |
| GET | /api/results/download-all | ZIP of all auth JSONs |

## WebSocket Events (Socket.IO)

| Event | Direction | Payload |
|-------|-----------|---------|
| log | server→client | { email, phase, message, timestamp } |
| account-status | server→client | { email, status, phase, progress } |
| execution-complete | server→client | { summary: { success, failed, error, total } } |

## Execution Engine (server/engine.js)

Refactored from index.js main() into an EventEmitter-based class:

```javascript
class PipelineEngine extends EventEmitter {
  constructor(config, accounts) { ... }
  async start(startFrom = 0) { ... }
  stop() { ... }  // sets flag, current account finishes then stops
  getStatus() { ... }  // idle | running | stopping
}
```

Emits events: `log`, `account-start`, `account-done`, `complete`.

Existing modules (login.js, payment.js, cpa.js, utils.js) remain unchanged. Engine calls them the same way index.js does, but routes console output through the event emitter.

## Project Structure

```
chatgpt-auto-login/
├── server/
│   ├── index.js          # Express + Socket.IO entry
│   ├── routes/
│   │   ├── auth.js
│   │   ├── accounts.js
│   │   ├── config.js
│   │   ├── execute.js
│   │   └── results.js
│   ├── engine.js          # PipelineEngine class
│   └── logger.js          # Console hook → Socket.IO
├── web/
│   ├── src/
│   │   ├── views/
│   │   │   ├── Dashboard.vue
│   │   │   ├── Accounts.vue
│   │   │   ├── Config.vue
│   │   │   ├── Execute.vue
│   │   │   └── Results.vue
│   │   ├── components/
│   │   │   ├── AppLayout.vue
│   │   │   └── LogViewer.vue
│   │   ├── App.vue
│   │   ├── router.js
│   │   └── main.js
│   ├── package.json
│   └── vite.config.js
├── login.js               # unchanged
├── payment.js             # unchanged
├── cpa.js                 # unchanged
├── utils.js               # unchanged
├── discord-bot.js         # unchanged
├── index.js               # unchanged (CLI entry)
├── config.json
├── accounts.csv
└── package.json
```

## Key Decisions

- **Existing files untouched**: login.js, payment.js, cpa.js, utils.js, discord-bot.js keep working as-is
- **CLI still works**: index.js remains the CLI entry point
- **Web is additive**: server/ and web/ are new additions
- **Single port**: Express serves both API and Vue static build
- **Auth**: Simple password from config.json's existing fields or a new `webPassword` field
