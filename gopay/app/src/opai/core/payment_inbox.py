"""Payment Inbox: 服务端 + 客户端 + 存储 + HTML 视图。

**用途**：opai-team manual-paypal 模式下不再本地起浏览器付款，而是把
``(account_name, account_email, plan_kind, checkout_url, paypal_url?)`` 推到这个
inbox 服务上；人工浏览器打开服务页面看到待付款列表，去 PayPal 完成付款后
点 "Mark Paid"；本地脚本轮询 ``/api/jobs/<id>`` 看到 ``status=paid`` 才继续
后续 OAuth/CPA 流程。

**为什么同时存 paypal_url 和 checkout_url（用户要求）**：PayPal goto 链接里的
``ba_token`` 几小时就过期；checkout_url（Stripe 结账页）寿命更长。前者过期后
用户可在结账页重新点 PayPal 拿新的 ba_token 继续付。

**架构**：
- 存储：SQLite 单文件 ``<inbox_dir>/payment_inbox.db`` + WAL 模式；启动时自动从旧
  ``payment_inbox.json`` 迁移一次（见 ``_migrate_json_to_sqlite``）。
- 服务：``http.server.ThreadingHTTPServer`` + 自定义 handler（与 ``opai paypal serve`` 一致风格，零新依赖）；
  per-thread SQLite 连接在 ``_InboxHandler.finish`` 里显式关闭，避免请求线程泄漏 connection。
- 客户端：``urllib.request`` 简易封装 POST / GET / PUT。

**安全**：两套互不冲突的认证方式，命中**任一**即放行；都没配则全开放（仅内网用）。
1. **HTTP Basic Auth**：``OPAI_PAYMENT_INBOX_BASIC_USER`` + ``OPAI_PAYMENT_INBOX_BASIC_PASS``，
   浏览器访问 HTML 视图时弹出登录框最直观；未通过返 ``401 + WWW-Authenticate: Basic``。
2. **Token**：``OPAI_PAYMENT_INBOX_TOKEN``，``Authorization: Bearer <token>`` /
   ``X-Auth-Token`` header / ``?token=...`` URL 入参（写 cookie 后续不传） / cookie。
"""
from __future__ import annotations

import base64
import hmac
import json
import logging
import os
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


PaymentInboxJob = dict[str, Any]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _default_inbox_path() -> Path:
    """Storage 路径：默认放在 ``<ROOT_DIR>/config/payment_inbox.json``。"""
    override = (os.environ.get("OPAI_PAYMENT_INBOX_PATH") or "").strip()
    if override:
        return Path(override).expanduser().resolve()
    try:
        from opai.config import CONFIG_DIR
        return CONFIG_DIR / "payment_inbox.json"
    except Exception:
        # 退化路径：相对当前目录
        return Path("payment_inbox.json").resolve()


def _default_inbox_db_path() -> Path:
    """SQLite db 路径:同目录下的 ``payment_inbox.db``(取代旧 JSON)。

    优先 ``OPAI_PAYMENT_INBOX_DB_PATH``,否则用 ``_default_inbox_path()`` 的目录 +
    ``payment_inbox.db``。
    """
    override = (os.environ.get("OPAI_PAYMENT_INBOX_DB_PATH") or "").strip()
    if override:
        return Path(override).expanduser().resolve()
    json_path = _default_inbox_path()
    return json_path.with_name("payment_inbox.db")


_SCHEMA_VERSION = 3

_SCHEMA_SQL_V1 = """
CREATE TABLE IF NOT EXISTS jobs (
    id              TEXT    PRIMARY KEY NOT NULL,
    account_name    TEXT    NOT NULL DEFAULT '',
    account_email   TEXT    NOT NULL DEFAULT '',
    plan_kind       TEXT    NOT NULL DEFAULT 'team',
    checkout_url    TEXT    NOT NULL DEFAULT '',
    paypal_url      TEXT    NOT NULL DEFAULT '',
    status          TEXT    NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'paid', 'cancelled', 'expired')),
    created_at      TEXT    NOT NULL,
    expires_at      TEXT    NOT NULL DEFAULT '',
    paid_at         TEXT    NOT NULL DEFAULT '',
    cancelled_at    TEXT    NOT NULL DEFAULT '',
    claimed_at      TEXT    NOT NULL DEFAULT '',
    notes           TEXT    NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_email          ON jobs(account_email);
CREATE INDEX IF NOT EXISTS idx_jobs_plan_kind      ON jobs(plan_kind);
"""

# v2:加 ``provider`` / ``provider_url`` 通用支付通道字段。
# - ``provider``: ``paypal`` (默认) / ``gopay`` / 未来其他;无 CHECK 约束以便加新通道不用迁移 schema
# - ``provider_url``: 通用 redirect URL,印尼 GoPay 走 midtrans 的 ``app.midtrans.com/snap/v4/redirection/<id>``
# v1→v2 迁移:把 ``paypal_url`` 同步到 ``provider_url`` 留底,旧字段 paypal_url **保留不删**(向后兼容)。
_SCHEMA_SQL_V2_MIGRATION = """
ALTER TABLE jobs ADD COLUMN provider     TEXT NOT NULL DEFAULT 'paypal';
ALTER TABLE jobs ADD COLUMN provider_url TEXT NOT NULL DEFAULT '';
UPDATE jobs SET provider_url = paypal_url WHERE paypal_url != '';
"""

# v3:加 ``oauth_status`` 字段,跟踪付款后的 OAuth/CPA 续跑状态(用于服务重启时的 resume)。
# - 空串(默认):还没启动 OAuth,或不需要 OAuth 后处理
# - ``in_progress``:正在跑 OAuth/CPA;若 worker 中断重启,resume 入口会重试
# - ``completed``:OAuth + CPA 已落库,subscribe_team 入口看到该状态即整段跳过
# - ``failed``:多次重试仍失败,人工介入(查 notes 字段)
# 无 CHECK 约束,新状态值不用再迁移 schema。
_SCHEMA_SQL_V3_MIGRATION = """
ALTER TABLE jobs ADD COLUMN oauth_status TEXT NOT NULL DEFAULT '';
"""


def _open_connection(path: Path) -> sqlite3.Connection:
    """打开一个 SQLite 连接 + 设置 PRAGMA。

    数据库级 PRAGMA(``journal_mode=WAL``)第一次设置后持久;后续 connection 上设也是 no-op。
    连接级 PRAGMA(``synchronous`` / ``foreign_keys`` / ``busy_timeout``)每个连接都得设。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(str(path), isolation_level=None, timeout=10.0)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode = WAL")
    c.execute("PRAGMA synchronous = NORMAL")
    c.execute("PRAGMA foreign_keys = ON")
    c.execute("PRAGMA busy_timeout = 5000")
    return c


def _apply_schema(c: sqlite3.Connection) -> None:
    """根据 ``PRAGMA user_version`` 跑 schema migration。

    v0 → v1: 从空建表 + 索引(初始 SQLite 重构)。
    v1 → v2: 加 ``provider`` / ``provider_url`` 通用支付通道字段。
    v2 → v3: 加 ``oauth_status`` 字段(本次,用于 subscribe_team 重启 resume)。
    """
    cur = c.execute("PRAGMA user_version")
    version = cur.fetchone()[0]
    if version < 1:
        c.executescript(_SCHEMA_SQL_V1)
        c.execute("PRAGMA user_version = 1")
    if version < 2:
        # ALTER TABLE 不能在 BEGIN..COMMIT 里跑(SQLite 不支持事务里改 schema),executescript
        # 自己 implicit-commit 处理。失败时已添加的列下次启动会让 ALTER 抛 "duplicate column",
        # 走 IF NOT EXISTS 兜底。
        try:
            c.executescript(_SCHEMA_SQL_V2_MIGRATION)
        except sqlite3.OperationalError as exc:
            # 上次迁移半成功:列已加但 user_version 没设。容忍,继续置 version。
            if "duplicate column name" not in str(exc).lower():
                raise
            log.warning("payment_inbox: v2 ALTER 部分已生效(%s),跳过 ALTER 直接置 version", exc)
        c.execute("PRAGMA user_version = 2")
    if version < 3:
        try:
            c.executescript(_SCHEMA_SQL_V3_MIGRATION)
        except sqlite3.OperationalError as exc:
            if "duplicate column name" not in str(exc).lower():
                raise
            log.warning("payment_inbox: v3 ALTER 部分已生效(%s),跳过 ALTER 直接置 version", exc)
        c.execute("PRAGMA user_version = 3")


def _migrate_json_to_sqlite(json_path: Path, c: sqlite3.Connection) -> int:
    """一次性把旧 ``payment_inbox.json`` 内容导入 SQLite。

    成功后把 JSON 改名为 ``<json_path>.migrated.<ts>`` 留底,**不删除**(用户可手动清理)。
    JSON 不存在或为空则什么也不做,返回 0。
    返回:迁入的 job 数。
    """
    if not json_path.exists():
        return 0
    try:
        with json_path.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        log.exception("payment_inbox: 读旧 JSON 失败,跳过迁移 %s", json_path)
        return 0
    jobs: list[dict[str, Any]] = []
    if isinstance(data, list):
        jobs = [j for j in data if isinstance(j, dict)]
    elif isinstance(data, dict) and isinstance(data.get("jobs"), list):
        jobs = [j for j in data["jobs"] if isinstance(j, dict)]
    if not jobs:
        # 空 JSON 也改名,避免下次启动重跑迁移
        _rename_migrated(json_path)
        return 0

    cols = (
        "id", "account_name", "account_email", "plan_kind",
        "checkout_url", "paypal_url", "provider", "provider_url",
        "status", "created_at",
        "expires_at", "paid_at", "cancelled_at", "claimed_at", "notes",
    )
    rows = []
    for j in jobs:
        # 缺字段用空串/默认补,避免 CHECK 失败
        status = (j.get("status") or "pending")
        if status not in ("pending", "paid", "cancelled", "expired"):
            log.warning("payment_inbox: 迁移时遇到未知 status=%r,改 pending", status)
            status = "pending"
        # JSON 时代没有 provider/provider_url 概念,统一回填 paypal
        paypal_url_v = j.get("paypal_url") or ""
        provider_v = (j.get("provider") or "paypal").strip().lower() or "paypal"
        # 老 JSON 没 provider_url,用 paypal_url 兜底;若 JSON 已经写过 provider_url(理论上不会)就尊重它
        provider_url_v = j.get("provider_url") or paypal_url_v
        rows.append((
            j.get("id") or uuid.uuid4().hex[:16],
            j.get("account_name") or "",
            j.get("account_email") or "",
            j.get("plan_kind") or "team",
            j.get("checkout_url") or "",
            paypal_url_v,
            provider_v,
            provider_url_v,
            status,
            j.get("created_at") or _now_iso(),
            j.get("expires_at") or "",
            j.get("paid_at") or "",
            j.get("cancelled_at") or "",
            j.get("claimed_at") or "",
            j.get("notes") or "",
        ))
    placeholders = ",".join(["?"] * len(cols))
    c.execute("BEGIN")
    try:
        c.executemany(
            f"INSERT OR REPLACE INTO jobs ({','.join(cols)}) VALUES ({placeholders})",
            rows,
        )
        c.execute("COMMIT")
    except Exception:
        c.execute("ROLLBACK")
        raise
    log.info("payment_inbox: 已从 %s 迁入 %d 条 job 到 SQLite", json_path, len(rows))
    _rename_migrated(json_path)
    return len(rows)


def _rename_migrated(json_path: Path) -> None:
    """JSON 迁移完毕改名为 ``<name>.migrated.<unix_ts>``,留底不删。"""
    ts = int(time.time())
    dest = json_path.with_suffix(json_path.suffix + f".migrated.{ts}")
    try:
        json_path.rename(dest)
        log.info("payment_inbox: 旧 JSON 已重命名为 %s", dest.name)
    except OSError as exc:
        log.warning("payment_inbox: 重命名旧 JSON 失败(%s),下次启动可能重跑迁移", exc)


class InboxStore:
    """SQLite 单文件 + WAL 模式的 inbox 存储。

    - 路径:默认 ``<inbox_dir>/payment_inbox.db``,可由 ``OPAI_PAYMENT_INBOX_DB_PATH`` 覆盖
    - 启动时检测同目录旧 ``payment_inbox.json``,**一次性自动迁移**(见 ``_migrate_json_to_sqlite``)
    - per-thread connection(``threading.local``):``ThreadingHTTPServer`` 每请求一个线程
    - WAL 模式 reader/writer 不互阻塞;高并发 ``GET /api/jobs`` 不再排队
    """

    def __init__(self, path: Path | None = None):
        """``path`` 兼容老 JSON 路径或新 SQLite 路径:
        - ``.json`` 后缀 → 使用同目录 ``payment_inbox.db``,并把 JSON 当迁移源
        - ``.db`` 后缀(或别的)→ 直接当 SQLite 路径
        - ``None`` → 用 ``_default_inbox_db_path()``,JSON 源用 ``_default_inbox_path()``
        """
        if path is None:
            self.path = _default_inbox_db_path()
            self._legacy_json_path = _default_inbox_path()
        elif path.suffix == ".json":
            # 兼容老 caller(测试 fixture / 旧代码)传 .json 路径
            self.path = path.with_suffix(".db")
            self._legacy_json_path = path
        else:
            self.path = path
            self._legacy_json_path = path.with_suffix(".json")

        self._tls = threading.local()
        self._init_lock = threading.Lock()
        self._initialized = False

    def _conn(self) -> sqlite3.Connection:
        """Per-thread connection;首次调用时建表 + 触发 JSON 迁移。"""
        c = getattr(self._tls, "conn", None)
        if c is None:
            c = _open_connection(self.path)
            self._ensure_schema_once(c)
            self._tls.conn = c
        return c

    def _ensure_schema_once(self, c: sqlite3.Connection) -> None:
        """全局只跑一次:apply schema + JSON 迁移。"""
        with self._init_lock:
            if self._initialized:
                return
            _apply_schema(c)
            try:
                _migrate_json_to_sqlite(self._legacy_json_path, c)
            except Exception:
                log.exception("payment_inbox: JSON 迁移异常(继续启动)")
            self._initialized = True

    def close_thread_connection(self) -> None:
        """Close the current thread's SQLite connection if open.

        Call this from request-handler ``finish()`` so per-request threads in
        ``ThreadingHTTPServer`` don't leak SQLite connections (each thread holds
        its own via ``threading.local``).
        """
        c = getattr(self._tls, "conn", None)
        if c is None:
            return
        try:
            c.close()
        except Exception:
            log.debug("payment_inbox: thread conn close failed", exc_info=True)
        try:
            del self._tls.conn
        except AttributeError:
            pass

    def list(
        self,
        *,
        status: str | None = None,
        email: str | None = None,
        plan_kind: str | None = None,
        limit: int | None = None,
        offset: int = 0,
        order: str = "created_desc",
    ) -> tuple[list[PaymentInboxJob], int]:
        c = self._conn()
        where: list[str] = []
        params: list[Any] = []
        if status:
            where.append("status = ?")
            params.append(status)
        if email:
            # 大小写不敏感子串(LIKE + LOWER)
            where.append("LOWER(account_email) LIKE ?")
            params.append(f"%{email.lower()}%")
        if plan_kind:
            where.append("plan_kind = ?")
            params.append(plan_kind)
        where_sql = ("WHERE " + " AND ".join(where)) if where else ""
        # ORDER 子句:created_at 主键 + rowid 二级(insertion order tie-break,
        # 防止同一 microsecond 内多条 created_at 相等时排序不稳定)
        direction = "ASC" if order == "created_asc" else "DESC"
        order_sql = f"ORDER BY created_at {direction}, rowid {direction}"

        # total(过滤后总数,不含 limit/offset)
        total = c.execute(
            f"SELECT COUNT(*) AS n FROM jobs {where_sql}", params
        ).fetchone()["n"]

        if limit is not None and limit > 0:
            page_sql = f"SELECT * FROM jobs {where_sql} {order_sql} LIMIT ? OFFSET ?"
            page_params = list(params) + [limit, max(0, offset)]
        elif offset > 0:
            # offset 但无 limit:用 LIMIT -1 OFFSET N(SQLite 里 LIMIT -1 = 不限)
            page_sql = f"SELECT * FROM jobs {where_sql} {order_sql} LIMIT -1 OFFSET ?"
            page_params = list(params) + [offset]
        else:
            page_sql = f"SELECT * FROM jobs {where_sql} {order_sql}"
            page_params = list(params)

        rows = c.execute(page_sql, page_params).fetchall()
        jobs = [dict(r) for r in rows]
        return jobs, int(total)

    def get(self, job_id: str) -> PaymentInboxJob | None:
        c = self._conn()
        row = c.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        return dict(row) if row else None

    def create(
        self,
        *,
        account_name: str,
        account_email: str,
        plan_kind: str,
        checkout_url: str,
        paypal_url: str | None = None,
        provider: str = "paypal",
        provider_url: str | None = None,
        expires_at: str | None = None,
        notes: str = "",
    ) -> PaymentInboxJob:
        # ``provider_url`` 默认从 paypal_url 兜底,保证旧 caller(只传 paypal_url)行为不变;
        # 新 caller(GoPay 等)显式传 ``provider`` + ``provider_url``,paypal_url 留空。
        eff_provider = (provider or "paypal").strip().lower() or "paypal"
        eff_paypal_url = paypal_url or ""
        if provider_url is None:
            eff_provider_url = eff_paypal_url if eff_provider == "paypal" else ""
        else:
            eff_provider_url = provider_url or ""
        c = self._conn()
        for _attempt in range(3):
            jid = uuid.uuid4().hex[:16]
            now = _now_iso()
            try:
                c.execute(
                    """
                    INSERT INTO jobs (
                        id, account_name, account_email, plan_kind,
                        checkout_url, paypal_url, provider, provider_url, status,
                        created_at, expires_at, paid_at, cancelled_at,
                        claimed_at, notes
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, '', '', '', ?)
                    """,
                    (
                        jid, account_name, account_email, plan_kind,
                        checkout_url, eff_paypal_url, eff_provider, eff_provider_url,
                        now, expires_at or "", notes,
                    ),
                )
                break
            except sqlite3.IntegrityError as exc:
                # PRIMARY KEY 冲突(uuid 撞库,理论 ~0)→ 重生成
                if "UNIQUE constraint" not in str(exc):
                    raise
                continue
        else:
            raise RuntimeError("payment_inbox: 3 次 uuid 都撞库,放弃")
        # 读出来返(保持原 JSON 实现的"返回完整 job dict"行为)
        row = c.execute("SELECT * FROM jobs WHERE id = ?", (jid,)).fetchone()
        return dict(row)

    # 允许 patch 写的字段(不含 id — 不可变;``created_at`` 在白名单内仅供 prune 测试
    # 伪造历史;生产代码不应该改 created_at)
    _PATCH_ALLOWED_FIELDS = frozenset({
        "account_name", "account_email", "plan_kind",
        "checkout_url", "paypal_url", "provider", "provider_url", "status",
        "expires_at", "paid_at", "cancelled_at", "claimed_at", "notes",
        "oauth_status",
        "created_at",
    })

    def patch(self, job_id: str, updates: dict[str, Any]) -> PaymentInboxJob | None:
        c = self._conn()
        clean = {k: v for k, v in updates.items() if k in self._PATCH_ALLOWED_FIELDS}
        if not clean:
            # 啥都没传 → 直接返当前 job(行为兼容)
            return self.get(job_id)
        cols = list(clean.keys())
        set_sql = ", ".join(f"{col}=?" for col in cols)
        params = [clean[k] for k in cols] + [job_id]
        row = c.execute(
            f"UPDATE jobs SET {set_sql} WHERE id=? RETURNING *",
            params,
        ).fetchone()
        return dict(row) if row else None

    def delete(self, job_id: str) -> bool:
        c = self._conn()
        cur = c.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
        return cur.rowcount > 0

    def expire_overdue(self) -> int:
        """把 ``status='pending'`` 且 ``expires_at`` < 当前时间的 job 标 expired。返回处理数。"""
        c = self._conn()
        now_iso = _now_iso()
        cur = c.execute(
            """
            UPDATE jobs
            SET status = 'expired'
            WHERE status = 'pending'
              AND expires_at != ''
              AND expires_at < ?
            """,
            (now_iso,),
        )
        return cur.rowcount

    def prune_old(self, retention_sec: float, *, keep_pending: bool = True) -> int:
        """删除 created_at 早于 ``now - retention_sec`` 的**终态** job(paid/cancelled/expired)。

        ``keep_pending=True``(默认)— 即便 created_at 很老,pending 不删(等真正付款)。
        ``retention_sec <= 0`` → no-op,返回 0(与原行为一致)。
        """
        if retention_sec <= 0:
            return 0
        c = self._conn()
        cutoff = (datetime.now(timezone.utc) - timedelta(seconds=retention_sec)).isoformat()
        if keep_pending:
            sql = """
                DELETE FROM jobs
                WHERE status IN ('paid', 'cancelled', 'expired')
                  AND created_at != ''
                  AND created_at < ?
            """
        else:
            sql = """
                DELETE FROM jobs
                WHERE created_at != '' AND created_at < ?
            """
        cur = c.execute(sql, (cutoff,))
        return cur.rowcount

    def claim_next_pending(
        self,
        *,
        prefer_paypal_url: bool = False,
        prefer_oldest: bool = False,
        ttl_sec: float = 60.0,
        provider: str = "",
    ) -> "PaymentInboxJob | None":
        """**原子地** select + claim 下一条 pending job(单条 SQL,不会双 claim)。

        Args:
            prefer_paypal_url: 历史名;v2 起语义为"有可点的支付链接"——
                只选 ``paypal_url`` 或 ``provider_url`` 非空的。都没有则放弃(返 None)。
            prefer_oldest: True 用 ``created_at ASC`` 排序;否则 ``DESC``。
            ttl_sec: claim TTL 秒数。``claimed_at`` 早于 ``now - ttl_sec`` 的 job 视为可重新 claim。
            provider: 可选，只 claim 指定 provider 的 job（如 ``"gopay"``）。
        """
        c = self._conn()
        now_iso = _now_iso()
        cutoff_iso = (
            datetime.now(timezone.utc) - timedelta(seconds=ttl_sec)
        ).isoformat()

        order_sql = "ASC" if prefer_oldest else "DESC"
        pp_filter = "AND (paypal_url != '' OR provider_url != '')" if prefer_paypal_url else ""
        provider_filter = f"AND provider = '{provider}'" if provider else ""

        sql = f"""
            UPDATE jobs SET claimed_at = ?
            WHERE id = (
                SELECT id FROM jobs
                WHERE status = 'pending' {pp_filter} {provider_filter}
                  AND (claimed_at = '' OR claimed_at < ?)
                ORDER BY created_at {order_sql}
                LIMIT 1
            )
            RETURNING *
        """
        row = c.execute(sql, (now_iso, cutoff_iso)).fetchone()
        return dict(row) if row else None

    def set_status_if_pending(
        self,
        job_id: str,
        new_status: str,
    ) -> "PaymentInboxJob | None":
        """幂等状态转移:仅当当前 ``status='pending'`` 时改;否则返回当前 job 不动。

        - ``new_status='paid'`` → 同一事务设 ``paid_at=now``
        - ``new_status='cancelled'`` → 设 ``cancelled_at=now``
        - ``new_status='expired'`` → 不设额外时间戳

        多线程并发同时调本方法,只有一个会真改,其它返回首改后的最终 job(各字段一致)。
        """
        if new_status not in ("paid", "cancelled", "expired"):
            raise ValueError(f"unsupported status: {new_status!r}")
        c = self._conn()
        now = _now_iso()
        if new_status == "paid":
            sql = """
                UPDATE jobs SET status='paid', paid_at=?
                WHERE id=? AND status='pending'
                RETURNING *
            """
            params = (now, job_id)
        elif new_status == "cancelled":
            sql = """
                UPDATE jobs SET status='cancelled', cancelled_at=?
                WHERE id=? AND status='pending'
                RETURNING *
            """
            params = (now, job_id)
        else:  # expired
            sql = """
                UPDATE jobs SET status='expired'
                WHERE id=? AND status='pending'
                RETURNING *
            """
            params = (job_id,)
        row = c.execute(sql, params).fetchone()
        if row:
            return dict(row)
        # rowcount=0:status 已不再 pending(被别人改过)→ 返回当前 job
        return self.get(job_id)


# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------


def _server_token() -> str:
    return (os.environ.get("OPAI_PAYMENT_INBOX_TOKEN") or "").strip()


def _server_retention_sec() -> float:
    """终态 job（paid/cancelled/expired）保留秒数；超出后台线程每小时清一次。
    默认 ``604800`` = 7 天，最小 3600（1 小时）；``OPAI_PAYMENT_INBOX_RETENTION_SEC`` 可调，
    设 ``0`` 关闭自动清理（永远保留，需要手动 DELETE）。
    """
    raw = (os.environ.get("OPAI_PAYMENT_INBOX_RETENTION_SEC") or "").strip()
    try:
        v = float(raw) if raw else 7 * 24 * 3600.0
    except (TypeError, ValueError):
        v = 7 * 24 * 3600.0
    if v <= 0:
        return 0.0
    return max(3600.0, v)


def _server_claim_ttl_sec() -> float:
    """已被某用户「点开支付链接」(claim) 的 pending job 在 list 视图里临时隐藏的秒数。
    防止多人浏览面板同时点同一条 job 造成竞争。默认 60s，env ``OPAI_PAYMENT_INBOX_CLAIM_TTL_SEC`` 可调（最小 5）。

    仅在 ``OPAI_PAYMENT_INBOX_CLAIM_BEHAVIOR=hide`` 模式下生效；
    默认 ``sort_bottom`` 模式不隐藏 claim，TTL 不再起作用。
    """
    raw = (os.environ.get("OPAI_PAYMENT_INBOX_CLAIM_TTL_SEC") or "").strip()
    try:
        v = float(raw) if raw else 60.0
    except (TypeError, ValueError):
        v = 60.0
    return max(5.0, v)


def _server_claim_behavior() -> str:
    """``sort_bottom``（默认）：claim 过的 job 排到列表最底，bulk-open 跳过它们；
    用户能继续在底部看到「我点过这条链接」的订单，避免误删 + 防止漏掉「需要手动确认订阅」的边缘 case。

    ``hide``（旧行为）：claim 后 TTL 内隐藏，TTL 过完再回到顶部。

    设 ``OPAI_PAYMENT_INBOX_CLAIM_BEHAVIOR=hide`` 恢复旧行为。
    """
    v = (os.environ.get("OPAI_PAYMENT_INBOX_CLAIM_BEHAVIOR") or "sort_bottom").strip().lower()
    if v in ("hide", "filter", "ttl"):
        return "hide"
    return "sort_bottom"


def _is_job_actively_claimed(job: PaymentInboxJob, ttl_sec: float, now: datetime | None = None) -> bool:
    """判断 job 是否处于"已被 claim 但仍在 TTL 内"——这种状态下 list 视图里隐藏该 job，
    供其它人继续看到的列表里就不会再看到它，避免重复点击。"""
    if (job.get("status") or "") != "pending":
        return False
    cl = (job.get("claimed_at") or "").strip()
    if not cl:
        return False
    try:
        ts = datetime.fromisoformat(cl.replace("Z", "+00:00"))
    except Exception:
        return False
    n = now or datetime.now(timezone.utc)
    return (n - ts).total_seconds() < ttl_sec


def _job_has_claim(job: PaymentInboxJob) -> bool:
    """是否曾经被点开过支付链接（不看 TTL，纯看是否有 ``claimed_at``）。"""
    return (job.get("status") or "") == "pending" and bool((job.get("claimed_at") or "").strip())


def _claim_ts(job: PaymentInboxJob) -> str:
    """供排序用的 claim 时间戳（claim 越新越靠后）。"""
    return (job.get("claimed_at") or "").strip()


def _server_basic_auth() -> tuple[str, str] | None:
    """Returns (user, pass) tuple if both env are set; else None (basic auth disabled)."""
    u = (os.environ.get("OPAI_PAYMENT_INBOX_BASIC_USER") or "").strip()
    p = (os.environ.get("OPAI_PAYMENT_INBOX_BASIC_PASS") or "").strip()
    if u and p:
        return u, p
    return None


_HTML_PAGE = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>OPAI Payment Inbox</title>
<style>
body{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;margin:1em;background:#f7f7f9;color:#222;}
h1{font-size:18px;margin:0 0 0.5em 0;}
.bar{margin-bottom:0.6em;color:#666;font-size:13px;}
table{border-collapse:collapse;width:100%;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.06);}
th,td{padding:8px 10px;border-bottom:1px solid #eee;font-size:13px;vertical-align:top;text-align:left;}
th{background:#fafafa;font-weight:600;}
tr.s-pending{background:#fffbf3;}
tr.s-pending.has-claim{background:#eaeaf2;color:#777;}  /* 已点过支付链接：灰底沉底 */
tr.s-pending.has-claim td b{color:#777;font-weight:500;}
tr.s-pending.has-claim td.urls a{color:#888;text-decoration:line-through;}
tr.s-paid{background:#f3fff5;color:#666;}
tr.s-expired,tr.s-cancelled{background:#f5f5f5;color:#999;}
.status{font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:.5px;padding:2px 6px;border-radius:3px;}
.s-pending .status{background:#ffd966;color:#664d00;}
.s-paid .status{background:#7fc28b;color:#fff;}
.s-expired .status{background:#bbb;color:#fff;}
.s-cancelled .status{background:#999;color:#fff;}
a{color:#0a58ca;word-break:break-all;}
.small{font-size:11px;color:#888;}
button{margin:0 4px 0 0;padding:4px 10px;border:1px solid #ccc;background:#fff;border-radius:3px;cursor:pointer;font-size:12px;}
button.primary{background:#28a745;color:#fff;border-color:#28a745;}
button.danger{background:#dc3545;color:#fff;border-color:#dc3545;}
button:hover{filter:brightness(0.95);}
.urls a{display:block;margin:2px 0;}
</style>
</head>
<body>
<h1>OPAI Payment Inbox</h1>
<div class="bar">
  <span id="summary">loading…</span>
  &nbsp;|&nbsp;
  状态：
  <select id="filter_status" onchange="resetAndLoad()">
    <option value="pending" selected>pending（待付）</option>
    <option value="">全部</option>
    <option value="paid">paid</option>
    <option value="cancelled">cancelled</option>
    <option value="expired">expired</option>
  </select>
  &nbsp;|&nbsp;
  邮箱包含：<input id="filter_email" oninput="debouncedReload()" placeholder="子串" style="width:160px;">
  &nbsp;|&nbsp;
  每页：
  <select id="page_size" onchange="resetAndLoad()">
    <option value="20">20</option>
    <option value="50" selected>50</option>
    <option value="100">100</option>
    <option value="200">200</option>
  </select>
  &nbsp;|&nbsp;
  <button onclick="bulkOpen('provider_url')" class="primary">批量开 10 个支付链接</button>
  <button onclick="bulkOpen('checkout_url')">批量开 10 个 Checkout</button>
</div>
<div class="bar">
  <button onclick="prevPage()" id="btn_prev">上页</button>
  <span id="page_info">page 1</span>
  <button onclick="nextPage()" id="btn_next">下页</button>
  &nbsp;|&nbsp;
  自动刷新 1s（点过的 60s 内对其他人临时隐藏）
</div>
<table>
<thead><tr>
  <th>账号</th><th>Plan</th><th>状态</th><th>创建</th><th>过期</th><th>支付链接</th><th>操作</th>
</tr></thead>
<tbody id="rows"><tr><td colspan="7">loading…</td></tr></tbody>
</table>
<script>
const TOKEN = (() => {
  // 从 cookie 读 token；URL 里 ?token=... 也写一次 cookie
  const u = new URL(location.href);
  const t = u.searchParams.get('token');
  if (t) { document.cookie = `inbox_token=${t}; path=/; max-age=86400`; u.searchParams.delete('token'); history.replaceState(null,'',u.toString()); return t; }
  const m = document.cookie.match(/inbox_token=([^;]+)/);
  return m ? m[1] : '';
})();
function authHeaders() { return TOKEN ? {'X-Auth-Token': TOKEN} : {}; }
function fmtTs(s){ if(!s)return '-'; try{const d=new Date(s); return d.toLocaleString();}catch{return s;} }
function statusClass(s){ return 's-' + (s||'pending'); }
let _curPage = 0;     // 0-based
let _curTotal = 0;
let _reloadDebounce = null;
let _lastJobs = [];   // 缓存最近一次 list 结果，bulkOpen 同步消费（避免 await fetch 丢失 user gesture）
// 客户端"近期已消费" 黑名单（id → unix ms 过期点）：claim 是 async 火并忘，
// 服务端 claimed_at 落库前下一次 loadJobs 可能把已点过的 job 拉回；这层兜底
// 防止 bulkOpen 重复打开同一条。TTL 设成服务端 claim TTL 的 2 倍 + buffer。
const _recentlyConsumed = new Map();
const _CONSUMED_TTL_MS = 150 * 1000;  // 2.5 分钟，覆盖 server claim TTL=60s + 用户犹豫时间
function _markConsumed(id){ _recentlyConsumed.set(id, Date.now() + _CONSUMED_TTL_MS); }
function _isRecentlyConsumed(id){
  const exp = _recentlyConsumed.get(id);
  if (!exp) return false;
  if (Date.now() < exp) return true;
  _recentlyConsumed.delete(id);
  return false;
}
function resetAndLoad(){ _curPage = 0; loadJobs(); }
function debouncedReload(){ clearTimeout(_reloadDebounce); _reloadDebounce = setTimeout(resetAndLoad, 350); }
function prevPage(){ if (_curPage > 0) { _curPage--; loadJobs(); } }
function nextPage(){
  const limit = parseInt(document.getElementById('page_size').value, 10) || 50;
  if ((_curPage + 1) * limit < _curTotal) { _curPage++; loadJobs(); }
}
function buildQuery(){
  const status = document.getElementById('filter_status').value;
  const email = document.getElementById('filter_email').value.trim();
  const limit = parseInt(document.getElementById('page_size').value, 10) || 50;
  const offset = _curPage * limit;
  const params = new URLSearchParams({limit, offset});
  if (status) params.set('status', status);
  if (email) params.set('email', email);
  return params.toString();
}
async function loadJobs() {
  const r = await fetch('/api/jobs?' + buildQuery(), {headers: authHeaders()});
  if (!r.ok) {
    document.getElementById('rows').innerHTML = `<tr><td colspan=7>读取失败 ${r.status}: ${await r.text()}</td></tr>`;
    return;
  }
  const data = await r.json();
  const jobs = data.jobs || [];
  // 同时从 server 列表里抠掉本会话最近 N 秒已消费过的（防 claim race）
  const filtered = jobs.filter(j => !_isRecentlyConsumed(j.id));
  _lastJobs = filtered.slice();  // 缓存供 bulkOpen 同步使用
  _curTotal = data.total || 0;
  const limit = data.limit || jobs.length || 50;
  const visible = filtered;  // server 已过滤 claim+status；客户端再过本会话黑名单
  // 分页 UI
  const totalPages = Math.max(1, Math.ceil(_curTotal / Math.max(1, limit)));
  document.getElementById('page_info').textContent = `page ${_curPage + 1} / ${totalPages}（命中 ${_curTotal}）`;
  document.getElementById('btn_prev').disabled = _curPage <= 0;
  document.getElementById('btn_next').disabled = !data.has_more;
  document.getElementById('summary').textContent = `本页 ${jobs.length} 条 / 命中 ${_curTotal} 条`;
  document.getElementById('rows').innerHTML = visible.map(j => {
    // claim 标记：服务端已 sort_bottom 把这些排到列表底部，前端只负责加灰底 class +
    // bulkOpen 跳过它们。用户能看到「这条我点过」的提示，避免对已付款的订阅又重复付一次。
    const cls = statusClass(j.status) + (j.claimed_at ? ' has-claim' : '');
    const claimTag = j.claimed_at ? `<div class="small" style="color:#a35">已点过 ${fmtTs(j.claimed_at)}</div>` : '';
    // v3 oauth_status 状态标(只在非空时显示),给 manual-paypal 重启 resume 看
    const oauthTag = j.oauth_status ? `<div class="small" style="color:#246">oauth: ${escapeHtml(j.oauth_status)}</div>` : '';
    return `
    <tr class="${cls}" data-id="${j.id}">
      <td><b>${escapeHtml(j.account_name||'')}</b><div class="small">${escapeHtml(j.account_email||'')}</div>${claimTag}${oauthTag}</td>
      <td>${escapeHtml(j.plan_kind||'')}</td>
      <td><span class="status">${escapeHtml(j.status||'')}</span></td>
      <td class="small">${fmtTs(j.created_at)}</td>
      <td class="small">${fmtTs(j.expires_at)}</td>
      <td class="urls">
        ${(j.provider_url || j.paypal_url) ? `<a href="${escapeAttr(j.provider_url || j.paypal_url)}" target="_blank" onclick="onLinkClick(event, '${j.id}', '${escapeAttr(j.provider || 'paypal')}')">${escapeHtml((j.provider || 'paypal').toUpperCase())} goto</a>` : ''}
        ${j.checkout_url ? `<a href="${escapeAttr(j.checkout_url)}" target="_blank" onclick="onLinkClick(event, '${j.id}', 'checkout')">Checkout</a>` : ''}
      </td>
      <td>
        ${j.status==='pending'
          ? `<button class="primary" onclick="markPaid('${j.id}')">Mark Paid</button>
             <button class="danger" onclick="cancelJob('${j.id}')">Cancel</button>`
          : `<button onclick="del('${j.id}')">Delete</button>`}
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan=7>(空，可能都被领走了；60s 后会重新出现)</td></tr>';
}
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s){ return escapeHtml(s); }
async function claim(id){
  // 标记 60s 临时占用：列表里其他用户看不到，避免多人争抢同一条
  try {
    const r = await fetch(`/api/jobs/${id}/claim`, {
      method:'PUT', headers: authHeaders(), credentials: 'same-origin',
    });
    if (!r.ok) console.warn('[inbox] claim failed', id, r.status);
  } catch(e){ console.warn('[inbox] claim exception', id, e); }
}
function _consumeJob(id){
  // 单点：黑名单 + DOM 删行 + 从 _lastJobs 缓存移除。任何"已经被处理过"的 job 都该这样调一次，
  // 避免后续 bulkOpen 从陈旧缓存里再次抓到同一条重复打开（即使下次 loadJobs 把它拉回，
  // _markConsumed 写的过期点会让 loadJobs 自动从 _lastJobs 里再过滤掉它）。
  _markConsumed(id);
  _lastJobs = _lastJobs.filter(j => j.id !== id);
  const tr = document.querySelector(`tr[data-id="${id}"]`);
  if (tr) tr.remove();
}
function onLinkClick(ev, id, kind){
  // 不阻止默认 → 链接照常在新 tab 打开；同步并发触发 claim 并 consume
  claim(id);
  _consumeJob(id);
}
function _tryOpenInNewTab(url){
  // 仅 window.open：返 null 即明确未开，给 fallback 面板。**不再叠加 <a>.click()** —
  // 部分浏览器 (Chrome 某些 build / Edge) 即使 window.open 已成功打开 tab，<a>.click() 也会
  // 再开一次，导致同一链接打开两次（用户实际反馈的 bug）。fallback 面板里的 <a> 是用户
  // 真鼠标点击，浏览器一定放行，不需要 anchor 兜底。
  try {
    const w = window.open(url, '_blank', 'noopener,noreferrer');
    return !!w;
  } catch(e) {
    return false;
  }
}
function _showFallbackPanel(targets, field){
  // 浏览器拦了多窗口 → 渲染一个面板，每个链接是真 <a target=_blank>，
  // 用户 **真实鼠标点一次** = 真 user gesture，浏览器一定放行。
  let panel = document.getElementById('_bulkFallback');
  if (panel) panel.remove();
  panel = document.createElement('div');
  panel.id = '_bulkFallback';
  panel.style.cssText = 'position:fixed;right:1em;bottom:1em;width:380px;max-height:70vh;overflow:auto;'
    + 'background:#fff;border:2px solid #dc3545;border-radius:6px;padding:12px;'
    + 'box-shadow:0 4px 16px rgba(0,0,0,.2);z-index:9999;font-size:13px;';
  panel.innerHTML = `
    <div style="margin-bottom:8px;color:#dc3545;font-weight:600;">
      ⚠ 浏览器拦截了批量弹窗（每次手势只允许 1 个）
    </div>
    <div style="margin-bottom:8px;color:#666;">
      点击下面每个链接（每个都是真实点击）即可打开。<br>
      或：地址栏右侧"已拦截弹窗"图标 → <b>始终允许</b>，下次就能一键开 10 个。
    </div>
    <div id="_bulkFallbackLinks"></div>
    <div style="margin-top:10px;text-align:right;">
      <button onclick="document.getElementById('_bulkFallback').remove()">关闭</button>
    </div>
  `;
  document.body.appendChild(panel);
  const list = panel.querySelector('#_bulkFallbackLinks');
  for (const j of targets) {
    const row = document.createElement('div');
    row.style.cssText = 'margin:4px 0;padding:6px;border:1px solid #eee;border-radius:3px;';
    const a = document.createElement('a');
    a.href = _jobActionUrl(j, field);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = `${j.account_email || j.account_name} (${j.plan_kind})`;
    a.style.cssText = 'color:#0a58ca;text-decoration:none;display:block;';
    a.addEventListener('click', () => {
      claim(j.id);
      _consumeJob(j.id);
      row.style.opacity = '0.4';
      row.style.textDecoration = 'line-through';
    });
    row.appendChild(a);
    list.appendChild(row);
  }
}
// v2:provider_url(GoPay/PayPal 通用)优先,paypal_url 兜底(老 PayPal 数据迁移后两者一致;
// 老 PayPal 客户端推的 job 只有 paypal_url)。checkout_url 字段独立,直接读 j.checkout_url。
function _jobActionUrl(j, field){
  if (field === 'checkout_url') return j.checkout_url || '';
  return j.provider_url || j.paypal_url || '';
}
function bulkOpen(field){
  // **同步函数**：不能 await，否则 user gesture 在 fetch 后失效。
  // 数据来源是 loadJobs 缓存的 _lastJobs。
  if (!Array.isArray(_lastJobs) || _lastJobs.length === 0) {
    alert('当前列表为空，等几秒页面刷新后再点');
    return;
  }
  // 防 dup：即使 _lastJobs 在 race 下含同 id 多次，target 里每个 id 只会出现一次。
  // **跳过 claimed_at 已设的 job**：用户已经点过这条链接，可能正在付款 / 已经付完
  // 但订阅检测有问题，让用户手动到列表底部确认；批量打开只挑没碰过的，避免重复付款。
  const _seen = new Set();
  const target = _lastJobs.filter(j => {
    if (!j || j.status !== 'pending' || !_jobActionUrl(j, field)) return false;
    if (j.claimed_at) return false;  // 已点过的不参与批量打开
    if (_seen.has(j.id)) return false;
    if (_isRecentlyConsumed(j.id)) return false;  // 客户端黑名单兜底
    _seen.add(j.id);
    return true;
  }).slice(0, 10);
  if (!target.length) {
    alert('没有「全新未点过」的任务可打开。\\n（已点过的订单沉到列表底部，需要时手动点击）');
    return;
  }
  // 不用 confirm（确保 gesture 能直接走到 window.open 第一个）
  let opened = 0;
  const blocked = [];
  for (let i = 0; i < target.length; i++) {
    const j = target[i];
    const ok = _tryOpenInNewTab(_jobActionUrl(j, field));
    if (ok) {
      opened++;
      claim(j.id);
      _consumeJob(j.id);
    } else {
      blocked.push(j);
    }
  }
  if (blocked.length > 0) {
    // 把被拦的渲染到 fallback 面板，让用户真实点击逐个开
    _showFallbackPanel(blocked, field);
  }
  if (opened === 0) {
    console.warn('[inbox] 浏览器拦截了所有弹窗，已渲染 fallback 面板');
  }
  setTimeout(loadJobs, 800);
}
async function _doStateChange(id, path, label){
  try {
    const r = await fetch(`/api/jobs/${id}${path}`, {
      method: 'PUT', headers: authHeaders(), credentials: 'same-origin',
    });
    if (!r.ok) {
      alert(`${label} 失败：HTTP ${r.status} ${await r.text()}`);
      return false;
    }
    return true;
  } catch (e) {
    alert(`${label} 网络错误：${e}`);
    return false;
  }
}
async function markPaid(id){
  if(!confirm('确认已完成 PayPal 付款？')) return;
  if (await _doStateChange(id, '/paid', 'Mark Paid')) {
    _consumeJob(id);  // 同步删 DOM + 移除缓存，避免 bulkOpen 重复抓
    loadJobs();
  }
}
async function cancelJob(id){
  if(!confirm('取消该任务？')) return;
  if (await _doStateChange(id, '/cancel', 'Cancel')) {
    _consumeJob(id);
    loadJobs();
  }
}
async function del(id){
  if(!confirm('删除该记录？')) return;
  try {
    const r = await fetch(`/api/jobs/${id}`, {
      method: 'DELETE', headers: authHeaders(), credentials: 'same-origin',
    });
    if (!r.ok) { alert(`删除失败：HTTP ${r.status} ${await r.text()}`); return; }
    _consumeJob(id);
    loadJobs();
  } catch (e) { alert(`删除网络错误：${e}`); }
}
loadJobs();
setInterval(loadJobs, 1000);
</script>
</body>
</html>
"""


class _OTPBox:
    """线程安全的 OTP 收发箱，供 GoPay 等服务使用。

    POST /api/otp          → 外部推送验证码 {"phone": "+62xxx", "code": "123456"}
    GET  /api/otp?phone=xx → GoPay 服务拉取验证码（自动消费，只取最新一条）
    """

    def __init__(self) -> None:
        import threading
        self._lock = threading.Lock()
        self._codes: dict[str, list[dict]] = {}  # phone -> [{code, ts}, ...]

    OTP_TTL = 300  # 5 分钟过期

    def push(self, phone: str, code: str) -> None:
        import time as _t
        phone = phone.strip().lstrip("+")
        now = _t.time()
        with self._lock:
            self._codes.setdefault(phone, []).append({
                "code": code.strip(),
                "ts": now,
            })
            # 清理过期 + 只保留最新 10 条
            self._codes[phone] = [
                e for e in self._codes[phone]
                if now - e["ts"] < self.OTP_TTL
            ][-10:]
        log.info("otp_box: pushed code=%s for phone=%s", code, phone)

    def pop(self, phone: str, after_ts: float = 0) -> str | None:
        import time as _t
        phone = phone.strip().lstrip("+")
        now = _t.time()
        with self._lock:
            entries = self._codes.get(phone, [])
            for entry in reversed(entries):
                if entry["ts"] > after_ts and now - entry["ts"] < self.OTP_TTL:
                    entries.remove(entry)
                    return entry["code"]
            # 清理过期
            self._codes[phone] = [e for e in entries if now - e["ts"] < self.OTP_TTL]
        return None

    def list_all(self) -> dict:
        import time as _t
        now = _t.time()
        with self._lock:
            return {
                k: [e.copy() for e in v if now - e["ts"] < self.OTP_TTL]
                for k, v in self._codes.items()
            }


class _InboxServer(ThreadingHTTPServer):
    # 每请求起独立线程：本地脚本 40 worker × 3s 轮询 = 13 QPS，靠多线程不阻塞
    store: InboxStore | None = None
    require_token: str = ""
    require_basic_auth: tuple[str, str] | None = None  # (user, pass) when set
    claim_ttl_sec: float = 60.0
    claim_behavior: str = "sort_bottom"  # "sort_bottom"（默认）/ "hide"（旧行为）
    otp_box: _OTPBox | None = None  # SMS/OTP 收发箱


class _InboxHandler(BaseHTTPRequestHandler):
    server: _InboxServer  # type: ignore[assignment]

    def log_message(self, format, *args):  # noqa: A002
        log.debug("payment_inbox HTTP: " + format, *args)

    # ---- 鉴权 ----
    @staticmethod
    def _ct_eq(a: str, b: str) -> bool:
        try:
            return hmac.compare_digest(a, b)
        except Exception:
            return False

    def _check_basic_auth(self) -> bool:
        creds = self.server.require_basic_auth
        if not creds:
            return False
        auth = self.headers.get("Authorization") or ""
        if not auth.startswith("Basic "):
            return False
        try:
            decoded = base64.b64decode(auth[6:].strip()).decode("utf-8", errors="replace")
        except Exception:
            return False
        if ":" not in decoded:
            return False
        u, p = decoded.split(":", 1)
        return self._ct_eq(u, creds[0]) and self._ct_eq(p, creds[1])

    def _check_token(self) -> bool:
        require = self.server.require_token
        if not require:
            return False
        # Bearer
        auth = self.headers.get("Authorization") or ""
        if auth.startswith("Bearer "):
            if self._ct_eq(auth[7:].strip(), require):
                return True
        # X-Auth-Token header
        x = (self.headers.get("X-Auth-Token") or "").strip()
        if x and self._ct_eq(x, require):
            return True
        # Cookie inbox_token
        cookie = self.headers.get("Cookie") or ""
        for part in cookie.split(";"):
            kv = part.strip().split("=", 1)
            if len(kv) == 2 and kv[0].strip() == "inbox_token" and self._ct_eq(kv[1].strip(), require):
                return True
        # ?token= 参数
        try:
            qs = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(qs)
            tok2 = (params.get("token") or [""])[0]
            if tok2 and self._ct_eq(tok2, require):
                return True
        except Exception:
            pass
        return False

    def _check_auth(self) -> bool:
        """两套认证任一通过就放行；都没配置则全开放。"""
        no_token = not self.server.require_token
        no_basic = not self.server.require_basic_auth
        if no_token and no_basic:
            return True
        if not no_basic and self._check_basic_auth():
            return True
        if not no_token and self._check_token():
            return True
        return False

    def _send_json(self, code: int, data: Any) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, TimeoutError):
            pass

    def _send_html(self, code: int, body: str) -> None:
        data = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, TimeoutError):
            pass

    def _send_text(self, code: int, msg: str) -> None:
        data = msg.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, TimeoutError):
            pass

    def _send_unauthorized_html(self) -> None:
        """HTML 入口未通过鉴权：附 WWW-Authenticate: Basic 让浏览器弹登录框。"""
        body = b"<h1>401 Unauthorized</h1>"
        self.send_response(HTTPStatus.UNAUTHORIZED)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if self.server.require_basic_auth:
            self.send_header("WWW-Authenticate", 'Basic realm="OPAI Payment Inbox", charset="UTF-8"')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, TimeoutError):
            pass

    def _send_unauthorized_json(self) -> None:
        body = json.dumps({"error": "unauthorized"}).encode("utf-8")
        self.send_response(HTTPStatus.UNAUTHORIZED)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if self.server.require_basic_auth:
            self.send_header("WWW-Authenticate", 'Basic realm="OPAI Payment Inbox", charset="UTF-8"')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, TimeoutError):
            pass

    def _read_json_body(self) -> dict[str, Any]:
        try:
            n = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            n = 0
        if n <= 0:
            return {}
        try:
            raw = self.rfile.read(n)
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def handle(self):  # noqa: D401
        try:
            super().handle()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, TimeoutError):
            pass
        except OSError as exc:
            if getattr(exc, "winerror", None) in (10053, 10054, 10060):
                return
            raise

    def finish(self):
        """Close per-request thread's SQLite connection before the thread dies."""
        try:
            store = self.server.store
            if store is not None:
                store.close_thread_connection()
        except Exception:
            pass
        try:
            super().finish()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, TimeoutError):
            pass

    # ---- 路由 ----
    def do_GET(self):  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        if path == "/" or path == "/index.html":
            if not self._check_auth():
                self._send_unauthorized_html()
                return
            store = self.server.store
            if store is not None:
                try:
                    store.expire_overdue()
                except Exception:
                    log.debug("payment_inbox: expire_overdue 异常", exc_info=True)
            self._send_html(HTTPStatus.OK, _HTML_PAGE)
            return
        if path == "/api/jobs":
            if not self._check_auth():
                self._send_unauthorized_json()
                return
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            status = (qs.get("status") or [""])[0] or None
            email = (qs.get("email") or [""])[0] or None
            plan_kind = (qs.get("plan_kind") or [""])[0] or None
            include_claimed = (qs.get("include_claimed") or ["0"])[0] in ("1", "true", "yes")
            order = (qs.get("order") or ["created_desc"])[0]
            try:
                limit = int((qs.get("limit") or ["50"])[0])
            except ValueError:
                limit = 50
            try:
                offset = int((qs.get("offset") or ["0"])[0])
            except ValueError:
                offset = 0
            limit = max(0, min(500, limit))  # 防过大单次返回
            offset = max(0, offset)

            store = self.server.store
            assert store is not None
            store.expire_overdue()

            if include_claimed:
                # 调用方明确要全集（脚本侧轮询用）：跳过 claim 过滤，store 内分页
                jobs, total = store.list(
                    status=status, email=email, plan_kind=plan_kind,
                    limit=limit if limit > 0 else None, offset=offset, order=order,
                )
            else:
                # 网页视角：根据 claim_behavior 决定是隐藏还是排序到底部
                jobs_full, _ = store.list(
                    status=status, email=email, plan_kind=plan_kind,
                    limit=None, offset=0, order=order,
                )
                behavior = getattr(self.server, "claim_behavior", "sort_bottom")
                if behavior == "hide":
                    # 旧行为：TTL 内的 claim 直接过滤掉
                    ttl = self.server.claim_ttl_sec
                    now = datetime.now(timezone.utc)
                    jobs_full = [j for j in jobs_full if not _is_job_actively_claimed(j, ttl, now)]
                else:
                    # 新默认 sort_bottom：claim 过的 pending 全部沉到列表底部
                    # 顶部：fresh + 非 pending（按 created_at 已经按 order 排好）
                    # 底部：claim 过的 pending（按 claimed_at 倒序，最近 claim 的先）
                    fresh, claimed = [], []
                    for j in jobs_full:
                        if _job_has_claim(j):
                            claimed.append(j)
                        else:
                            fresh.append(j)
                    claimed.sort(key=_claim_ts, reverse=True)
                    jobs_full = fresh + claimed
                total = len(jobs_full)
                if offset:
                    jobs_full = jobs_full[offset:]
                if limit:
                    jobs_full = jobs_full[:limit]
                jobs = jobs_full

            self._send_json(HTTPStatus.OK, {
                "jobs": jobs,
                "total": total,
                "limit": limit,
                "offset": offset,
                "has_more": (offset + len(jobs)) < total,
            })
            return
        if path.startswith("/api/jobs/"):
            if not self._check_auth():
                self._send_unauthorized_json()
                return
            jid = path.split("/", 3)[3]
            store = self.server.store
            assert store is not None
            j = store.get(jid)
            if j is None:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
                return
            self._send_json(HTTPStatus.OK, j)
            return
        if path == "/health":
            self._send_json(HTTPStatus.OK, {"ok": True})
            return
        # /api/otp?phone=xxx[&after=timestamp] — GoPay 服务拉取 OTP
        if path == "/api/otp":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            phone = (qs.get("phone") or [""])[0].strip()
            after_ts = float((qs.get("after") or ["0"])[0])
            otp_box = self.server.otp_box
            if otp_box is None:
                self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "otp_box not initialized"})
                return
            if not phone:
                # 列出所有待取的 OTP
                self._send_json(HTTPStatus.OK, otp_box.list_all())
                return
            code = otp_box.pop(phone, after_ts=after_ts)
            self._send_json(HTTPStatus.OK, {"phone": phone, "code": code})
            return
        self._send_text(HTTPStatus.NOT_FOUND, "not found")

    def do_POST(self):  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        if not self._check_auth():
            self._send_unauthorized_json()
            return
        if path == "/api/jobs/claim_next":
            data = self._read_json_body()
            store = self.server.store
            assert store is not None
            try:
                ttl = float(data.get("ttl_sec") or self.server.claim_ttl_sec)
            except (TypeError, ValueError):
                ttl = self.server.claim_ttl_sec
            job = store.claim_next_pending(
                prefer_paypal_url=bool(data.get("prefer_paypal_url")),
                prefer_oldest=bool(data.get("prefer_oldest")),
                ttl_sec=ttl,
                provider=str(data.get("provider") or ""),
            )
            if job is None:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "no_pending_job"})
                return
            self._send_json(HTTPStatus.OK, job)
            return
        if path == "/api/jobs":
            data = self._read_json_body()
            try:
                store = self.server.store
                assert store is not None
                # provider / provider_url 是 v2 字段;老 client(只发 paypal_url)走 store.create()
                # 默认行为(provider='paypal',provider_url 兜底 paypal_url)。
                raw_provider = data.get("provider")
                raw_provider_url = data.get("provider_url")
                job = store.create(
                    account_name=str(data.get("account_name") or "").strip(),
                    account_email=str(data.get("account_email") or "").strip(),
                    plan_kind=str(data.get("plan_kind") or "team").strip().lower(),
                    checkout_url=str(data.get("checkout_url") or "").strip(),
                    paypal_url=str(data.get("paypal_url") or "").strip(),
                    provider=str(raw_provider or "paypal").strip().lower() or "paypal",
                    provider_url=(str(raw_provider_url).strip() if raw_provider_url is not None else None),
                    expires_at=str(data.get("expires_at") or "").strip(),
                    notes=str(data.get("notes") or ""),
                )
                self._send_json(HTTPStatus.CREATED, job)
            except Exception as exc:
                log.exception("payment_inbox: 创建 job 失败")
                self._send_json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(exc)})
            return
        # /api/otp — 推送 OTP 验证码（外部 WhatsApp bot / SMS 网关调用）
        if path == "/api/otp":
            data = self._read_json_body()
            phone = str(data.get("phone", "")).strip()
            code = str(data.get("code", "")).strip()
            if not phone or not code:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "missing phone or code"})
                return
            otp_box = self.server.otp_box
            if otp_box is None:
                self._send_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "otp_box not initialized"})
                return
            otp_box.push(phone, code)
            self._send_json(HTTPStatus.OK, {"ok": True, "phone": phone, "code": code})
            return
        self._send_text(HTTPStatus.NOT_FOUND, "not found")

    def do_PUT(self):  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        if not self._check_auth():
            self._send_unauthorized_json()
            return
        store = self.server.store
        assert store is not None
        # /api/jobs/<id>  → JSON body 更新可变字段（仅 paypal_url / checkout_url / notes / expires_at）
        if path.startswith("/api/jobs/") and "/" not in path[len("/api/jobs/"):]:
            jid = path[len("/api/jobs/"):]
            data = self._read_json_body()
            allowed = {
                "paypal_url", "provider", "provider_url",
                "checkout_url", "notes", "expires_at",
                "oauth_status",
            }
            updates = {k: str(v).strip() if isinstance(v, str) else v
                       for k, v in data.items() if k in allowed}
            if not updates:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "no allowed fields", "allowed": sorted(allowed)})
                return
            j = store.patch(jid, updates)
            if j is None:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
                return
            self._send_json(HTTPStatus.OK, j)
            return
        # /api/jobs/<id>/claim — 网页用户点开支付链接前调用，TTL 内列表会隐藏此 job，
        # 避免多人浏览面板同时点同一条 job。返回新写入的 ``claimed_at`` 时间。
        if path.startswith("/api/jobs/") and path.endswith("/claim"):
            jid = path.split("/")[3]
            j = store.patch(jid, {"claimed_at": _now_iso()})
            if j is None:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
                return
            self._send_json(HTTPStatus.OK, {"id": j["id"], "claimed_at": j.get("claimed_at"),
                                            "ttl_sec": self.server.claim_ttl_sec})
            return
        # /api/jobs/<id>/paid 或 /cancel —— 用 set_status_if_pending 走幂等 SQL
        if path.startswith("/api/jobs/") and (path.endswith("/paid") or path.endswith("/cancel")):
            parts = path.split("/")
            jid = parts[3]
            action = parts[4]
            new_status = "paid" if action == "paid" else "cancelled"
            j = store.set_status_if_pending(jid, new_status)
            if j is None:
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "not_found"})
                return
            self._send_json(HTTPStatus.OK, j)
            return
        self._send_text(HTTPStatus.NOT_FOUND, "not found")

    def do_DELETE(self):  # noqa: N802
        path = urllib.parse.urlparse(self.path).path
        if not self._check_auth():
            self._send_unauthorized_json()
            return
        if path.startswith("/api/jobs/"):
            jid = path.split("/", 3)[3]
            store = self.server.store
            assert store is not None
            ok = store.delete(jid)
            self._send_json(HTTPStatus.OK if ok else HTTPStatus.NOT_FOUND, {"deleted": ok})
            return
        self._send_text(HTTPStatus.NOT_FOUND, "not found")


def run_inbox_server(host: str = "0.0.0.0", port: int = 18130, store: InboxStore | None = None) -> None:
    """启 inbox HTTP 服务（阻塞，Ctrl+C 退出）。"""
    inbox_store = store or InboxStore()
    otp_box = _OTPBox()
    srv = _InboxServer((host, port), _InboxHandler)
    srv.store = inbox_store
    srv.otp_box = otp_box
    srv.require_token = _server_token()
    srv.require_basic_auth = _server_basic_auth()
    srv.claim_ttl_sec = _server_claim_ttl_sec()
    srv.claim_behavior = _server_claim_behavior()
    retention = _server_retention_sec()

    # 后台线程每小时跑一次 prune_old，删 ``created_at`` 早于 ``retention`` 的终态记录。
    # 启动时先跑一次扫存量，pending 始终保留不被删。retention=0 关闭自动清理。
    if retention > 0:
        def _retention_loop() -> None:
            try:
                first = inbox_store.prune_old(retention)
                if first:
                    log.info("payment_inbox: 启动时清理 %d 条 ≥%.1fd 终态记录", first, retention / 86400.0)
            except Exception:
                log.exception("payment_inbox: 启动时 prune_old 异常")
            sleep_sec = min(3600.0, retention / 24.0)  # 至少 1 小时一次，但不超过 retention/24
            while True:
                try:
                    time.sleep(sleep_sec)
                    n = inbox_store.prune_old(retention)
                    if n:
                        log.info("payment_inbox: 周期清理 %d 条 ≥%.1fd 终态记录", n, retention / 86400.0)
                except Exception:
                    log.debug("payment_inbox: prune_old 周期异常", exc_info=True)
        threading.Thread(target=_retention_loop, daemon=True, name="inbox-retention").start()
        log.info("payment_inbox: retention=%.1fd（每 %.0fs 清一次终态记录）",
                 retention / 86400.0, min(3600.0, retention / 24.0))
    else:
        log.info("payment_inbox: retention 自动清理 已关闭（OPAI_PAYMENT_INBOX_RETENTION_SEC=0）")
    log.info(
        "payment_inbox: serving on http://%s:%d  (storage=%s, token=%s, basic=%s)",
        host, port, inbox_store.path,
        "set" if srv.require_token else "none",
        f"user={srv.require_basic_auth[0]}" if srv.require_basic_auth else "none",
    )
    print(f"\nOPAI Payment Inbox 已启动: http://{host}:{port}")
    print(f"  存储: {inbox_store.path}")
    print(f"  Token: {'已设（OPAI_PAYMENT_INBOX_TOKEN）' if srv.require_token else '未设（开放访问）'}")
    if srv.require_basic_auth:
        print(f"  Basic Auth: 用户={srv.require_basic_auth[0]}（OPAI_PAYMENT_INBOX_BASIC_USER/PASS）")
    else:
        print("  Basic Auth: 未设")
    if retention > 0:
        print(f"  Retention: {retention / 86400.0:.1f} 天（终态记录自动清理；OPAI_PAYMENT_INBOX_RETENTION_SEC=0 关闭）")
    else:
        print("  Retention: 关闭（永远保留，需手动 DELETE 清理）")
    print("  GET /                  — HTML 视图")
    print("  GET /api/jobs          — 列出 (可选 ?status=pending)")
    print("  POST /api/jobs         — 创建（subscribe_team manual 模式自动调）")
    print("  PUT /api/jobs/<id>/paid    — 标记已付")
    print("  PUT /api/jobs/<id>/cancel  — 取消")
    print("  DELETE /api/jobs/<id>      — 删除")
    print("按 Ctrl+C 停止...")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.shutdown()


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


class PaymentInboxClient:
    """opai-team subscribe_team manual 模式的客户端。"""

    def __init__(
        self,
        base_url: str,
        *,
        token: str | None = None,
        basic_auth: tuple[str, str] | None = None,
        timeout: float = 15.0,
    ):
        # 支持 ``http://user:pass@host:port`` 形式把 basic auth 塞进 URL，
        # 让本地脚本只用一条 env 变量就能完整连上远程 inbox。
        parsed = urllib.parse.urlsplit(base_url)
        url_user = urllib.parse.unquote(parsed.username) if parsed.username else ""
        url_pass = urllib.parse.unquote(parsed.password) if parsed.password else ""
        if url_user or url_pass:
            host = parsed.hostname or ""
            netloc = host + (f":{parsed.port}" if parsed.port else "")
            base_url = urllib.parse.urlunsplit(
                (parsed.scheme, netloc, parsed.path, parsed.query, parsed.fragment)
            )
        self.base_url = base_url.rstrip("/")
        self.token = (token or os.environ.get("OPAI_PAYMENT_INBOX_TOKEN") or "").strip()
        self.basic_auth = basic_auth
        if self.basic_auth is None:
            if url_user and url_pass:
                self.basic_auth = (url_user, url_pass)
            else:
                env_u = (os.environ.get("OPAI_PAYMENT_INBOX_BASIC_USER") or "").strip()
                env_p = (os.environ.get("OPAI_PAYMENT_INBOX_BASIC_PASS") or "").strip()
                if env_u and env_p:
                    self.basic_auth = (env_u, env_p)
        self.timeout = timeout

    def _req(self, method: str, path: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
        url = self.base_url + path
        body = None
        headers = {"Accept": "application/json"}
        if self.basic_auth is not None:
            cred = base64.b64encode(f"{self.basic_auth[0]}:{self.basic_auth[1]}".encode("utf-8")).decode("ascii")
            headers["Authorization"] = f"Basic {cred}"
        elif self.token:
            headers["X-Auth-Token"] = self.token
        if data is not None:
            body = json.dumps(data, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json; charset=utf-8"
        req = urllib.request.Request(url, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                txt = resp.read().decode("utf-8")
                code = resp.status
        except urllib.error.HTTPError as e:
            txt = e.read().decode("utf-8") if e.fp else ""
            code = e.code
        try:
            data_out = json.loads(txt) if txt else {}
        except Exception:
            data_out = {"raw": txt}
        if code >= 400:
            raise RuntimeError(f"{method} {url} → HTTP {code}: {txt[:200]}")
        return data_out

    def push_job(
        self,
        *,
        account_name: str,
        account_email: str,
        plan_kind: str,
        checkout_url: str,
        paypal_url: str | None = None,
        provider: str = "paypal",
        provider_url: str | None = None,
        expires_at: str | None = None,
        notes: str = "",
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "account_name": account_name,
            "account_email": account_email,
            "plan_kind": plan_kind,
            "checkout_url": checkout_url,
            "paypal_url": paypal_url or "",
            "expires_at": expires_at or "",
            "notes": notes,
        }
        # provider / provider_url 仅当显式给了或非默认时发送,保持与老 server(v1)兼容
        # —— v1 server 不识别这俩字段会忽略,只存 paypal_url。
        if provider and provider != "paypal":
            body["provider"] = provider
        if provider_url is not None:
            body["provider_url"] = provider_url or ""
        return self._req("POST", "/api/jobs", body)

    def get_job(self, job_id: str) -> dict[str, Any]:
        return self._req("GET", f"/api/jobs/{job_id}")

    def list_jobs(
        self,
        *,
        status: str = "",
        email: str = "",
        plan_kind: str = "",
        provider: str = "",
        limit: int = 200,
        include_claimed: bool = True,
        order: str = "created_desc",
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {
            "limit": max(1, min(int(limit or 200), 500)),
            "order": order or "created_desc",
        }
        if status:
            params["status"] = status
        if email:
            params["email"] = email
        if plan_kind:
            params["plan_kind"] = plan_kind
        if include_claimed:
            params["include_claimed"] = "1"
        qs = urllib.parse.urlencode(params)
        resp = self._req("GET", f"/api/jobs?{qs}")
        jobs = resp.get("jobs") or []
        if not isinstance(jobs, list):
            return []
        if provider:
            target = provider.strip().lower()
            return [j for j in jobs if str(j.get("provider") or "").strip().lower() == target]
        return [j for j in jobs if isinstance(j, dict)]

    def cancel_job(self, job_id: str) -> dict[str, Any]:
        return self._req("PUT", f"/api/jobs/{job_id}/cancel")

    def mark_paid(self, job_id: str) -> dict[str, Any]:
        return self._req("PUT", f"/api/jobs/{job_id}/paid")

    def claim_job(self, job_id: str) -> dict[str, Any]:
        return self._req("PUT", f"/api/jobs/{job_id}/claim")

    def _claim_next_one(self, *, prefer_paypal_url: bool, prefer_oldest: bool) -> dict[str, Any] | None:
        """一次原子 claim;无 pending 返 None,真错(网络/HTTP 5xx 等)log warning + 返 None。

        ``_req`` 把所有 HTTP >=400 包成 ``RuntimeError("METHOD URL → HTTP CODE: BODY")``,
        我们解析其中的 ``HTTP <code>`` 来区分 404(no_pending,无活)与真错(需要让上层知道)。
        """
        try:
            return self._req("POST", "/api/jobs/claim_next", data={
                "prefer_paypal_url": bool(prefer_paypal_url),
                "prefer_oldest": bool(prefer_oldest),
            })
        except RuntimeError as exc:
            msg = str(exc)
            if "HTTP 404" in msg:
                return None
            log.warning("payment_inbox client: claim_next HTTP error: %s", msg)
            return None
        except urllib.error.URLError as exc:
            log.warning("payment_inbox client: claim_next 网络错误: %s", exc)
            return None
        except Exception:
            log.warning("payment_inbox client: claim_next 未知错误", exc_info=True)
            return None

    def pick_next_pending(
        self,
        *,
        prefer_paypal_url: bool = True,
        prefer_oldest: bool = False,
    ) -> dict[str, Any] | None:
        """从 inbox 拿一条 pending job 并**原子 claim**(server 端单条 SQL 完成)。

        ``prefer_paypal_url=True``(默认):**优先**拿带 paypal_url 的;严格优先选不上时**再调一次**
        不限 paypal_url(fallback),保留旧 client-side fallback 语义。
        ``prefer_oldest=True`` 用 ``created_asc`` 拿最早创建的优先;默认 ``False``(``created_desc``)。
        返回 ``None`` 表示当前没活。

        实现:POST ``/api/jobs/claim_next``(server 端 ``UPDATE ... RETURNING`` 单 SQL,
        多 worker 不会双 claim 到同一条;之前 GET ``/api/jobs?status=pending`` 客户端 pick
        会有竞争窗口,已废弃)。
        网络错误 / HTTP 5xx 等会 ``log.warning`` 但不抛 — 调用方仍当成"暂时没活"轮询下一轮。
        """
        # 第一遍:按 prefer_paypal_url 严格选
        out = self._claim_next_one(
            prefer_paypal_url=prefer_paypal_url, prefer_oldest=prefer_oldest,
        )
        if out is not None:
            return out
        # 第二遍 fallback:首选时(prefer_paypal_url=True)没选到 → 放宽到不限,把
        # checkout-only job 也带回来。等价旧 client-side fallback 语义。
        if prefer_paypal_url:
            return self._claim_next_one(
                prefer_paypal_url=False, prefer_oldest=prefer_oldest,
            )
        return None

    def update_job(self, job_id: str, **fields: Any) -> dict[str, Any]:
        """局部更新 job 可变字段。

        允许字段(server 端 ``allowed`` whitelist):
          - ``paypal_url``(老 PayPal 字段) / ``provider`` / ``provider_url``(v2 通用通道)
          - ``checkout_url`` / ``notes`` / ``expires_at``
          - ``oauth_status``(v3:``''`` / ``in_progress`` / ``completed`` / ``failed``)

        例:
          - PayPal 重提取:``client.update_job(jid, paypal_url="https://...")``
          - GoPay 重提取:``client.update_job(jid, provider="gopay", provider_url="https://app.midtrans.com/...")``
          - 标 OAuth 完成:``client.update_job(jid, oauth_status="completed")``
        """
        return self._req("PUT", f"/api/jobs/{job_id}", data=fields)

    def find_active_job_by_email(self, email: str) -> dict[str, Any] | None:
        """按 ``account_email`` 找当前 active 的 job(用于 subscribe_team 重启 resume)。

        优先返回 **pending**(待付款,worker 应续 poll);
        其次返回 **paid 但 oauth_status != 'completed'** 的最新一条
        (已付款但 OAuth 没跑完,worker 应续 OAuth);
        其它(全是 cancelled/expired/已 oauth_done)返 ``None`` — caller 走全新流程。

        网络/HTTP 异常一律返 ``None``,让 caller 当成"无活"继续走全新流程,避免
        inbox 暂时不可达就阻塞订阅。
        """
        e = (email or "").strip()
        if not e:
            return None
        try:
            qs = urllib.parse.urlencode({"email": e, "limit": 50})
            r = self._req("GET", f"/api/jobs?{qs}")
        except Exception:
            log.warning("payment_inbox client: find_active_job_by_email 网络/HTTP 失败", exc_info=True)
            return None
        jobs = r.get("jobs") or []
        if not isinstance(jobs, list):
            return None
        # 先挑 pending(任意一条都行,inbox 设计上同 email 同时只有 1 个 pending — 但容错处理)
        pending = [j for j in jobs if isinstance(j, dict) and j.get("status") == "pending"]
        if pending:
            # 拿 created_at 最新的(防止旧 pending job 被新覆盖时漏选)
            pending.sort(key=lambda j: str(j.get("created_at") or ""), reverse=True)
            return pending[0]
        # 再挑 paid + oauth 未完成
        unfinished_paid = [
            j for j in jobs
            if isinstance(j, dict)
            and j.get("status") == "paid"
            and (j.get("oauth_status") or "") != "completed"
        ]
        if unfinished_paid:
            unfinished_paid.sort(key=lambda j: str(j.get("paid_at") or j.get("created_at") or ""), reverse=True)
            return unfinished_paid[0]
        return None

    def count_pending(self) -> int:
        """返回当前 ``status=pending`` 的总数。``include_claimed=1`` 让 claim 过的也算进来——
        我们要的是「inbox 真实 pending 总量」（含已被点过但未付款），不是 web 视角下的可见数。

        网络异常返回 -1，调用方应当作「未知」放行（避免因 inbox 暂时不可达就死等）。
        """
        try:
            r = self._req("GET", "/api/jobs?status=pending&limit=1&include_claimed=1")
        except Exception:
            return -1
        try:
            return int(r.get("total") or 0)
        except (TypeError, ValueError):
            return -1

    def wait_for_paid(
        self,
        job_id: str,
        *,
        timeout_sec: float,
        poll_interval_sec: float = 10.0,
        progress_callback=None,
    ) -> dict[str, Any]:
        """轮询直到 ``status`` 为 ``paid`` / ``cancelled`` / ``expired`` 或超时。

        ``progress_callback(remaining_sec, job)`` 可选，每轮调一次（用于打日志）。
        返回最终的 job dict；超时抛 ``TimeoutError``。
        """
        deadline = time.monotonic() + timeout_sec
        while True:
            job = self.get_job(job_id)
            status = (job.get("status") or "").strip().lower()
            if status in ("paid", "cancelled", "expired"):
                return job
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"payment_inbox: 等待 paid 超时 (job={job_id})")
            if progress_callback is not None:
                try:
                    progress_callback(remaining, job)
                except Exception:
                    log.debug("payment_inbox: progress_callback 异常", exc_info=True)
            sleep_for = min(poll_interval_sec, max(1.0, remaining))
            time.sleep(sleep_for)


# 模块级辅助：让 subscribe_team / 其他调用方拿到客户端
def get_default_client() -> PaymentInboxClient | None:
    """如果设置了 ``OPAI_PAYMENT_INBOX_BASE_URL``，返回客户端；否则 None。"""
    base = (os.environ.get("OPAI_PAYMENT_INBOX_BASE_URL") or "").strip()
    if not base:
        return None
    return PaymentInboxClient(base)


# ---------------------------------------------------------------------------
# Standalone entrypoint：``python3 payment_inbox.py [--host H] [--port P]``
# 让本文件 scp 到远程后能直接独立运行（不依赖 opai 包）。
# ---------------------------------------------------------------------------


if __name__ == "__main__":
    import argparse as _argparse

    _ap = _argparse.ArgumentParser(description="OPAI Payment Inbox standalone server")
    _ap.add_argument("--host", default=os.environ.get("OPAI_PAYMENT_INBOX_HOST") or "0.0.0.0")
    _ap.add_argument("--port", type=int, default=int(os.environ.get("OPAI_PAYMENT_INBOX_PORT") or "18130"))
    _ap.add_argument("--storage", default=os.environ.get("OPAI_PAYMENT_INBOX_PATH") or "")
    _args = _ap.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    _store = InboxStore(Path(_args.storage).expanduser().resolve()) if _args.storage else InboxStore()
    run_inbox_server(host=_args.host, port=_args.port, store=_store)
