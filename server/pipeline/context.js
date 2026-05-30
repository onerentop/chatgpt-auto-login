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
  }
  getPersisted() { return this.deps.statusDB.get(this.email) || {}; }
  setStatus(data) { this.deps.statusDB.set(this.email, data); }
  log(msg) { if (this.deps.log) this.deps.log(this.email, this.currentStepId, msg); }
}

module.exports = { AccountContext };
