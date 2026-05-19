/**
 * LogCapture - Hooks console.log to capture output and forward to listeners.
 *
 * Usage:
 *   const { LogCapture } = require('./logger');
 *   const capture = new LogCapture();
 *   capture.onLog((message) => { ... });
 *   capture.start();
 *   // ... console.log calls are now intercepted ...
 *   capture.stop();
 */
class LogCapture {
  constructor() {
    this.listeners = [];
    this._originalLog = console.log;
  }

  start() {
    const self = this;
    console.log = function (...args) {
      self._originalLog.apply(console, args);
      const message = args
        .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
        .join(' ');
      for (const fn of self.listeners) fn(message);
    };
  }

  stop() {
    console.log = this._originalLog;
  }

  onLog(fn) {
    this.listeners.push(fn);
  }

  offLog(fn) {
    this.listeners = this.listeners.filter((f) => f !== fn);
  }
}

module.exports = { LogCapture };
