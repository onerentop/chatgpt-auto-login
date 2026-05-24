const test = require('node:test');
const assert = require('node:assert');

const { lightLogin, LivenessLoginNotImplementedError } = require('../light-login');

function fakeBrowser(scenario) {
  return {
    close: async () => {},
    newContext: async () => ({
      close: async () => {},
      newPage: async () => ({
        close: async () => {},
        goto: async (url) => {
          if (scenario === 'proxy-reset') { throw new Error('net::ERR_CONNECTION_RESET'); }
        },
        fill: async () => {},
        click: async () => {},
        url: () => scenario === 'bad-password' ? 'https://auth.openai.com/u/login/password?error=invalid' : 'https://chatgpt.com/',
        waitForURL: async () => {
          if (scenario === 'captcha') throw new Error('Timeout: waitForURL captcha');
        },
        waitForSelector: async () => {
          if (scenario === 'otp-timeout') throw new Error('Timeout waiting for OTP input');
        },
        request: {
          get: async (url) => {
            if (scenario === 'no-session') return { status: () => 200, json: async () => null };
            if (scenario === 'ok') return {
              status: () => 200,
              json: async () => ({
                accessToken: 'eyJ.test.sig',
                user: { id: 'user-x', email: 'a@x.com' },
                expires: '2026-06-07T12:00:00Z',
              }),
            };
            throw new Error('unreachable');
          },
        },
      }),
    }),
  };
}

const fakeOtp = {
  ok: async () => '123456',
  timeout: async () => { throw new Error('IMAP timeout'); },
};

test('protocol mode throws LivenessLoginNotImplementedError', async () => {
  await assert.rejects(
    lightLogin({ email: 'a@x.com', password: 'p', login_type: 'outlook' },
      { protocolMode: true, playwrightConnect: async () => fakeBrowser('ok'), getOtp: fakeOtp.ok }),
    (e) => e instanceof LivenessLoginNotImplementedError
  );
});

test('happy path: returns accessToken/accountId/expiresAtIso', async () => {
  const r = await lightLogin(
    { email: 'a@x.com', password: 'p', login_type: 'outlook', client_id: 'c', refresh_token: 'r' },
    { protocolMode: false, playwrightConnect: async () => fakeBrowser('ok'), getOtp: fakeOtp.ok }
  );
  assert.strictEqual(r.accessToken, 'eyJ.test.sig');
  assert.ok(r.expiresAtIso.includes('+08:00'), 'expiresAtIso is CST');
});

test('bad password rejects with bad password', async () => {
  await assert.rejects(
    lightLogin({ email: 'a@x.com', password: 'wrong', login_type: 'outlook' },
      { protocolMode: false, playwrightConnect: async () => fakeBrowser('bad-password'), getOtp: fakeOtp.ok }),
    /bad password/
  );
});

test('OTP timeout rejects with otp timeout', async () => {
  await assert.rejects(
    lightLogin({ email: 'a@x.com', password: 'p', login_type: 'outlook' },
      { protocolMode: false, playwrightConnect: async () => fakeBrowser('otp-timeout'), getOtp: fakeOtp.timeout }),
    /otp timeout/
  );
});

test('captcha rejects with captcha', async () => {
  await assert.rejects(
    lightLogin({ email: 'a@x.com', password: 'p', login_type: 'outlook' },
      { protocolMode: false, playwrightConnect: async () => fakeBrowser('captcha'), getOtp: fakeOtp.ok }),
    /captcha/
  );
});

test('null session rejects with no session', async () => {
  await assert.rejects(
    lightLogin({ email: 'a@x.com', password: 'p', login_type: 'outlook' },
      { protocolMode: false, playwrightConnect: async () => fakeBrowser('no-session'), getOtp: fakeOtp.ok }),
    /no session/
  );
});

test('proxy reset rejects with proxy reset', async () => {
  await assert.rejects(
    lightLogin({ email: 'a@x.com', password: 'p', login_type: 'outlook' },
      { protocolMode: false, playwrightConnect: async () => fakeBrowser('proxy-reset'), getOtp: fakeOtp.ok }),
    /proxy reset/
  );
});

test('missing password rejects with no password', async () => {
  await assert.rejects(
    lightLogin({ email: 'a@x.com', password: '', login_type: 'outlook' },
      { protocolMode: false, playwrightConnect: async () => fakeBrowser('ok'), getOtp: fakeOtp.ok }),
    /no password/
  );
});
