#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DLPromo · ТОМАТО-ЧАСЫ — 后端服务
Flask + SQLite：记录保存 / 编辑 / 统计 / 热力图数据 / 导出

记录类型 (kind)：
  done    — 完成（自然计时结束），按原计划时长计入总专注时间
  skip    — 跳过（提前结束但按原本专注时间记录），计入总专注时间
  abandon — 放弃（记录放弃原因与实际专注时长），不计入总专注时间

运行：python main.py  →  http://127.0.0.1:8000
"""

import csv
import io
import json
import os
import sqlite3
import datetime

from flask import Flask, request, jsonify, send_from_directory, Response

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "pomodoro.db")
KINDS = ("done", "skip", "abandon")

app = Flask(__name__, static_folder=None)


# ---------------------------------------------------------------- database
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
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
    finally:
        conn.close()


init_db()


# ---------------------------------------------------------------- validation
def parse_minutes(v, default=0):
    try:
        n = int(v)
    except (TypeError, ValueError):
        return default
    return max(0, n)


def validate_payload(p):
    """校验并规整一条记录，返回 (data, error)。"""
    kind = p.get("kind")
    if kind not in KINDS:
        return None, "kind 必须是 done / skip / abandon"

    planned = parse_minutes(p.get("planned_minutes"))
    if planned <= 0:
        return None, "planned_minutes 必须大于 0"

    actual = parse_minutes(p.get("actual_minutes"), planned) or planned
    task = str(p.get("task") or "").strip()[:200]
    reason = str(p.get("reason") or "").strip()[:500]
    start_at = str(p.get("start_at") or "").strip()
    end_at = str(p.get("end_at") or "").strip()
    if not start_at or not end_at:
        return None, "start_at / end_at 不能为空"
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

        sql = "SELECT * FROM records"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY end_at DESC, id DESC LIMIT 5000"
        rows = conn.execute(sql, args).fetchall()
        return jsonify(ok=True, data=[dict(r) for r in rows])
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
    p = request.get_json(silent=True) or {}
    data, err = validate_payload(p)
    if err:
        return jsonify(ok=False, error=err), 400

    conn = get_db()
    try:
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
    """聚合统计：总时长 / 今日 / 本周 / 计数 / 连续天数 / 热力图日数据。"""
    days = request.args.get("days", default=365, type=int)
    days = min(max(days, 7), 730)
    conn = get_db()
    try:
        today = datetime.date.today()
        since = today - datetime.timedelta(days=days - 1)
        since_s = since.strftime("%Y-%m-%d") + " 00:00:00"

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
            else:  # done / skip 计入总专注时长（跳过按原计划时长计）
                m = r["planned_minutes"] or r["actual_minutes"]
                d["minutes"] += m
                total_minutes += m
            counts[r["kind"]] += 1

        monday = today - datetime.timedelta(days=today.weekday())
        today_s = today.strftime("%Y-%m-%d")
        monday_s = monday.strftime("%Y-%m-%d")
        week_minutes = sum(v["minutes"] for k, v in daily.items() if k >= monday_s)
        today_minutes = daily.get(today_s, {}).get("minutes", 0)

        # 最长连续专注天数（今天没专注也不打断，从昨天往前数）
        streak = 0
        d = today
        if daily.get(d.strftime("%Y-%m-%d"), {}).get("minutes", 0) == 0:
            d = today - datetime.timedelta(days=1)
        while daily.get(d.strftime("%Y-%m-%d"), {}).get("minutes", 0) > 0:
            streak += 1
            d -= datetime.timedelta(days=1)

        # 近 30 天日均专注分钟
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
        data = "\ufeff" + buf.getvalue()  # BOM 让 Excel 正确识别 UTF-8
        return Response(data, mimetype="text/csv; charset=utf-8",
                        headers={"Content-Disposition":
                                 "attachment; filename=pomodoro_records.csv"})

    return Response(json.dumps(rows, ensure_ascii=False, indent=2),
                    mimetype="application/json; charset=utf-8",
                    headers={"Content-Disposition":
                             "attachment; filename=pomodoro_records.json"})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    print("=" * 56)
    print("  DLPromo · ТОМАТО-ЧАСЫ 后端已启动")
    print(f"  访问地址: http://127.0.0.1:{port}")
    print(f"  数据文件: {DB_PATH}")
    print("=" * 56)
    app.run(host="0.0.0.0", port=port, debug=False)