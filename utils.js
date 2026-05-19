const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { authenticator } = require('otplib');

function loadAccounts(csvPath) {
  const content = fs.readFileSync(csvPath, 'utf-8');
  const records = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const valid = [];
  for (const record of records) {
    if (!record.email || !record.password) {
      console.log(`[SKIP] Incomplete row: ${record.email || 'no email'}`);
      continue;
    }
    // Auto-detect login type by email domain
    const domain = record.email.split('@')[1]?.toLowerCase() || '';
    const isOutlook = ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'].includes(domain);
    record.loginType = isOutlook ? 'outlook' : 'google';

    if (record.loginType === 'google') {
      if (!record.totp_secret) {
        console.log(`[SKIP] Missing TOTP for Google account: ${record.email}`);
        continue;
      }
      try {
        authenticator.generate(record.totp_secret);
      } catch {
        console.log(`[SKIP] Invalid TOTP secret for ${record.email}`);
        continue;
      }
    }
    valid.push(record);
    console.log(`[LOAD] ${record.email} (${record.loginType})`);
  }
  return valid;
}

function generateTOTP(secret) {
  return authenticator.generate(secret);
}

function randomDelay(minMs, maxMs) {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function saveResult(resultsPath, result) {
  try {
    const header = 'email,status,duration_s,failure_reason,checkout_url\n';
    const checkoutUrl = (result.checkoutUrl || '').replace(/,/g, '%2C');
    const reason = (result.reason || '').replace(/,/g, ';');
    const line = `${result.email},${result.status},${result.duration},${reason},${checkoutUrl}\n`;

    if (!fs.existsSync(resultsPath)) {
      fs.writeFileSync(resultsPath, header + line);
    } else {
      fs.appendFileSync(resultsPath, line);
    }
  } catch (e) {
    console.log(`[WARN] Failed to write results.csv: ${e.message.slice(0, 60)}`);
  }
}

function saveSessionData(sessionsDir, result) {
  if (!result.session || !result.accessToken) return;
  try {
  const sanitized = result.email.replace(/[@.]/g, '_');
  const filePath = path.join(sessionsDir, `${sanitized}.json`);
  const data = {
    email: result.email,
    accessToken: result.accessToken,
    session: result.session,
    checkoutUrl: result.checkoutUrl || '',
    checkoutError: result.checkoutError || '',
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (e) {
    console.log(`[WARN] Failed to write session: ${e.message.slice(0, 60)}`);
  }
}

function screenshotPath(email) {
  const sanitized = email.replace(/[@.]/g, '_');
  return path.join(__dirname, 'screenshots', `${sanitized}.png`);
}

module.exports = { loadAccounts, generateTOTP, randomDelay, saveResult, saveSessionData, screenshotPath };
