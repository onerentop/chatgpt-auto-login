/**
 * LogCapture - Hooks console.log to capture output and forward to listeners.
 *
 * Usage:
 *   const { LogCapture } = require('./logger');
 *   const capture = new LogCapture();
 *   capture.onLog((message) => { ... });
 *   capture.start();
 *   // ... console.log calls are now intercepted ...
 *   capture.stop();
 *
 * All captured messages pass through `redact()` first so credentials that
 * leak into business-logic console.log calls (OTP, access tokens, JWTs,
 * SMS codes) never reach disk-resident server.log nor the Socket.IO push
 * stream consumed by the dashboard.
 */

// JWT triplet: header.payload.signature. Both parts non-empty, base64-url chars.
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
// access_token=… / refresh_token=… in URLs or form payloads
const TOKEN_PARAM_RE = /(access_token|refresh_token|id_token)=([^&\s"'<>]+)/gi;
// Verification codes: keywords like "OTP", "code", "verification code" followed
// — possibly with a short filler like ": " or " is " — by 4-8 digits.
// Filler is bounded (<= 16 chars, no newline, no digits) so unrelated numbers
// later in a sentence aren't pulled in.
const OTP_RE = /\b(otp|code|verification[ _-]?code|sms[ _-]?code)\b([^\d\n]{0,16})(\d{4,8})\b/gi;
// Bearer header values
const BEARER_RE = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{12,})/gi;

function redact(message) {
  if (typeof message !== 'string' || message.length === 0) return message;
  return message
    .replace(JWT_RE, (m) => m.slice(0, 8) + '…[redacted-jwt]')
    .replace(BEARER_RE, (_m, prefix) => prefix + '…[redacted]')
    .replace(TOKEN_PARAM_RE, (_m, name) => `${name}=…[redacted]`)
    .replace(OTP_RE, (_m, keyword, sep) => `${keyword}${sep}***`);
}

class LogCapture {
  constructor() {
    this.listeners = [];
    this._originalLog = console.log;
    this._patched = false;
  }

  start() {
    if (this._patched) return; // idempotent — avoid nesting our own wrapper
    this._originalLog = console.log;
    this._patched = true;
    const self = this;
    console.log = function (...args) {
      const raw = args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      const message = redact(raw);
      // Pass the redacted message to the real console.log too, so anything
      // captured by an external `> server.log` redirect is also clean.
      self._originalLog.call(console, message);
      for (const fn of self.listeners) {
        try { fn(message); } catch {}
      }
    };
  }

  stop() {
    if (!this._patched) return;
    console.log = this._originalLog;
    this._patched = false;
  }

  onLog(fn) {
    this.listeners.push(fn);
  }

  offLog(fn) {
    this.listeners = this.listeners.filter((f) => f !== fn);
  }
}

module.exports = { LogCapture, redact };
