/**
 * Active node health probing.
 *
 * After `refresh()` finishes, we know which nodes the user wants but not
 * which ones are actually reachable. Without probing, the first 3
 * accounts assigned to a dead node burn through the `recordBadAttempt`
 * threshold before we discover it — and worst case, a node whose TTL
 * just expired re-enters the candidate pool and burns another 3.
 *
 * Strategy: use Clash API's `/proxies/{name}/delay` endpoint. It runs a
 * one-shot HTTPS GET through the requested outbound *without* changing
 * the active selector, so we can probe N nodes concurrently while the
 * pipeline is happily using the current node.
 *
 * Result is written to a Map (passed in by caller — keeps this module
 * pure / stateless). Callers consult the map from inside `rotate()` to
 * skip "dead" candidates when there are alive alternatives.
 */

const clashApi = require('./clash-api');

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_TEST_URL = 'https://www.google.com/generate_204';

/**
 * Probe every tag concurrently. Resolves to a summary object once done.
 *
 * @param {string[]} tags                  — node tags to probe
 * @param {Map<string, object>} resultsMap — written: tag → { alive, delayMs, lastTested, reason? }
 * @param {object} [opts]
 * @param {number} [opts.concurrency=4]    — parallel probes
 * @param {number} [opts.timeoutMs=8000]
 * @param {string} [opts.testUrl]
 * @param {function} [opts.shouldSkip]     — (tag) => bool. skip nodes (e.g. manually blacklisted)
 * @returns {Promise<{ alive: number, dead: number, total: number }>}
 */
async function probeAllNodes(tags, resultsMap, opts = {}) {
  const concurrency = opts.concurrency || DEFAULT_CONCURRENCY;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const testUrl = opts.testUrl || DEFAULT_TEST_URL;
  const shouldSkip = typeof opts.shouldSkip === 'function' ? opts.shouldSkip : () => false;

  const queue = tags.slice();
  const summary = { alive: 0, dead: 0, total: tags.length };

  async function worker() {
    while (queue.length > 0) {
      const tag = queue.shift();
      if (!tag) break;
      if (shouldSkip(tag)) continue;
      const delay = await clashApi.testNodeDelay(tag, { timeoutMs, testUrl });
      const alive = typeof delay === 'number' && delay > 0;
      resultsMap.set(tag, {
        alive,
        delayMs: delay,
        lastTested: Date.now(),
        reason: alive ? null : 'delay-test-failed',
      });
      if (alive) summary.alive++; else summary.dead++;
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, tags.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return summary;
}

module.exports = { probeAllNodes };
