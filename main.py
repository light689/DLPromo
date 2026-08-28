#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DLPromo · ТОМАТО-ЧАСЫ — 后端服务
Flask + SQLite：记录保存 / 编辑 / 统计 / 热力图 / 导出 / 备份

记录类型 (kind)：
  done    — 完成（自然计时结束），按原计划时长计入总专注时间
  skip    — 跳过（提前结束但按原本专注时间记录），计入总专注时间
  abandon — 放弃（记录放弃原因与实际专注时长），不计入总专注时间

运行：python main.py → http://127.0.0.1:8000
备份：python main.py backup
环境变量：DLPROMO_DB（数据库路径，默认 ./pomodoro.db）、PORT
"""

import csv
import datetime
import io
import json
import logging
import os
import sqlite3
import sys
from typing import Any, Optional

from flask import Flask, Response, jsonify, request, send_from_directory

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DB_PATH = os.environ.get("DLPROMO_DB") or os.path.join(BASE_DIR, "pomodoro.db")
BACKUP_DIR = os.path.join(BASE_DIR, "backups")
KINDS = ("done", "skip", "abandon")
MAX_DAYS = 730
SCHEMA_VERSION = 1

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s"
)
log = logging.getLogger("dlpromo")

app = Flask(__name__, static_folder=STATIC_DIR, static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 1 * 1024 * 1024  # 1MB


# ---------------------------------------------------------------- database
def get_db() -> sqlite3.Connection:
    """返回 SQLite 连接，启用 WAL 和 Row 工厂。"""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db() -> None:
    """初始化数据库表、索引和 schema 版本。"""
    conn = get_db()
    try:
        with conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS records (
                    id              INTEGER PRIMARY KEY AUTOINCREMENT,
                    kind            TEXT    NOT NULL CHECK (kind IN ('done','skip','abandon')),
                    task            TEXT    NOT NULL DEFAULT '',
                    planned_minutes INTEGER NOT NULL DEFAULT 0,
                    actual_minutes  INTEGER NOT NULL DEFAULT 0,
                    reason          TEXT    NOT NULL DEFAULT '',
                    start_at        TEXT    NOT NULL,
                    end_at          TEXT    NOT NULL,
                    created_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_records_end ON records(end_at)")
        ver = conn.execute("PRAGMA user_version").fetchone()[0]
        if ver == 0:
            with conn:
                conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            log.info("初始化数据库 schema v%d", SCHEMA_VERSION)
        elif ver < SCHEMA_VERSION:
            log.warning("数据库 schema v%d < 当前 v%d，尚无迁移，请备份后手动处理", ver, SCHEMA_VERSION)
        else:
            log.info("数据库 schema v%d", ver)
    finally:
        conn.close()


init_db()


# ---------------------------------------------------------------- utils
def to_int(v: Any, default: Optional[int] = None) -> Optional[int]:
    """安全转整数，返回 None 表示无效。"""
    if v is None or v == "":
        return default
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def parse_dt(s: str) -> Optional[datetime.datetime]:
    """解析时间字符串 YYYY-MM-DD HH:MM:SS。"""
    try:
        return datetime.datetime.strptime(str(s).strip(), "%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError):
        return None


def validate_payload(p: dict) -> tuple[Optional[dict], Optional[str]]:
    """
    校验并规整一条完整记录。
    返回 (data, error)，error 非空表示校验失败。
    """
    kind = p.get("kind")
    if kind not in KINDS:
        return None, "kind 必须是 done / skip / abandon"

    planned = to_int(p.get("planned_minutes"))
    if planned is None or planned <= 0:
        return None, "planned_minutes 必须大于 0"

    # actual_minutes：缺省时 done/skip 用 planned，abandon 用 0
    if "actual_minutes" in p and p.get("actual_minutes") != "":
        actual = to_int(p.get("actual_minutes"), 0)
        if actual is None:
            return None, "actual_minutes 必须是整数"
        actual = max(0, actual)
    else:
        actual = planned if kind != "abandon" else 0

    task = str(p.get("task") or "").strip()[:200]
    reason = str(p.get("reason") or "").strip()[:500]

    start_at = str(p.get("start_at") or "").strip()
    end_at = str(p.get("end_at") or "").strip()
    start_dt = parse_dt(start_at)
    end_dt = parse_dt(end_at)
    if start_dt is None or end_dt is None:
        return None, "start_at / end_at 必须为 YYYY-MM-DD HH:MM:SS 格式"
    if end_dt < start_dt:
        return None, "end_at 不能早于 start_at"
    if kind == "abandon" and not reason:
        return None, "放弃记录必须填写原因"

    return {
        "kind": kind,
        "task": task,
        "planned_minutes": planned,
        "actual_minutes": actual,
        "reason": reason,
        "start_at": start_at,
        "end_at": end_at,
    }, None


# ---------------------------------------------------------------- routes
@app.get("/")
def index():
    return send_from_directory(BASE_DIR, "index.html")


@app.get("/api/health")
def health():
    return jsonify(ok=True, db=os.path.exists(DB_PATH))


@app.get("/api/records")
def list_records():
    """分页查询记录，支持 kind / from / to / limit / offset。"""
    conn = get_db()
    try:
        where, args = [], []
        kind = request.args.get("kind")
        if kind in KINDS:
            where.append("kind = ?")
            args.append(kind)
        frm = request.args.get("from")
        to = request.args.get("to")
        if frm:
            where.append("end_at >= ?")
            args.append(frm)
        if to:
            where.append("end_at <= ?")
            args.append(to)

        where_clause = " WHERE " + " AND ".join(where) if where else ""

        # total count
        count_row = conn.execute(
            f"SELECT COUNT(*) AS total FROM records{where_clause}", args
        ).fetchone()
        total = count_row["total"]

        # pagination
        limit = request.args.get("limit", default=100, type=int)
        limit = min(max(limit, 1), 1000)
        offset = request.args.get("offset", default=0, type=int)
        offset = max(offset, 0)

        sql = f"SELECT * FROM records{where_clause} ORDER BY end_at DESC, id DESC LIMIT ? OFFSET ?"
        rows = conn.execute(sql, args + [limit, offset]).fetchall()

        return jsonify(ok=True, total=total, data=[dict(r) for r in rows])
    finally:
        conn.close()


@app.post("/api/records")
def create_record():
    p = request.get_json(silent=True) or {}
    data, err = validate_payload(p)
    if err:
        return jsonify(ok=False, error=err), 400

    conn = get_db()
    try:
        with conn:
            cur = conn.execute(
                """INSERT INTO records
                   (kind, task, planned_minutes, actual_minutes, reason, start_at, end_at)
                   VALUES (?,?,?,?,?,?,?)""",
                (data["kind"], data["task"], data["planned_minutes"],
                 data["actual_minutes"], data["reason"],
                 data["start_at"], data["end_at"]),
            )
            rid = cur.lastrowid
        row = conn.execute("SELECT * FROM records WHERE id=?", (rid,)).fetchone()
        return jsonify(ok=True, data=dict(row))
    finally:
        conn.close()


@app.patch("/api/records/<int:rid>")
def update_record(rid):
    """部分更新：只传需要改的字段，其余保持原值。"""
    conn = get_db()
    try:
        existing = conn.execute("SELECT * FROM records WHERE id=?", (rid,)).fetchone()
        if not existing:
            return jsonify(ok=False, error="记录不存在"), 404
        existing = dict(existing)

        p = request.get_json(silent=True) or {}
        # 合并：只覆盖请求中出现的字段
        merged = existing.copy()
        for key in ("kind", "task", "planned_minutes", "actual_minutes", "reason", "start_at", "end_at"):
            if key in p and p.get(key) != "":
                merged[key] = p[key]

        # 重新校验完整数据
        data, err = validate_payload(merged)
        if err:
            return jsonify(ok=False, error=err), 400

        with conn:
            cur = conn.execute(
                """UPDATE records SET kind=?, task=?, planned_minutes=?,
                   actual_minutes=?, reason=?, start_at=?, end_at=?
                   WHERE id=?""",
                (data["kind"], data["task"], data["planned_minutes"],
                 data["actual_minutes"], data["reason"],
                 data["start_at"], data["end_at"], rid),
            )
            if cur.rowcount == 0:
                return jsonify(ok=False, error="记录不存在"), 404
        row = conn.execute("SELECT * FROM records WHERE id=?", (rid,)).fetchone()
        return jsonify(ok=True, data=dict(row))
    finally:
        conn.close()


@app.delete("/api/records/<int:rid>")
def delete_record(rid):
    conn = get_db()
    try:
        with conn:
            cur = conn.execute("DELETE FROM records WHERE id=?", (rid,))
            if cur.rowcount == 0:
                return jsonify(ok=False, error="记录不存在"), 404
        return jsonify(ok=True)
    finally:
        conn.close()


@app.get("/api/stats")
def stats():
    """
    统计聚合。
    tz_offset: 客户端时区偏移（分钟），用于计算今日/本周边界。
    days: 热力图窗口天数（7-730）。
    """
    tz_off = request.args.get("tz_offset", default=0, type=int)
    days = request.args.get("days", default=365, type=int)
    days = min(max(days, 7), MAX_DAYS)

    # 客户端本地当前时间
    now = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=tz_off)
    today = now.date()

    since = today - datetime.timedelta(days=days - 1)
    since_s = since.strftime("%Y-%m-%d") + " 00:00:00"

    conn = get_db()
    try:
        # 窗口内记录
        rows = conn.execute(
            """SELECT kind, planned_minutes, actual_minutes, end_at
               FROM records WHERE end_at >= ? ORDER BY end_at ASC""",
            (since_s,),
        ).fetchall()

        daily = {}
        total_minutes = 0
        counts = {"done": 0, "skip": 0, "abandon": 0}
        for r in rows:
            date = r["end_at"][:10]
            d = daily.setdefault(date, {"date": date, "minutes": 0,
                                         "count": 0, "abandons": 0})
            d["count"] += 1
            if r["kind"] == "abandon":
                d["abandons"] += 1
            else:
                m = r["planned_minutes"] or r["actual_minutes"]
                d["minutes"] += m
                total_minutes += m
            counts[r["kind"]] += 1

        # 生命周期总专注时长（不计放弃）
        alltime_row = conn.execute(
            "SELECT COALESCE(SUM(planned_minutes),0) AS m FROM records WHERE kind IN ('done','skip')"
        ).fetchone()
        alltime_minutes = alltime_row["m"]

        monday = today - datetime.timedelta(days=today.weekday())
        today_s = today.strftime("%Y-%m-%d")
        monday_s = monday.strftime("%Y-%m-%d")
        week_minutes = sum(v["minutes"] for k, v in daily.items() if k >= monday_s)
        today_minutes = daily.get(today_s, {}).get("minutes", 0)

        # 最长连续专注天数（今天没专注则从昨天往前）
        streak = 0
        d = today
        if daily.get(d.strftime("%Y-%m-%d"), {}).get("minutes", 0) == 0:
            d = today - datetime.timedelta(days=1)
        while daily.get(d.strftime("%Y-%m-%d"), {}).get("minutes", 0) > 0:
            streak += 1
            d -= datetime.timedelta(days=1)

        # 近 30 天日均
        cut30 = (today - datetime.timedelta(days=29)).strftime("%Y-%m-%d")
        last30 = sum(v["minutes"] for k, v in daily.items() if k >= cut30)
        avg30 = round(last30 / 30, 1)

        daily_list = []
        for i in range(days):
            ds = (since + datetime.timedelta(days=i)).strftime("%Y-%m-%d")
            daily_list.append(daily.get(ds, {"date": ds, "minutes": 0,
                                             "count": 0, "abandons": 0}))

        return jsonify(ok=True, data={
            "today_minutes": today_minutes,
            "week_minutes": week_minutes,
            "total_minutes": total_minutes,
            "alltime_minutes": alltime_minutes,
            "counts": counts,
            "streak": streak,
            "avg30": avg30,
            "days": days,
            "daily": daily_list,
        })
    finally:
        conn.close()


@app.get("/api/export")
def export():
    """导出全部记录：?format=json 或 ?format=csv"""
    fmt = request.args.get("format", "json")
    conn = get_db()
    try:
        rows = [dict(r) for r in conn.execute(
            "SELECT * FROM records ORDER BY end_at DESC").fetchall()]
    finally:
        conn.close()

    if fmt == "csv":
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["id", "kind", "task", "planned_minutes",
                         "actual_minutes", "reason", "start_at",
                         "end_at", "created_at"])
        for r in rows:
            writer.writerow([r["id"], r["kind"], r["task"],
                             r["planned_minutes"], r["actual_minutes"],
                             r["reason"], r["start_at"], r["end_at"],
                             r["created_at"]])
        data = "\ufeff" + buf.getvalue()
        return Response(data, mimetype="text/csv; charset=utf-8",
                        headers={"Content-Disposition":
                                 "attachment; filename=pomodoro_records.csv"})

    return Response(json.dumps(rows, ensure_ascii=False, indent=2),
                    mimetype="application/json; charset=utf-8",
                    headers={"Content-Disposition":
                             "attachment; filename=pomodoro_records.json"})


# ---------------------------------------------------------------- backup
def do_backup() -> None:
    """备份数据库到 backups/ 目录。"""
    try:
        src = sqlite3.connect(DB_PATH)
    except sqlite3.OperationalError as e:
        log.error("无法打开数据库: %s", e)
        return
    os.makedirs(BACKUP_DIR, exist_ok=True)
    src.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    dest_path = os.path.join(BACKUP_DIR, f"pomodoro-{ts}.db")
    with sqlite3.connect(dest_path) as tgt:
        src.backup(tgt)
    src.close()
    log.info("备份完成 → %s", dest_path)


# ---------------------------------------------------------------- error handlers
@app.errorhandler(404)
def not_found(e):
    if request.path.startswith("/api/"):
        return jsonify(ok=False, error="接口不存在"), 404
    return e


@app.errorhandler(413)
def too_large(e):
    return jsonify(ok=False, error="请求体过大"), 413


# ---------------------------------------------------------------- security headers
@app.after_request
def security_headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    resp.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data:; "
        "style-src 'self' 'unsafe-inline'; "
        "script-src 'self'; font-src 'self'; "
        "base-uri 'none'; frame-ancestors 'none'"
    )
    return resp


# ---------------------------------------------------------------- main
if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "backup":
        do_backup()
        sys.exit(0)

    port = int(os.environ.get("PORT", "8000"))
    log.info("DLPromo · ТОМАТО-ЧАСЫ 后端启动")
    log.info("访问地址: http://127.0.0.1:%d", port)
    log.info("数据文件: %s", DB_PATH)
    log.info("静态目录: %s", STATIC_DIR)
    app.run(host="0.0.0.0", port=port, debug=False)
