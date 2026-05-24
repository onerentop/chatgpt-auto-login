/**
 * Module-level holder for the single in-process engine instance.
 *
 * `routes/execute.js` previously kept `let engine = null` private and that
 * worked when execute was the only consumer. `/api/health` (and possibly
 * future probes) need to read the engine status without going through
 * the execute router, so we promote the holder to its own module — a tiny
 * pair of getter/setter keeps the indirection minimal.
 */

let _engine = null;
function getEngine() { return _engine; }
function setEngine(next) { _engine = next; }

module.exports = { getEngine, setEngine };
