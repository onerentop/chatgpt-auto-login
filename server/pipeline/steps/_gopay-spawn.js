// server/pipeline/steps/_gopay-spawn.js
// GoPay Python 子进程 spawn 辅助 — 从 gopay-engine.js#_spawnPython 逐字搬运。
//
// 行为来源：
//   gopay-engine.js 第 17–28 行  — redactLine / _OTP_RE / _TOKEN_RE
//   gopay-engine.js 第 133–190 行 — _spawnPython（spawn、stdin、JSON-lines 解析、timeout、abort）
//
// 导出：
//   spawnGopay(scriptPath, input, { timeoutMs, signal, onLog })  — 主入口
//   GOPAY_SCRIPT                                                  — gopay_activate.py 绝对路径
//   redactLine                                                    — 日志脱敏（供测试/外部使用）
//   __setSpawnImpl                                                — 测试接缝（注入假 spawn）
//
// 路径：server/pipeline/steps/ → __dirname/../../../ = repo 根
'use strict';

const path  = require('path');
const { spawn: _nodeSpawn } = require('child_process');

// repo 根（server/pipeline/steps/ 上三级）
const ROOT = path.join(__dirname, '..', '..', '..');

// gopay_activate.py 在 repo 根
const GOPAY_SCRIPT = path.join(ROOT, 'gopay_activate.py');

// ==========================================================================
// redactLine（逐字搬自 gopay-engine.js:17–28）
// ==========================================================================
const _OTP_RE   = /\b\d{4,6}\b/g;
const _TOKEN_RE = /Bearer\s+\S+|eyJ[A-Za-z0-9_-]{20,}/g;

function redactLine(line) {
  return line
    .replace(_TOKEN_RE, '[REDACTED_TOKEN]')
    .replace(_OTP_RE, (m, offset, str) => {
      const before = str.slice(Math.max(0, offset - 15), offset).toLowerCase();
      if (/otp|code|pin|sms|verif/.test(before)) return '[REDACTED_OTP]';
      return m;
    });
}

// ==========================================================================
// 测试接缝：允许注入假 spawn（镜像 paypal-pkce.js 的 __setRunProtocolPhoneVerify 模式）
// ==========================================================================
let _spawnImpl = _nodeSpawn;

/**
 * 注入替代 spawn 实现（仅供单元测试使用）。
 * 生产代码永远不调用此函数。
 * @param {Function|null} fn  传 null 恢复原生 spawn
 */
function __setSpawnImpl(fn) {
  _spawnImpl = fn || _nodeSpawn;
}

// 高层接缝（additive，不影响低层 __setSpawnImpl）：直接替换整个 spawnGopay 逻辑。
// 签名: (scriptPath, input, opts?) => Promise<{status, ...}>；传 null 恢复。
// 用于引擎级测试（如 gopay-engine 批量），免去构造假 ChildProcess。
let _spawnGopayImpl = null;
function __setSpawnGopayImpl(fn) {
  _spawnGopayImpl = fn || null;
}

// ==========================================================================
// spawnGopay（_spawnPython 逻辑逐字搬自 gopay-engine.js:133–190，去掉 this.* 绑定）
//
// 与原版的映射关系：
//   this._aborted           → signal?.aborted（AbortController 信号）
//   this._childProc = child → 无外部存储（调用方 via signal 取消）
//   this._emitLog(msg)      → onLog(redactLine(msg))
//   envOverrides            → 无需（调用方不传环境覆盖；GoPay 脚本通过 config.json 读配置）
//   cwd                     → ROOT（同原 path.join(__dirname,'..') 等价于 repo 根）
// ==========================================================================

/**
 * spawnGopay(scriptPath, input, opts)
 *
 * @param {string}   scriptPath  Python 脚本绝对路径（通常传 GOPAY_SCRIPT）
 * @param {object}   input       写入 stdin 的 JSON 对象
 * @param {object}   [opts]
 * @param {number}   [opts.timeoutMs=600000]  超时毫秒
 * @param {AbortSignal} [opts.signal]         AbortController.signal；aborted → {status:'aborted'}
 * @param {Function} [opts.onLog]             接收日志行（已脱敏）的回调；默认 console.log
 * @returns {Promise<{status:string, [key:string]:any}>}  Python 最终输出对象
 */
function spawnGopay(scriptPath, input, opts = {}) {
  // 高层接缝（测试专用）：直接委托，绕过 ChildProcess。生产 _spawnGopayImpl 恒为 null。
  if (_spawnGopayImpl) return _spawnGopayImpl(scriptPath, input, opts);

  const { timeoutMs = 600000, signal, onLog = console.log } = opts;

  return new Promise((resolve) => {
    // 逐字搬自 _spawnPython:135–137
    if (signal?.aborted) {
      resolve({ status: 'aborted' });
      return;
    }

    // 逐字搬自 _spawnPython:140–144
    const child = _spawnImpl('py', ['-3', scriptPath], {
      cwd: ROOT,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let finalResult = null;
    let stderr = '';

    // 逐字搬自 _spawnPython:150–151
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();

    // 逐字搬自 _spawnPython:153–165
    child.stdout.on('data', (data) => {
      for (const line of data.toString().split('\n').filter(l => l.trim())) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.log) {
            // gopay-engine._emitLog 会 redactLine；此处等价
            onLog(redactLine(parsed.log));
          } else {
            finalResult = parsed;
          }
        } catch {
          onLog(redactLine(line));
        }
      }
    });

    // 逐字搬自 _spawnPython:167
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    // 逐字搬自 _spawnPython:169–172
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      resolve({ status: 'timeout', detail: `${timeoutMs}ms exceeded` });
    }, timeoutMs);

    // 逐字搬自 _spawnPython:174–181
    child.on('exit', () => {
      clearTimeout(timer);
      if (finalResult) {
        resolve(finalResult);
      } else {
        resolve({ status: 'error', detail: stderr.slice(-300) || 'no output' });
      }
    });

    // 逐字搬自 _spawnPython:183–187
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ status: 'error', detail: e.message });
    });

    // abort 支持（原版通过 this._aborted + stop() kill 实现；
    // 此处等价：监听 signal 的 abort 事件立即 kill child）
    if (signal) {
      signal.addEventListener('abort', () => {
        try { child.kill(); } catch {}
        resolve({ status: 'aborted' });
      }, { once: true });
    }
  });
}

module.exports = {
  spawnGopay,
  GOPAY_SCRIPT,
  redactLine,
  __setSpawnImpl,
  __setSpawnGopayImpl,
};
