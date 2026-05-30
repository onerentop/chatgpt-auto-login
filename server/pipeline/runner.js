// server/pipeline/runner.js
const { EventEmitter } = require('events');

// PipelineRunner —— 跑一个账号的 Step[]：按序、跳过命中 checkpoint 的步、
// 第一个不可跳的步=恢复点、失败即停、发 step-status、落 stepStateDB。
// deps: { statusDB, stepStateDB, logsDB, save, log, proxyMgr, resources }
class PipelineRunner extends EventEmitter {
  constructor(deps) {
    super();
    this.deps = deps;
    this.stopFlag = false;
    this._activeCtx = null;   // LogCapture handler 读它拿 currentStepId
  }

  // opts.forceStepId: 手动单步重试 —— 强制该步即使 shouldSkip 也跑（上游有效 checkpoint 仍跳过 = 自动回补）
  async _runAccount(ctx, steps, opts = {}) {
    this._activeCtx = ctx;
    const forceId = opts.forceStepId || null;
    for (let i = 0; i < steps.length; i++) {
      if (this.stopFlag) return { stoppedAt: ctx.currentStepId, aborted: true };
      const step = steps[i];
      ctx.currentStepId = step.id;
      const forced = step.id === forceId;
      if (!forced && step.shouldSkip(ctx)) {
        this._recordStep(ctx, step, 'skipped');
        continue;
      }
      this._recordStep(ctx, step, 'running');
      let result;
      try {
        result = await step.run(ctx);
      } catch (e) {
        this._recordStep(ctx, step, 'failed', e.message);
        return { stoppedAt: step.id, reason: e.message };
      }
      if (result && result.ok === false) {
        this._recordStep(ctx, step, 'failed', result.reason || '');
        return { stoppedAt: step.id, reason: result.reason };
      }
      if (result && result.output) ctx.outputs[step.id] = result.output;
      this._recordStep(ctx, step, 'success');
    }
    return { completed: true };
  }

  _recordStep(ctx, step, status, reason = '') {
    const now = new Date().toISOString();
    const patch = { status, reason };
    if (status === 'running') patch.startedAt = now;
    if (status === 'success' || status === 'failed' || status === 'skipped') patch.finishedAt = now;
    try { this.deps.stepStateDB.set(ctx.email, step.id, patch); } catch {}
    this.emit('step-status', { email: ctx.email, stepId: step.id, label: step.label, status, reason });
  }
}

module.exports = { PipelineRunner };
