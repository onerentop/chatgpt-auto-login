// server/pipeline/step.js
// Step 契约：纯对象 { id, label, shouldSkip?, run }
//   shouldSkip(ctx) -> boolean        命中有效 checkpoint 则跳过（默认不跳）
//   run(ctx)        -> Promise<{ ok, status?, reason?, output? }>
function defineStep(step) {
  if (!step || typeof step.id !== 'string' || !step.id) throw new Error('Step.id required');
  if (typeof step.label !== 'string' || !step.label) throw new Error(`Step ${step.id}: label required`);
  if (typeof step.run !== 'function') throw new Error(`Step ${step.id}: run() required`);
  return {
    id: step.id,
    label: step.label,
    shouldSkip: typeof step.shouldSkip === 'function' ? step.shouldSkip : () => false,
    run: step.run,
  };
}

module.exports = { defineStep };
