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
import re
import socket
import sqlite3
import subprocess
import sys
from typing import Any, Optional

import ipaddress

from flask import Flask, Response, jsonify, redirect, request, send_from_directory

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DB_PATH = os.environ.get("DLPROMO_DB") or os.path.join(BASE_DIR, "pomodoro.db")
BACKUP_DIR = os.path.join(BASE_DIR, "backups")
KINDS = ("done", "skip", "abandon")
MAX_DAYS = 730
SCHEMA_VERSION = 6

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
            columns = {r["name"] for r in conn.execute("PRAGMA table_info(records)")}
            if "session_id" not in columns:
                conn.execute("ALTER TABLE records ADD COLUMN session_id TEXT")
            conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_records_session ON records(session_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_records_end ON records(end_at)")
            # 切出记录：逐条明细（时间 + 理由），session_meta 降级为按天汇总缓存
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS quit_logs (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    quit_at     TEXT    NOT NULL,              -- YYYY-MM-DD HH:MM:SS
                    reason      TEXT    NOT NULL DEFAULT '',
                    created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
                )
                """
            )
            quit_columns = {r["name"] for r in conn.execute("PRAGMA table_info(quit_logs)")}
            if "event_id" not in quit_columns:
                conn.execute("ALTER TABLE quit_logs ADD COLUMN event_id TEXT")
            conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_quit_event ON quit_logs(event_id)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_quit_date ON quit_logs(quit_at)")
            conn.execute("""CREATE TABLE IF NOT EXISTS task_goals (
                name TEXT PRIMARY KEY,
                target_pomos INTEGER NOT NULL CHECK(target_pomos BETWEEN 1 AND 10000)
            )""")
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS quit_deletes (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    quit_log_id INTEGER NOT NULL,
                    reason      TEXT    NOT NULL,
                    deleted_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
                    date        TEXT    NOT NULL
                )
                """
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_quit_deletes_date ON quit_deletes(date)")
        ver = conn.execute("PRAGMA user_version").fetchone()[0]
        if ver == 0:
            with conn:
                conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            log.info("初始化数据库 schema v%d", SCHEMA_VERSION)
        elif ver < SCHEMA_VERSION:
            log.info("数据库 schema v%d -> v%d，已应用幂等迁移", ver, SCHEMA_VERSION)
            with conn:
                conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
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
    if isinstance(v, bool) or not isinstance(v, (int, str)):
        return None
    try:
        return int(v)
    except (TypeError, ValueError, OverflowError):
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
    if planned is None or not 1 <= planned <= 600:
        return None, "planned_minutes 必须为 1-600 的整数"

    # actual_minutes：缺省时 done/skip 用 planned，abandon 用 0
    if "actual_minutes" in p and p.get("actual_minutes") != "":
        actual = to_int(p.get("actual_minutes"), 0)
        if actual is None or not 0 <= actual <= 600:
            return None, "actual_minutes 必须为 0-600 的整数"
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

    session_id = p.get("session_id")
    if session_id is not None and (not isinstance(session_id, str) or
                                   not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", session_id)):
        return None, "session_id 格式无效"
    return {
        "session_id": session_id,
        "kind": kind,
        "task": task,
        "planned_minutes": planned,
        "actual_minutes": actual,
        "reason": reason,
        "start_at": start_at,
        "end_at": end_at,
    }, None


@app.before_request
def validate_json_object():
    if request.path.startswith("/api/") and request.method in ("POST", "PATCH", "PUT", "DELETE"):
        if request.is_json:
            body = request.get_json(silent=True)
            if not isinstance(body, dict):
                return jsonify(ok=False, error="请求体必须为 JSON 对象"), 400


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
                   (kind, task, planned_minutes, actual_minutes, reason, start_at, end_at, session_id)
                   VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO NOTHING""",
                (data["kind"], data["task"], data["planned_minutes"],
                 data["actual_minutes"], data["reason"],
                 data["start_at"], data["end_at"], data["session_id"]),
            )
            rid = cur.lastrowid
        if data["session_id"]:
            row = conn.execute("SELECT * FROM records WHERE session_id=?", (data["session_id"],)).fetchone()
        else:
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
            if key in p:
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
    tz_off = min(max(request.args.get("tz_offset", default=0, type=int), -1440), 1440)
    days = request.args.get("days", default=365, type=int)
    days = min(max(days, 7), MAX_DAYS)

    # 客户端本地当前时间
    now = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=tz_off)
    today = now.date()

    since = today - datetime.timedelta(days=days - 1)
    since_s = since.strftime("%Y-%m-%d") + " 00:00:00"
    until_s = (today + datetime.timedelta(days=1)).strftime("%Y-%m-%d") + " 00:00:00"

    conn = get_db()
    try:
        # 窗口内记录
        rows = conn.execute(
            """SELECT kind, planned_minutes, actual_minutes, end_at
               FROM records WHERE end_at >= ? AND end_at < ? ORDER BY end_at ASC""",
            (since_s, until_s),
        ).fetchall()

        daily = {}
        total_minutes = 0
        actual_minutes = 0
        counts = {"done": 0, "skip": 0, "abandon": 0}
        for r in rows:
            date = r["end_at"][:10]
            d = daily.setdefault(date, {"date": date, "minutes": 0,
                                         "count": 0, "abandons": 0, "actual_minutes": 0})
            d["count"] += 1
            d["actual_minutes"] += r["actual_minutes"]
            actual_minutes += r["actual_minutes"]
            if r["kind"] == "abandon":
                d["abandons"] += 1
            else:
                m = r["planned_minutes"] or r["actual_minutes"]
                d["minutes"] += m
                total_minutes += m
            counts[r["kind"]] += 1

        # 独立于热力图窗口，统计截至客户端今日的全部有效专注日期。
        history = {r["date"]: r["minutes"] for r in conn.execute(
            """SELECT substr(end_at,1,10) AS date, SUM(planned_minutes) AS minutes
               FROM records WHERE kind IN ('done','skip') AND end_at < ?
               GROUP BY substr(end_at,1,10) ORDER BY date""", (until_s,)
        )}
        alltime_minutes = sum(history.values())
        monday = today - datetime.timedelta(days=today.weekday())
        today_s = today.strftime("%Y-%m-%d")
        monday_s = monday.strftime("%Y-%m-%d")
        week_minutes = sum(v for k, v in history.items() if k >= monday_s)
        today_minutes = history.get(today_s, 0)

        actual_history = {r["date"]: r["minutes"] for r in conn.execute(
            """SELECT substr(end_at,1,10) AS date, SUM(actual_minutes) AS minutes
               FROM records WHERE end_at < ? GROUP BY substr(end_at,1,10)""", (until_s,)
        )}
        current_streak = 0
        d = today if history.get(today_s, 0) > 0 else today - datetime.timedelta(days=1)
        while history.get(d.isoformat(), 0) > 0:
            current_streak += 1
            d -= datetime.timedelta(days=1)
        longest_streak = run = 0
        previous = None
        for date, minutes in history.items():
            if minutes <= 0:
                continue
            d = datetime.date.fromisoformat(date)
            run = run + 1 if previous is not None and (d - previous).days == 1 else 1
            longest_streak = max(longest_streak, run)
            previous = d

        cut30 = (today - datetime.timedelta(days=29)).isoformat()
        avg30 = round(sum(v for k, v in history.items() if k >= cut30) / 30, 1)

        daily_list = []
        for i in range(days):
            ds = (since + datetime.timedelta(days=i)).strftime("%Y-%m-%d")
            daily_list.append(daily.get(ds, {"date": ds, "minutes": 0,
                                             "count": 0, "abandons": 0, "actual_minutes": 0}))

        return jsonify(ok=True, data={
            "actual_minutes": actual_minutes,
            "today_actual_minutes": actual_history.get(today_s, 0),
            "week_actual_minutes": sum(v for k, v in actual_history.items() if k >= monday_s),
            "alltime_actual_minutes": sum(actual_history.values()),
            "avg30_actual": round(sum(v for k, v in actual_history.items() if k >= cut30) / 30, 1),
            "today_minutes": today_minutes,
            "week_minutes": week_minutes,
            "total_minutes": total_minutes,
            "alltime_minutes": alltime_minutes,
            "counts": counts,
            "streak": longest_streak,
            "longest_streak": longest_streak,
            "current_streak": current_streak,
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


# ---------------------------------------------------------------- quit logs
@app.post("/api/quit")
def record_quit():
    """
    记录一次“切出”事件（手机切后台 / 锁屏 / 离开页面）。
    写入逐条 quit_logs。
    body: { "quit_at": "YYYY-MM-DD HH:MM:SS", "reason": "..." }  可选
    缺省 quit_at 为服务器当前时间。
    """
    quit_at = ""
    reason = ""
    event_id = None
    if request.is_json:
        body = request.get_json() or {}
        event_id = body.get("event_id")
        if event_id is not None and (not isinstance(event_id, str) or
                                    not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", event_id)):
            return jsonify(ok=False, error="event_id 格式无效"), 400
        quit_at = str(body.get("quit_at") or "").strip()
        reason = str(body.get("reason") or "").strip()[:500]
    if not quit_at:
        quit_at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    if parse_dt(quit_at) is None:
        return jsonify(ok=False, error="quit_at 必须为 YYYY-MM-DD HH:MM:SS"), 400

    conn = get_db()
    try:
        with conn:
            cur = conn.execute(
                """INSERT INTO quit_logs (quit_at, reason, event_id) VALUES (?, ?, ?)
                   ON CONFLICT(event_id) DO UPDATE SET
                   reason = CASE WHEN excluded.reason != '' THEN excluded.reason ELSE quit_logs.reason END""",
                (quit_at, reason, event_id),
            )
            rid = cur.lastrowid
        if event_id:
            row = conn.execute("SELECT * FROM quit_logs WHERE event_id = ?", (event_id,)).fetchone()
        else:
            row = conn.execute("SELECT * FROM quit_logs WHERE id = ?", (rid,)).fetchone()
    finally:
        conn.close()
    return jsonify(ok=True, data=dict(row))


@app.get("/api/quit_logs")
def list_quit_logs():
    """查询切出记录，倒序。?limit=&offset= 分页；?date=YYYY-MM-DD 按天过滤。"""
    limit = min(max(request.args.get("limit", default=50, type=int), 1), 500)
    offset = max(request.args.get("offset", default=0, type=int), 0)
    date = str(request.args.get("date") or "").strip()
    where = ""
    params = []
    if date:
        where = "WHERE quit_at LIKE ?"
        params.append(date + "%")
    conn = get_db()
    try:
        total = conn.execute(
            f"SELECT COUNT(*) AS c FROM quit_logs {where}", params
        ).fetchone()["c"]
        rows = [dict(r) for r in conn.execute(
            f"""SELECT id, quit_at, reason, created_at FROM quit_logs
                {where} ORDER BY quit_at DESC, id DESC LIMIT ? OFFSET ?""",
            params + [limit, offset],
        ).fetchall()]
    finally:
        conn.close()
    return jsonify(ok=True, data=rows, total=total)


@app.patch("/api/quit_logs/<int:rid>")
def edit_quit_log(rid):
    """编辑一条切出记录：时间 / 理由。"""
    body = request.get_json() or {}
    quit_at = str(body.get("quit_at") or "").strip()
    reason = str(body.get("reason") or "").strip()[:500]
    if quit_at and parse_dt(quit_at) is None:
        return jsonify(ok=False, error="quit_at 必须为 YYYY-MM-DD HH:MM:SS"), 400

    fields, params = [], []
    if quit_at:
        fields.append("quit_at = ?")
        params.append(quit_at)
    if "reason" in body:
        fields.append("reason = ?")
        params.append(reason)
    if not fields:
        return jsonify(ok=False, error="没有可更新的字段"), 400

    conn = get_db()
    try:
        with conn:
            conn.execute(
                f"UPDATE quit_logs SET {', '.join(fields)} WHERE id = ?",
                params + [rid],
            )
        row = conn.execute(
            "SELECT COUNT(*) AS c FROM quit_logs WHERE id = ?", (rid,)
        ).fetchone()
        if row["c"] == 0:
            return jsonify(ok=False, error="记录不存在"), 404
        updated = conn.execute(
            "SELECT id, quit_at, reason, created_at FROM quit_logs WHERE id = ?", (rid,)
        ).fetchone()
    finally:
        conn.close()
    return jsonify(ok=True, data=dict(updated))


@app.delete("/api/quit_logs/<int:rid>")
def delete_quit_log(rid):
    """删除一条切出记录，需填写删除理由，每日限3次。"""
    body = request.get_json() or {}
    reason = str(body.get("reason") or "").strip()
    if not reason:
        return jsonify(ok=False, error="请填写删除理由"), 400
    if len(reason) > 500:
        reason = reason[:500]

    today = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
    conn = get_db()
    try:
        cnt = conn.execute(
            "SELECT COUNT(*) AS c FROM quit_deletes WHERE date = ?", (today,)
        ).fetchone()["c"]
        if cnt >= 3:
            return jsonify(ok=False, error="今日删除次数已达上限（3次）"), 429

        row = conn.execute(
            "SELECT id FROM quit_logs WHERE id = ?", (rid,)
        ).fetchone()
        if not row:
            return jsonify(ok=False, error="记录不存在"), 404

        with conn:
            conn.execute(
                "INSERT INTO quit_deletes (quit_log_id, reason, date) VALUES (?, ?, ?)",
                (rid, reason, today)
            )
            conn.execute("DELETE FROM quit_logs WHERE id = ?", (rid,))
    finally:
        conn.close()
    return jsonify(ok=True)


@app.get("/api/session_meta")
def get_session_meta():
    """按天汇总切出次数（从 quit_logs 聚合）。?days=30 返回近 N 天。"""
    days = request.args.get("days", default=1, type=int)
    days = min(max(days, 1), 730)
    tz_off = min(max(request.args.get("tz_offset", default=0, type=int), -1440), 1440)
    now = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=tz_off)
    today = now.date()
    since = today - datetime.timedelta(days=days - 1)
    since_s = since.strftime("%Y-%m-%d") + " 00:00:00"
    until_s = (today + datetime.timedelta(days=1)).strftime("%Y-%m-%d") + " 00:00:00"

    conn = get_db()
    try:
        rows = {r["d"]: r["c"] for r in conn.execute(
            """SELECT substr(quit_at,1,10) AS d, COUNT(*) AS c
               FROM quit_logs WHERE quit_at >= ? AND quit_at < ? GROUP BY d""",
            (since_s, until_s),
        ).fetchall()}
    finally:
        conn.close()

    items = []
    for i in range(days):
        ds = (since + datetime.timedelta(days=i)).strftime("%Y-%m-%d")
        items.append({"date": ds, "quit_count": rows.get(ds, 0)})
    return jsonify(ok=True, data={"days": days, "items": items})


# ---------------------------------------------------------------- insights / task map
def client_date_window(default_days=30):
    days = min(max(request.args.get("days", default=default_days, type=int), 1), MAX_DAYS)
    offset = min(max(request.args.get("tz_offset", default=0, type=int), -1440), 1440)
    today = (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=offset)).date()
    since = today - datetime.timedelta(days=days - 1)
    until = today + datetime.timedelta(days=1)
    return days, since.isoformat() + " 00:00:00", until.isoformat() + " 00:00:00"


@app.get("/api/insights")
def interruption_insights():
    days, since, until = client_date_window()
    conn = get_db()
    try:
        rows = conn.execute("SELECT quit_at, reason FROM quit_logs WHERE quit_at >= ? AND quit_at < ?",
                            (since, until)).fetchall()
        reasons = {}
        hours = [0] * 24
        daily = {}
        unlabelled = 0
        for row in rows:
            reason = row["reason"].strip()
            if not reason:
                unlabelled += 1
            else:
                reasons[reason] = reasons.get(reason, 0) + 1
            hours[int(row["quit_at"][11:13])] += 1
            date = row["quit_at"][:10]
            daily[date] = daily.get(date, 0) + 1
        top = sorted(reasons.items(), key=lambda item: (-item[1], item[0]))[:5]
        total = len(rows)
        peak = max(range(24), key=lambda hour: hours[hour]) if total else None
        return jsonify(ok=True, data={
            "days": days, "total": total, "unlabelled": unlabelled,
            "reasons": [{"reason": reason, "count": count} for reason, count in top],
            "hours": [{"hour": h, "count": hours[h]} for h in range(24)],
            "peak_hour": peak, "active_days": len(daily),
            "average_per_day": round(total / days, 1),
        })
    finally:
        conn.close()


@app.get("/api/tasks")
def list_tasks():
    _, _, until = client_date_window()
    conn = get_db()
    try:
        # 无目标的历史任务也展示；修改 / 删除记录后进度即时重新聚合。
        rows = conn.execute("""WITH totals AS (
            SELECT task AS name,
                   SUM(CASE WHEN kind IN ('done','skip') THEN 1 ELSE 0 END) AS completed_pomos,
                   SUM(CASE WHEN kind IN ('done','skip') THEN planned_minutes ELSE 0 END) AS credited_minutes,
                   SUM(actual_minutes) AS actual_minutes,
                   SUM(CASE WHEN kind='abandon' THEN 1 ELSE 0 END) AS abandons
            FROM records WHERE task != '' AND end_at < ? GROUP BY task
        ), names AS (SELECT name FROM task_goals UNION SELECT name FROM totals)
        SELECT names.name, goals.target_pomos,
               COALESCE(t.completed_pomos,0) AS completed_pomos,
               COALESCE(t.credited_minutes,0) AS credited_minutes,
               COALESCE(t.actual_minutes,0) AS actual_minutes,
               COALESCE(t.abandons,0) AS abandons
        FROM names LEFT JOIN task_goals goals ON goals.name=names.name
                   LEFT JOIN totals t ON t.name=names.name
        ORDER BY goals.target_pomos IS NULL, names.name""", (until,)).fetchall()
        return jsonify(ok=True, data=[dict(row) for row in rows])
    finally:
        conn.close()


@app.put("/api/tasks")
def set_task_goal():
    body = request.get_json(silent=True) or {}
    name = body.get("name")
    target = to_int(body.get("target_pomos"))
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 200:
        return jsonify(ok=False, error="任务名称必须为 1-200 个字符"), 400
    if target is None or not 1 <= target <= 10000:
        return jsonify(ok=False, error="预计番茄数必须为 1-10000 的整数"), 400
    conn = get_db()
    try:
        with conn:
            conn.execute("""INSERT INTO task_goals(name,target_pomos) VALUES (?,?)
                ON CONFLICT(name) DO UPDATE SET target_pomos=excluded.target_pomos""", (name.strip(), target))
    finally:
        conn.close()
    return jsonify(ok=True)


@app.delete("/api/tasks")
def remove_task_goal():
    body = request.get_json(silent=True) or {}
    name = body.get("name")
    if not isinstance(name, str) or not name.strip():
        return jsonify(ok=False, error="请提供任务名称"), 400
    conn = get_db()
    try:
        with conn:
            conn.execute("DELETE FROM task_goals WHERE name=?", (name.strip(),))
    finally:
        conn.close()
    return jsonify(ok=True)


@app.get("/sw.js")
def service_worker():
    response = send_from_directory(STATIC_DIR, "sw.js")
    response.headers["Cache-Control"] = "no-cache"
    return response


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


# ---------------------------------------------------------------- TLS / HTTPS
# 网页通知（Notification）与媒体接口（Media Session）要求页面处于“安全上下文”：
# 必须通过 HTTPS（或 localhost/127.0.0.1）访问，浏览器才会弹出通知权限框。
# 本模块提供自签名证书生成与 HTTPS 启动，默认保持纯 HTTP，避免影响现有访问。
CERT_DIR = os.path.join(BASE_DIR, "certs")
CERT_PEM = os.path.join(CERT_DIR, "cert.pem")
CERT_KEY = os.path.join(CERT_DIR, "key.pem")
SUBNET_RE = re.compile(r"^[0-9a-fA-F:./]+$")


def _valid_ip(s: str) -> bool:
    try:
        ipaddress.ip_address(s)
        return True
    except ValueError:
        return False


def _list_ips() -> set:
    """收集本机可能被用于访问的地址：回环 + 各网卡 IPv4/IPv6。"""
    ips = {"127.0.0.1", "::1"}
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.add(s.getsockname()[0])
        s.close()
    except Exception:
        pass
    try:
        out = subprocess.check_output(["hostname", "-I"], text=True)
        for tok in out.replace("\n", " ").split():
            if tok.strip():
                ips.add(tok.strip())
    except Exception:
        pass
    return {ip for ip in ips if _valid_ip(ip)}


def _lan_ip() -> str:
    """用于提示局域网访问的地址：优先默认路由出口 IP，再回环。"""
    try:
        out = subprocess.check_output(["ip", "-4", "route", "get", "1.1.1.1"], text=True)
        m = re.search(r"\bsrc ([\d.]+)", out)
        if m and _valid_ip(m.group(1)):
            return m.group(1)
    except Exception:
        pass
    return "127.0.0.1"


def _san_string(extra_ips=()) -> str:
    """构建证书 subjectAltName：覆盖 localhost 与所有本机网卡 IP。"""
    names = {"DNS:localhost", "DNS:dlpromo.local"}
    for ip in _list_ips():
        if ":" in ip:
            names.add(f"IP:{ip}")
        else:
            names.add(f"IP:{ip}")
    for ip in extra_ips or ():
        if _valid_ip(str(ip)):
            names.add(f"IP:{ip}")
    return ",".join(sorted(names))


def ensure_self_signed_cert(extra_ips=()) -> str:
    """确保存在自签名证书，必要时调用 openssl 生成，返回 cert.pem 路径。"""
    if os.path.exists(CERT_PEM) and os.path.exists(CERT_KEY):
        return CERT_PEM
    os.makedirs(CERT_DIR, exist_ok=True)
    san = _san_string(extra_ips)
    cmd = [
        "openssl", "req", "-x509", "-newkey", "rsa:2048",
        "-sha256", "-days", "3650", "-nodes",
        "-keyout", CERT_KEY, "-out", CERT_PEM,
        "-subj", "/C=CN/O=DLPromo/CN=dlpromo",
        "-addext", f"subjectAltName={san}",
        "-addext", "basicConstraints=CA:TRUE",
        "-addext", "keyUsage=digitalSignature,keyEncipherment,keyCertSign",
        "-addext", "extendedKeyUsage=serverAuth",
    ]
    log.info("正在生成自签名 HTTPS 证书……")
    log.info("  证书: %s", CERT_PEM)
    log.info("  SAN:  %s", san.replace(",", ", "))
    subprocess.run(cmd, check=True, capture_output=True, text=True)
    return CERT_PEM


# ---------------------------------------------------------------- HTTP→HTTPS 跳转
def _strip_host_port(host: str) -> str:
    """去掉 Host 头里的端口，保留主机名/IP。"""
    if host.startswith("["):
        idx = host.find("]")
        return host[1:idx] if idx > 0 else host
    return host.rsplit(":", 1)[0] if ":" in host else host


def _build_http_redirect(https_port: int) -> object:
    """构造一个小应用：把 HTTP 请求 301 重定向到 HTTPS，保留原路径与主机名。"""
    app = Flask("dlpromo_http_redirect", static_folder=None)

    @app.route("/", defaults={"path": ""})
    @app.route("/<path:path>")
    def _redirect(path):
        host = _strip_host_port(str(request.host))
        suffix = f":{https_port}" if https_port not in (443, None) else ""
        return redirect(f"https://{host}{suffix}/" + path, code=301)

    return app


# ---------------------------------------------------------------- main
if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "backup":
        do_backup()
        sys.exit(0)

    port = int(os.environ.get("PORT", "8000"))

    ssl_ctx = None
    scheme = "http"
    want_ssl = (os.environ.get("DLPROMO_SSL") == "1") or ("--ssl" in args)
    if want_ssl:
        cert = os.environ.get("DLPROMO_CERT") or CERT_PEM
        key = os.environ.get("DLPROMO_KEY") or CERT_KEY
        if not (os.path.exists(cert) and os.path.exists(key)):
            ensure_self_signed_cert()
            cert, key = CERT_PEM, CERT_KEY
        ssl_ctx = (cert, key)
        scheme = "https"

    log.info("DLPromo · ТОМАТО-ЧАСЫ 后端启动")
    log.info("访问地址: %s://127.0.0.1:%d", scheme, port)
    log.info("数据文件: %s", DB_PATH)
    log.info("静态目录: %s", STATIC_DIR)
    if scheme == "https":
        lan = _lan_ip()
        log.info("局域网访问: %s://%s:%d （首次请在浏览器「高级 → 继续访问/继续前往」确认信任后，再勾选系统通知即可弹窗）", scheme, lan, port)
        http_port = int(os.environ.get("DLPROMO_HTTP_PORT") or 0)
        if http_port and http_port != port:
            from werkzeug.serving import run_simple
            import threading
            redir = _build_http_redirect(port)
            t = threading.Thread(
                target=run_simple,
                args=("0.0.0.0", http_port, redir),
                kwargs={"use_reloader": False},
                daemon=True,
            )
            t.start()
            log.info("HTTP 跳转: http://%s:%d → %s://%s:%d （老地址仍可访问）", lan, http_port, scheme, lan, port)
    app.run(host="0.0.0.0", port=port, debug=False, ssl_context=ssl_ctx)
