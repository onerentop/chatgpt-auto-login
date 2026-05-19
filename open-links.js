const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
const readline = require('readline');
const { chromium } = require('playwright');

const SESSIONS_DIR = path.join(__dirname, 'sessions');
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
];

function findChrome() {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function launchChrome(port, tempDir) {
  const chromePath = findChrome();
  const args = [
    `--remote-debugging-port=${port}`,
    '--incognito',
    `--user-data-dir=${tempDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-popup-blocking',
    '--window-size=960,540', '--window-position=0,0',
    'about:blank',
  ];
  return spawn(chromePath, args, { stdio: 'ignore', detached: false });
}

async function waitForCDP(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`CDP connection timeout on port ${port}`);
}

function waitForEnter(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) {
    console.log('Chrome not found!');
    process.exit(1);
  }

  const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    console.log('No session files found. Run index.js first to generate checkout links.');
    process.exit(1);
  }

  const sessions = files
    .map((f) => JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8')))
    .filter((s) => s.checkoutUrl);

  if (sessions.length === 0) {
    console.log('No checkout URLs found in session files.');
    process.exit(1);
  }

  console.log(`Found ${sessions.length} checkout links to open.\n`);
  console.log('IMPORTANT: Make sure you are on a US node/VPN before continuing!\n');
  await waitForEnter('Press ENTER to start opening checkout links...');
  console.log('');

  const basePort = 29222;

  for (let i = 0; i < sessions.length; i++) {
    const session = sessions[i];
    const progress = `[${i + 1}/${sessions.length}]`;
    console.log(`${progress} Opening checkout for ${session.email}...`);
    console.log(`  URL: ${session.checkoutUrl.slice(0, 80)}...`);

    const port = basePort + i;
    const tempDir = path.join(os.tmpdir(), `chatgpt-checkout-${Date.now()}`);
    let chromeProc = null;
    let browser = null;

    try {
      chromeProc = launchChrome(port, tempDir);
      browser = await waitForCDP(port);

      const context = browser.contexts()[0];
      const pages = context.pages();
      const page = pages.length > 0 ? pages[0] : await context.newPage();

      await page.goto(session.checkoutUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await new Promise((r) => setTimeout(r, 3000));

      const screenshotFile = path.join(SCREENSHOTS_DIR, `${session.email.replace(/[@.]/g, '_')}_checkout.png`);
      await page.screenshot({ path: screenshotFile, fullPage: false });
      console.log(`  Screenshot saved: ${screenshotFile}`);

      console.log(`\n  >>> Checkout page is open for ${session.email}`);
      console.log(`  >>> Complete your payment in the browser.`);
      console.log(`  >>> Press ENTER when done to close and continue to next account...\n`);
      await waitForEnter(`  [${session.email}] >>> `);
    } catch (error) {
      console.log(`  ERROR: ${error.message}`);
    } finally {
      if (browser) {
        try { await browser.close(); } catch {}
      }
      if (chromeProc) {
        try { chromeProc.kill(); } catch {}
      }
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  }

  console.log('\n========== All Done ==========');
  console.log(`  Processed ${sessions.length} checkout links.`);
  console.log('==============================\n');
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
