// server/pipeline/context.js
// AccountContext —— 单账号一次运行的状态容器 + checkpoint 读写 + 日志归属。
// deps: { statusDB, stepStateDB, logsDB, save, proxyMgr, resources, log(email, stepId, msg) }
class AccountContext {
  constructor(account, deps) {
    this.account = account;          // { email, password, client_id, refresh_token, login_type }
    this.email = account.email;
    this.deps = deps;
    this.currentStepId = '';
    this.outputs = {};               // step.id -> 该步产物（本次运行内存态）
    this.flags = {};                 // 跨步标志，如 alreadyPlus
    // 账号循环顶部的一次性快照（在任何 step 写库前），对应原 protocol-engine.js:615-617 的 prevPersisted。
    // cached-login / cached-link 判定必须用这个快照，不能用 getPersisted()（后者会被 login step 写入的 'running' 覆盖）。
    this.prevPersisted = (deps && deps.statusDB && deps.statusDB.get(account.email)) || {};
  }
  getPersisted() { return this.deps.statusDB.get(this.email) || {}; }
  setStatus(data) { this.deps.statusDB.set(this.email, data); }
  log(msg) { if (this.deps.log) this.deps.log(this.email, this.currentStepId, msg); }
}

module.exports = { AccountContext };
