# ChatGPT Auto Login & Plus Activation Pipeline

Automated pipeline for batch ChatGPT account login, Plus free trial activation, PayPal payment, and CPA OAuth credential registration.

## Features

- **Multi-provider login**: Gmail (Google OAuth + TOTP 2FA) and Outlook (email OTP via IMAP)
- **Auto account creation**: Random name/age generation for new accounts
- **Plan detection**: Automatically skip payment if account is already Plus
- **Discord bot integration**: Get $0 free trial checkout links via Discord bot
- **Automated payment**: PayPal auto-fill with address generation, SMS verification
- **CPA OAuth**: Automatic Codex OAuth credential registration to CPA management
- **Anti-detection**: Real Chrome browser via CDP, human-like typing delays
- **Batch processing**: Process multiple accounts sequentially with `--start N` resume support

## Prerequisites

- **Node.js** >= 18
- **Google Chrome** installed on the system
- **Playwright** (installed automatically via npm)

## Installation

```bash
git clone https://github.com/youruser/chatgpt-auto-login.git
cd chatgpt-auto-login
npm install
```

## Configuration

### 1. config.json

Copy the template and fill in your values:

```bash
cp config.example.json config.json
```

```json
{
  "phone": "US phone number for PayPal",
  "smsApiUrl": "SMS verification code API URL",
  "cardNumber": "Payment card number",
  "cardExpiry": "MM / YY",
  "cardCvv": "CVV",
  "enableCPA": true,
  "cpaUrl": "https://your-cpa-domain/management.html",
  "cpaKey": "CPA management key",
  "discordToken": "Your Discord user token",
  "discordChannelId": "Discord channel ID with bot",
  "discordMessageId": "Bot hub message ID",
  "discordGuildId": "Discord server ID",
  "discordAppId": "Bot application ID"
}
```

#### Field Reference

| Field | Description | Phase |
|-------|-------------|-------|
| `phone` | US phone number for PayPal registration | Payment |
| `smsApiUrl` | SMS API endpoint to receive PayPal verification codes (bound to phone) | Payment |
| `cardNumber` | Payment card number for PayPal | Payment |
| `cardExpiry` | Card expiry date, format `MM / YY` | Payment |
| `cardCvv` | Card CVV code | Payment |
| `enableCPA` | Enable CPA OAuth after login/payment (`true`/`false`, default: `true`) | CPA |
| `cpaUrl` | CPA management panel URL | CPA |
| `cpaKey` | CPA management login key | CPA |
| `discordToken` | Discord user token (F12 -> Network -> Authorization header) | Discord |
| `discordChannelId` | Channel ID where the bot buttons are located | Discord |
| `discordMessageId` | Message ID containing the hub:chatgpt button | Discord |
| `discordGuildId` | Discord server (guild) ID | Discord |
| `discordAppId` | Bot's application ID | Discord |

### 2. accounts.csv

Copy the template and add your accounts:

```bash
cp accounts.example.csv accounts.csv
```

```csv
email,password,totp_secret,client_id,refresh_token
user@gmail.com,password,TOTP_BASE32_SECRET,,
user@outlook.com,password,,microsoft-client-id,microsoft-refresh-token
```

#### Account Types

| Field | Gmail | Outlook |
|-------|-------|---------|
| `email` | Gmail address | Outlook/Hotmail address |
| `password` | Gmail password | Outlook password (backup) |
| `totp_secret` | Google Authenticator TOTP secret (required) | Leave empty |
| `client_id` | Leave empty | Microsoft app client ID |
| `refresh_token` | Leave empty | Microsoft OAuth refresh token (for IMAP email reading) |

Login type is auto-detected by email domain:
- `@gmail.com` -> Google OAuth + TOTP 2FA
- `@outlook.com` / `@hotmail.com` / `@live.com` -> Email OTP (read via IMAP)

#### Outlook Login String Format

Outlook accounts are typically provided as:
```
email----password----client_id----refresh_token
```

Split by `----` and map to CSV columns accordingly.

## Usage

### Run Full Pipeline

```bash
node index.js
```

### Resume From Account N

```bash
node index.js --start 6
```

### Run Discord Bot Standalone

```bash
node discord-bot.js
```

### Open Payment Links Manually

```bash
node open-links.js
```

## Pipeline Flow

```
node index.js
  |
  +-- Phase 1: Login to ChatGPT
  |     Gmail:   Chrome -> chatgpt.com -> Google OAuth -> TOTP 2FA
  |     Outlook: Chrome -> chatgpt.com -> Email OTP (IMAP auto-read)
  |     New account: auto-fill random name + age (18-25)
  |
  +-- Plan Check: read session.planType
  |     |
  |     +-- Already Plus/Pro -> skip to Phase 4
  |     |
  |     +-- Free -> continue to Phase 2
  |
  +-- Phase 2: Discord Bot -> $0 Checkout Link
  |     Connect Discord Gateway -> click hub:chatgpt
  |     -> click "US Plus (Free Trial)" -> submit accessToken
  |     -> receive Stripe $0 payment link
  |
  +-- Phase 3: Automated Payment
  |     Open payment link in same browser
  |     -> Select PayPal -> fill US address -> submit
  |     -> PayPal login (random email) -> PayPal checkout
  |     -> fill card/address/info -> SMS verification (auto)
  |
  +-- Phase 4: CPA OAuth (if enableCPA=true)
  |     Open CPA management in same tab
  |     -> login -> OAuth page -> start Codex OAuth
  |     -> click "Open Link" -> complete Google/Outlook auth
  |     -> capture localhost callback -> submit to CPA
  |     -> credentials saved
  |
  +-- Close browser -> next account
```

## Output Files

| File | Description |
|------|-------------|
| `discord-results.json` | Final results for all accounts (status, payment links) |
| `results.csv` | Login results per account |
| `sessions/*.json` | Session data with accessToken per account |
| `screenshots/*.png` | Screenshots at key steps for debugging |

## Project Structure

```
chatgpt-auto-login/
├── index.js              # Main entry - orchestrates full pipeline
├── login.js              # ChatGPT login (Gmail OAuth + Outlook OTP)
├── payment.js            # PayPal auto-payment + SMS verification
├── discord-bot.js        # Discord bot integration (standalone)
├── cpa.js                # CPA OAuth credential registration
├── open-links.js         # Manual payment link opener
├── utils.js              # Utilities (CSV, TOTP, delays, logging)
├── config.json           # Runtime config (gitignored)
├── config.example.json   # Config template
├── accounts.csv          # Account list (gitignored)
├── accounts.example.csv  # Account format template
├── package.json          # Dependencies
└── .gitignore            # Excludes sensitive files
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `playwright` | Browser automation |
| `playwright-extra` | Stealth plugin support |
| `puppeteer-extra-plugin-stealth` | Anti-detection |
| `otplib` | TOTP verification code generation |
| `csv-parse` | CSV file parsing |
| `ws` | Discord Gateway WebSocket |
| `imapflow` | Outlook IMAP email reading |

## Security Notes

- `config.json` and `accounts.csv` are **gitignored** - never commit them
- Discord tokens, CPA keys, card numbers are all in config.json only
- Sessions and screenshots are gitignored
- Use `config.example.json` and `accounts.example.csv` as templates

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `max_check_attempts` | OpenAI IP rate limit - switch VPN/IP or wait 15+ minutes |
| Verification code not received | Check if Outlook email is rate-limited, switch to a fresh account |
| Google "browser not secure" | Script uses CDP (real Chrome) to bypass this |
| PayPal radio button not selected | Uses real mouse click coordinates |
| CPA "打开链接" not clicking | JS scroll-into-view click as fallback |
| Login dialog not appearing | Intermittent - script auto-retries |
