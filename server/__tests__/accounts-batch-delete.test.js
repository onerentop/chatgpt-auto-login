const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-delete-test-'));
const fakeDb = path.join(tmpDir, 'data.db');
const realPath = require('path');
const origJoin = realPath.join;
realPath.join = function (...args) {
  if (args[args.length - 1] === 'data.db') return fakeDb;
  return origJoin.apply(this, args);
};
const { initDB, accountsDB } = require('../db');
realPath.join = origJoin;

test('setup: seed 5 accounts', async () => {
  await initDB();
  accountsDB.bulkAdd([
    { email: 'a@x.com', password: 'pw1' },
    { email: 'b@x.com', password: 'pw2' },
    { email: 'c@x.com', password: 'pw3' },
    { email: 'd@x.com', password: 'pw4' },
    { email: 'e@x.com', password: 'pw5' },
  ]);
  assert.strictEqual(accountsDB.list().length, 5);
});

test('bulkDelete: 删除 3 个存在的账号一次完成', () => {
  const out = accountsDB.bulkDelete(['a@x.com', 'b@x.com', 'c@x.com']);
  assert.deepStrictEqual(out.deleted.sort(), ['a@x.com', 'b@x.com', 'c@x.com']);
  assert.deepStrictEqual(out.notFound, []);
  assert.strictEqual(accountsDB.list().length, 2);
});

test('bulkDelete: 不存在的邮箱不报错，入 notFound', () => {
  const out = accountsDB.bulkDelete(['d@x.com', 'gone@x.com', 'also-gone@x.com']);
  assert.deepStrictEqual(out.deleted, ['d@x.com']);
  assert.deepStrictEqual(out.notFound.sort(), ['also-gone@x.com', 'gone@x.com']);
  assert.strictEqual(accountsDB.list().length, 1);
});

test('bulkDelete: 空数组 / 非数组 安全处理', () => {
  assert.deepStrictEqual(accountsDB.bulkDelete([]), { deleted: [], notFound: [] });
  assert.deepStrictEqual(accountsDB.bulkDelete(null), { deleted: [], notFound: [] });
  assert.deepStrictEqual(accountsDB.bulkDelete(undefined), { deleted: [], notFound: [] });
});

test('bulkDelete: 跳过非字符串 / 空字符串', () => {
  // re-seed
  accountsDB.bulkAdd([{ email: 'x@x.com', password: 'p' }]);
  const out = accountsDB.bulkDelete(['x@x.com', '', '   ', null, 42, {}]);
  assert.deepStrictEqual(out.deleted, ['x@x.com']);
  // null / number / object / empty are silently skipped (NOT in notFound)
  assert.strictEqual(out.notFound.length, 0);
});
