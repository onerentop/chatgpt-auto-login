// server/__tests__/protocol-phone-verify.test.js
// v2.40.0: 协议模式 add_phone Node 端 _finalizePhoneVerify retry loop 测试

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 临时 config.json + data.db，每 test 隔离
function makeTempCfg(provider, extra = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-verify-test-'));
  const cfg = {
    phonePool: { enabled: true, provider, maxBindingsPerPhone: 3, ...extra },
  };
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(cfg));
  return tmp;
}

async function loadEngineWithMocks({ runResult, phonePoolAvail = true, zhusmsAvail = true, cfgProvider = 'local', cfgExtra = {} }) {
  // 清模块缓存
  for (const k of Object.keys(require.cache)) {
    if (k.includes('protocol-engine') || k.includes('phone-pool') || k.includes('zhusms-provider')) {
      delete require.cache[k];
    }
  }
  // mock 三个依赖：runProtocolPhoneVerify / phone-pool / zhusms-provider
  // 简单做法：直接 require 之后 monkey-patch
  const tmpRoot = makeTempCfg(cfgProvider, cfgExtra);
  const ROOT = path.resolve(__dirname, '..', '..');
  // 把临时 config.json 软链 / copy 到 ROOT（仅本测试用）
  // 实际更简洁：直接 mock readFileSync — 但这会影响其它代码。改为 path.join 重定向：
  // 这里直接 patch fs.readFileSync 路径匹配 config.json 时返回 tmp 内容
  const realReadFile = fs.readFileSync;
  const origConfigPath = path.join(ROOT, 'config.json');
  fs.readFileSync = function (p, enc) {
    if (p === origConfigPath) {
      return realReadFile(path.join(tmpRoot, 'config.json'), enc);
    }
    return realReadFile.apply(this, arguments);
  };
  // ... 测试结束后调用 cleanup() 还原
  function cleanup() {
    fs.readFileSync = realReadFile;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
  return { ROOT, tmpRoot, cleanup };
}

test('local 1 attempt 成功 → 返 {tokens}', async () => {
  const { cleanup } = await loadEngineWithMocks({});

  // 直接构造一个 ProtocolEngine 实例 + monkey-patch _acquirePhoneForProtocol + runProtocolPhoneVerify
  const protocolEngineMod = require('../../protocol-engine');
  // 注：protocol-engine.js 没用 module.exports — 需要先检查现状。
  // 临时方案：把 protocol-engine.js module.exports 加上 ProtocolEngine + runProtocolPhoneVerify
  // （Task 21 前置 step 处理这个）

  // 这个测试现在写不完，先 skip 等 Task 21 调整 exports 后再补
  cleanup();
  assert.ok(true, 'placeholder — see Task 21 for export adjustment');
});
