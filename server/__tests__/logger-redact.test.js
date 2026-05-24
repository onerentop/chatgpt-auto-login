const test = require('node:test');
const assert = require('node:assert');
const { LogCapture, redact } = require('../logger');

test('redact: JWT 三段被替换，前缀 eyJ 可识别', () => {
  const raw = 'access_token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const out = redact(raw);
  assert.ok(out.includes('eyJhbGci…[redacted-jwt]'), `expected redacted JWT, got: ${out}`);
  assert.ok(!out.includes('SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'), 'sig must be gone');
});

test('redact: access_token / refresh_token URL 参数', () => {
  const a = redact('callback?access_token=abc.def.ghi&state=xyz');
  assert.ok(a.includes('access_token=…[redacted]'), `expected redacted access_token, got: ${a}`);
  assert.ok(a.includes('state=xyz'), 'unrelated params preserved');

  const b = redact('refresh_token=rt_live_abc123def456');
  assert.ok(b.includes('refresh_token=…[redacted]'), `expected redacted refresh_token, got: ${b}`);
});

test('redact: OTP / verification code 紧邻数字脱敏', () => {
  const a = redact('Received OTP: 123456 from user');
  assert.ok(a.includes('OTP') && a.includes('***'), `expected OTP redaction, got: ${a}`);
  assert.ok(!a.includes('123456'), 'digits must be gone');

  const b = redact('SMS verification code is 4829');
  assert.ok(b.includes('verification code') && b.includes('***'), `expected verification code redaction, got: ${b}`);
  assert.ok(!b.includes('4829'), 'digits must be gone');
});

test('redact: Bearer header 脱敏', () => {
  const out = redact('Authorization: Bearer eyJabcdefghijklmnopqrstuvwxyz12345');
  assert.ok(out.includes('Bearer …[redacted]'), `expected Bearer redaction, got: ${out}`);
});

test('redact: 不含敏感模式的字符串原样通过', () => {
  const benign = 'Pipeline starting for user@example.com phase=login';
  assert.strictEqual(redact(benign), benign);
});

test('redact: 空 / 非字符串安全返回', () => {
  assert.strictEqual(redact(''), '');
  assert.strictEqual(redact(null), null);
  assert.strictEqual(redact(undefined), undefined);
  assert.strictEqual(redact(42), 42);
});

test('LogCapture.start 二次调用 idempotent，不嵌套 wrapper', () => {
  const cap = new LogCapture();
  const origLog = console.log;
  cap.start();
  const afterFirst = console.log;
  cap.start();
  cap.start();
  const afterTriple = console.log;
  assert.strictEqual(afterFirst, afterTriple, 'console.log 不应被嵌套包装');
  cap.stop();
  assert.strictEqual(console.log, origLog, 'stop 后还原');
});

test('LogCapture 把消息脱敏后发给 listener 与 _originalLog', () => {
  const cap = new LogCapture();
  const captured = [];
  cap.onLog((msg) => captured.push(msg));
  const origLog = console.log;
  // intercept _originalLog by replacing console.log before start
  let originalLogged = '';
  console.log = (msg) => { originalLogged = msg; };
  cap.start();
  console.log('OTP: 998877 received');
  cap.stop();
  console.log = origLog;
  assert.strictEqual(captured.length, 1, '一条 listener 消息');
  assert.ok(captured[0].includes('***'), `listener 收到的是脱敏版: ${captured[0]}`);
  assert.ok(!captured[0].includes('998877'), 'listener 不应见到原始 OTP');
  assert.ok(!originalLogged.includes('998877'), 'server.log 也不应留原始 OTP');
});
