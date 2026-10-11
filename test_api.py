# -*- coding: utf-8 -*-
"""DLPromo · ТОМАТО-ЧАСЫ 后端集成测试（unittest，使用临时数据库）"""
import os
import tempfile
import unittest
import datetime
import json

# 必须在 import main 之前设置临时数据库路径
_TMPDIR = tempfile.mkdtemp(prefix="dlpromo_test_")
os.environ["DLPROMO_DB"] = os.path.join(_TMPDIR, "test.db")

import main  # noqa: E402

app = main.app


def ts(d: datetime.date, hm: str) -> str:
    """拼出 YYYY-MM-DD HH:MM:SS 时间串。"""
    return d.strftime("%Y-%m-%d") + " " + hm + ":00"


class DLPromoAPITest(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()
        # 清空记录，保证测试隔离
        conn = main.get_db()
        try:
            with conn:
                conn.execute("DELETE FROM records")
                conn.execute("DELETE FROM quit_logs")
                conn.execute("DELETE FROM quit_deletes")
                conn.execute("DELETE FROM task_goals")
        finally:
            conn.close()

    def add(self, kind="done", planned=25, actual=None, reason="",
            day=None, hm="10:00", hm_end=None, task="任务"):
        if day is None:
            day = datetime.date.today()
        actual = planned if actual is None else actual
        hm_end = hm_end or hm
        return self.client.post("/api/records", json={
            "kind": kind, "task": task, "planned_minutes": planned,
            "actual_minutes": actual, "reason": reason,
            "start_at": ts(day, hm), "end_at": ts(day, hm_end),
        })

    # ---------------------------------------------------------- 基础
    def test_health(self):
        r = self.client.get("/api/health")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.get_json()["ok"])

    def test_index(self):
        r = self.client.get("/")
        self.assertEqual(r.status_code, 200)
        self.assertIn("ТОМАТО", r.get_data(as_text=True))
        r.close()

    def test_static_assets(self):
        for path in ("/static/style.css", "/static/app.js", "/static/dseg7.woff2"):
            r = self.client.get(path)
            self.assertEqual(r.status_code, 200, path)
            r.close()
        # 不应能越过 static 读取 db
        self.assertEqual(self.client.get("/static/../main.py").status_code, 404)

    # ---------------------------------------------------------- 创建/校验
    def test_create_done(self):
        r = self.add()
        self.assertEqual(r.status_code, 200)
        d = r.get_json()["data"]
        self.assertEqual(d["kind"], "done")
        self.assertEqual(d["planned_minutes"], 25)
        self.assertEqual(d["actual_minutes"], 25)

    def test_skip_counts(self):
        self.add(kind="skip")
        self.add(kind="done")
        r = self.client.get("/api/stats?days=365")
        self.assertEqual(r.status_code, 200)
        s = r.get_json()["data"]
        self.assertEqual(s["counts"]["skip"], 1)
        self.assertEqual(s["counts"]["done"], 1)
        # done + skip 计入，abandon 不计
        self.assertEqual(s["total_minutes"], 50)

    def test_abandon_requires_reason(self):
        r = self.add(kind="abandon", actual=9, reason="")
        self.assertEqual(r.status_code, 400)
        self.assertIn("原因", r.get_json()["error"])

    def test_abandon_not_counted(self):
        self.add(kind="abandon", actual=9, reason="被电话打断")
        r = self.client.get("/api/stats?days=365")
        s = r.get_json()["data"]
        self.assertEqual(s["total_minutes"], 0)
        self.assertEqual(s["counts"]["abandon"], 1)

    def test_actual_zero_not_overwritten(self):
        """显式传 actual=0 应保留 0，而不是被静默替换成 planned。"""
        r = self.add(kind="abandon", actual=0, reason="立刻放弃")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["data"]["actual_minutes"], 0)

    def test_actual_defaults_to_planned(self):
        """不传 actual 时 done/skip 用 planned。"""
        r = self.client.post("/api/records", json={
            "kind": "done", "task": "t", "planned_minutes": 30,
            "start_at": ts(datetime.date.today(), "10:00"),
            "end_at": ts(datetime.date.today(), "10:30"),
        })
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json()["data"]["actual_minutes"], 30)

    def test_bad_kind(self):
        r = self.client.post("/api/records", json={"kind": "xxx", "planned_minutes": 25})
        self.assertEqual(r.status_code, 400)

    def test_bad_planned(self):
        r = self.client.post("/api/records", json={
            "kind": "done", "planned_minutes": -5,
            "start_at": "2026-08-24 10:00:00", "end_at": "2026-08-24 10:25:00",
        })
        self.assertEqual(r.status_code, 400)

    def test_bad_date_format(self):
        r = self.client.post("/api/records", json={
            "kind": "done", "planned_minutes": 25,
            "start_at": "2026/08/24 10:00", "end_at": "2026-08-24 10:25:00",
        })
        self.assertEqual(r.status_code, 400)
        self.assertIn("格式", r.get_json()["error"])

    def test_end_before_start(self):
        r = self.client.post("/api/records", json={
            "kind": "done", "planned_minutes": 25,
            "start_at": "2026-08-24 11:00:00", "end_at": "2026-08-24 10:00:00",
        })
        self.assertEqual(r.status_code, 400)
        self.assertIn("早于", r.get_json()["error"])

    def test_missing_times(self):
        r = self.client.post("/api/records", json={"kind": "done", "planned_minutes": 25})
        self.assertEqual(r.status_code, 400)

    # ---------------------------------------------------------- 更新/删除
    def test_patch_partial_update(self):
        r = self.add(task="原始")
        rid = r.get_json()["data"]["id"]
        # 只改 task，其余保持
        r = self.client.patch(f"/api/records/{rid}", json={"task": "已改"})
        self.assertEqual(r.status_code, 200)
        d = r.get_json()["data"]
        self.assertEqual(d["task"], "已改")
        self.assertEqual(d["kind"], "done")
        self.assertEqual(d["planned_minutes"], 25)

    def test_patch_missing_record(self):
        r = self.client.patch("/api/records/99999", json={"task": "x"})
        self.assertEqual(r.status_code, 404)

    def test_patch_abandon_requires_reason(self):
        r = self.add()
        rid = r.get_json()["data"]["id"]
        # 把 done 改成 abandon 但没给原因 → 400
        r = self.client.patch(f"/api/records/{rid}", json={"kind": "abandon"})
        self.assertEqual(r.status_code, 400)

    def test_delete(self):
        r = self.add()
        rid = r.get_json()["data"]["id"]
        self.assertEqual(self.client.delete(f"/api/records/{rid}").status_code, 200)
        self.assertEqual(self.client.delete(f"/api/records/{rid}").status_code, 404)

    # ---------------------------------------------------------- 分页
    def test_pagination(self):
        for i in range(150):
            self.add()
        r = self.client.get("/api/records")
        j = r.get_json()
        self.assertEqual(j["total"], 150)
        self.assertEqual(len(j["data"]), 100)  # 默认 limit

        r = self.client.get("/api/records?limit=50&offset=100")
        j = r.get_json()
        self.assertEqual(len(j["data"]), 50)
        self.assertEqual(j["total"], 150)

        r = self.client.get("/api/records?limit=99999")
        self.assertLessEqual(len(r.get_json()["data"]), 1000)  # cap 生效

    def test_filter_kind(self):
        self.add(kind="done")
        self.add(kind="abandon", reason="x")
        r = self.client.get("/api/records?kind=done")
        j = r.get_json()
        self.assertEqual(j["total"], 1)
        self.assertEqual(j["data"][0]["kind"], "done")

    # ---------------------------------------------------------- 统计
    def test_stats_fields(self):
        self.add(kind="done", planned=25)
        self.add(kind="skip", planned=15)
        self.add(kind="abandon", actual=9, reason="x")
        r = self.client.get("/api/stats?days=365&tz_offset=0")
        s = r.get_json()["data"]
        self.assertEqual(s["total_minutes"], 40)
        self.assertEqual(s["alltime_minutes"], 40)
        self.assertIn("today_minutes", s)
        self.assertIn("week_minutes", s)
        self.assertIn("streak", s)
        self.assertEqual(len(s["daily"]), 365)

    def test_stats_tz_changes_today(self):
        """tz_offset 应正确偏移服务器时区来判定 today 边界。"""
        today = datetime.date.today()
        self.add(day=today, hm="23:30", hm_end="23:55")  # 今天很晚的一条
        s0 = self.client.get("/api/stats?days=365&tz_offset=0").get_json()["data"]
        self.assertEqual(s0["today_minutes"], 25)
        # 偏移 -24 小时：客户端认为今天是"昨天"，该记录落在窗口外
        s1 = self.client.get("/api/stats?days=365&tz_offset=-1440").get_json()["data"]
        self.assertEqual(s1["today_minutes"], 0)

    def test_alltime_exceeds_window(self):
        """alltime 应包含窗口外（>365 天）的记录。"""
        old = datetime.date.today() - datetime.timedelta(days=400)
        self.add(day=old)
        self.add()  # 今天
        s = self.client.get("/api/stats?days=365").get_json()["data"]
        self.assertEqual(s["total_minutes"], 25)      # 窗口内只有今天的
        self.assertEqual(s["alltime_minutes"], 50)    # 生命周期两条

    # ---------------------------------------------------------- 导出
    def test_export_csv(self):
        self.add(task="含,逗号")
        r = self.client.get("/api/export?format=csv")
        self.assertEqual(r.status_code, 200)
        text = r.get_data(as_text=True)
        self.assertTrue(text.startswith("\ufeff"))  # BOM
        self.assertIn("planned_minutes", text)
        self.assertIn("含,逗号", text)

    def test_export_json(self):
        self.add()
        r = self.client.get("/api/export?format=json")
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertEqual(len(data), 1)

    # ---------------------------------------------------------- 安全
    def test_body_size_limit(self):
        big = "x" * (2 * 1024 * 1024)
        r = self.client.post("/api/records", json={"kind": "done", "planned_minutes": 25, "note": big})
        self.assertEqual(r.status_code, 413)

    def test_security_headers(self):
        r = self.client.get("/")
        self.assertEqual(r.headers.get("X-Content-Type-Options"), "nosniff")
        self.assertIn("Content-Security-Policy", r.headers)
        self.assertIn("script-src 'self'", r.headers["Content-Security-Policy"])
        r.close()

    def test_api_404_json(self):
        r = self.client.get("/api/nonexistent")
        self.assertEqual(r.status_code, 404)
        self.assertEqual(r.get_json()["ok"], False)


    def test_idempotent_session(self):
        payload = {"kind": "done", "planned_minutes": 25, "session_id": "test-session",
                   "start_at": "2026-10-11 10:00:00", "end_at": "2026-10-11 10:25:00"}
        first = self.client.post("/api/records", json=payload).get_json()["data"]
        second = self.client.post("/api/records", json=payload).get_json()["data"]
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(self.client.get("/api/records").get_json()["total"], 1)

    def test_clear_text_fields(self):
        rid = self.add(task="旧任务", reason="旧备注").get_json()["data"]["id"]
        data = self.client.patch(f"/api/records/{rid}", json={"task": "", "reason": ""}).get_json()["data"]
        self.assertEqual(data["task"], "")
        self.assertEqual(data["reason"], "")
        self.assertEqual(self.client.patch(f"/api/records/{rid}", json={"start_at": ""}).status_code, 400)

    def test_invalid_json_objects(self):
        for path, method in [("/api/records", "post"), ("/api/quit", "post"),
                             ("/api/quit_logs/1", "patch"), ("/api/quit_logs/1", "delete")]:
            for body in ([1], "text", 12, None):
                with self.subTest(path=path, body=body):
                    response = getattr(self.client, method)(path, data=json.dumps(body),
                                                           content_type="application/json")
                    self.assertEqual(response.status_code, 400)

    def test_integer_ranges(self):
        for value in (True, 2.5, 1e30, 10**100, 601):
            with self.subTest(value=value):
                self.assertEqual(self.add(planned=value).status_code, 400)
        for value in (-1, 601, 1e30):
            self.assertEqual(self.add(actual=value).status_code, 400)

    def test_future_excluded_and_avg_independent_of_window(self):
        today = datetime.datetime.now(datetime.timezone.utc).date()
        self.add(day=today)
        self.add(day=today - datetime.timedelta(days=20), planned=35)
        self.add(day=today + datetime.timedelta(days=1), planned=600)
        data = self.client.get("/api/stats?days=7").get_json()["data"]
        self.assertEqual(data["total_minutes"], 25)
        self.assertEqual(data["week_minutes"], 25)
        self.assertEqual(data["alltime_minutes"], 60)
        self.assertEqual(data["avg30"], 2)

    def test_longest_streak_outside_window(self):
        today = datetime.datetime.now(datetime.timezone.utc).date()
        for offset in (50, 49, 48, 0):
            self.add(day=today - datetime.timedelta(days=offset))
        data = self.client.get("/api/stats?days=7").get_json()["data"]
        self.assertEqual(data["current_streak"], 1)
        self.assertEqual(data["longest_streak"], 3)
        self.assertEqual(data["streak"], 3)

    def test_schema_migration_preserves_records(self):
        import sqlite3
        old_path = main.DB_PATH
        main.DB_PATH = os.path.join(_TMPDIR, "legacy.db")
        try:
            with sqlite3.connect(main.DB_PATH) as conn:
                conn.execute("""CREATE TABLE records (id INTEGER PRIMARY KEY, kind TEXT, task TEXT,
                    planned_minutes INTEGER, actual_minutes INTEGER, reason TEXT,
                    start_at TEXT, end_at TEXT, created_at TEXT)""")
                conn.execute("INSERT INTO records VALUES (1,'done','旧记录',25,25,'',"
                             "'2026-01-01 10:00:00','2026-01-01 10:25:00','2026-01-01')")
                conn.execute("PRAGMA user_version=4")
            main.init_db()
            main.init_db()
            with main.get_db() as conn:
                self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0], main.SCHEMA_VERSION)
                self.assertEqual(conn.execute("SELECT task FROM records").fetchone()[0], "旧记录")
                self.assertIn("session_id", [r["name"] for r in conn.execute("PRAGMA table_info(records)")])
        finally:
            main.DB_PATH = old_path


    def test_dual_minutes_include_abandoned_actual(self):
        self.add(kind="done", planned=25, actual=25)
        self.add(kind="skip", planned=25, actual=8)
        self.add(kind="abandon", planned=25, actual=4, reason="电话")
        stats = self.client.get("/api/stats").get_json()["data"]
        self.assertEqual(stats["total_minutes"], 50)
        self.assertEqual(stats["actual_minutes"], 37)
        self.assertEqual(stats["alltime_actual_minutes"], 37)
        self.assertEqual(stats["today_actual_minutes"], 37)
        self.assertEqual(stats["daily"][-1]["actual_minutes"], 37)

    def test_task_goal_and_progress_reflect_edits_and_deletion(self):
        self.assertEqual(self.client.put("/api/tasks", json={"name":"报告", "target_pomos":4}).status_code,200)
        rid = self.add(kind="skip", planned=25, actual=8, task="报告").get_json()["data"]["id"]
        self.add(kind="abandon", actual=4, reason="电话", task="报告")
        task = self.client.get("/api/tasks").get_json()["data"][0]
        self.assertEqual(task["target_pomos"],4)
        self.assertEqual(task["completed_pomos"],1)
        self.assertEqual(task["credited_minutes"],25)
        self.assertEqual(task["actual_minutes"],12)
        self.client.patch(f"/api/records/{rid}",json={"actual_minutes":9})
        self.assertEqual(self.client.get("/api/tasks").get_json()["data"][0]["actual_minutes"],13)
        self.client.delete(f"/api/records/{rid}")
        task = self.client.get("/api/tasks").get_json()["data"][0]
        self.assertEqual(task["completed_pomos"],0)
        self.assertEqual(task["actual_minutes"],4)
        self.client.delete("/api/tasks",json={"name":"报告"})
        task = self.client.get("/api/tasks").get_json()["data"][0]
        self.assertIsNone(task["target_pomos"])
        self.assertEqual(self.client.get("/api/records").get_json()["total"],1)

    def test_tasks_unplanned_and_future_records(self):
        today = datetime.datetime.now(datetime.timezone.utc).date()
        self.add(task="历史任务")
        self.add(task="未来任务",day=today+datetime.timedelta(days=1))
        self.client.put("/api/tasks",json={"name":"新目标","target_pomos":2})
        tasks = {t["name"]:t for t in self.client.get("/api/tasks").get_json()["data"]}
        self.assertNotIn("未来任务",tasks)
        self.assertIsNone(tasks["历史任务"]["target_pomos"])
        self.assertEqual(tasks["新目标"]["completed_pomos"],0)

    def test_task_validation_and_upsert(self):
        for target in (0,10001,True,1.5,"abc"):
            self.assertEqual(self.client.put("/api/tasks",json={"name":"test","target_pomos":target}).status_code,400)
        self.assertEqual(self.client.put("/api/tasks",json={"name":" ","target_pomos":4}).status_code,400)
        for count in (2,5):
            self.client.put("/api/tasks",json={"name":"task","target_pomos":count})
        tasks = self.client.get("/api/tasks").get_json()["data"]
        self.assertEqual(len(tasks),1)
        self.assertEqual(tasks[0]["target_pomos"],5)

    def test_interruption_idempotency_and_reason_update(self):
        date = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
        payload = {"event_id":"quit-one","quit_at":date+" 14:00:00"}
        first = self.client.post("/api/quit",json=payload).get_json()["data"]
        payload["reason"] = "电话"
        second = self.client.post("/api/quit",json=payload).get_json()["data"]
        self.assertEqual(first["id"],second["id"])
        self.assertEqual(second["reason"],"电话")
        payload["reason"] = ""
        self.assertEqual(self.client.post("/api/quit",json=payload).get_json()["data"]["reason"],"电话")
        self.assertEqual(self.client.get("/api/quit_logs").get_json()["total"],1)
        self.assertEqual(self.client.post("/api/quit",json={"event_id":[1]}).status_code,400)

    def test_insights_window_hour_reason_and_empty(self):
        empty = self.client.get("/api/insights").get_json()["data"]
        self.assertEqual(empty["total"],0)
        self.assertIsNone(empty["peak_hour"])
        today = datetime.datetime.now(datetime.timezone.utc).date()
        for offset,hour,reason in [(0,14,"电话"),(0,14,"电话"),(0,9,""),(40,14,"旧记录"),(-1,14,"未来")]:
            self.client.post("/api/quit",json={"quit_at":(today-datetime.timedelta(days=offset)).isoformat()+f" {hour:02}:00:00","reason":reason})
        data = self.client.get("/api/insights?days=30").get_json()["data"]
        self.assertEqual(data["total"],3)
        self.assertEqual(data["unlabelled"],1)
        self.assertEqual(data["peak_hour"],14)
        self.assertEqual(data["hours"][14]["count"],2)
        self.assertEqual(data["reasons"],[{"reason":"电话","count":2}])
        self.assertEqual(self.client.get("/api/insights?days=90").get_json()["data"]["total"],4)

    def test_pwa_shell_and_manifest(self):
        with self.client.get("/sw.js") as response:
            self.assertEqual(response.status_code,200)
            self.assertEqual(response.headers["Cache-Control"],"no-cache")
            self.assertIn("url.pathname.startsWith('/api/')",response.get_data(as_text=True))
        with self.client.get("/static/manifest.webmanifest") as response:
            manifest = json.loads(response.get_data(as_text=True))
            self.assertEqual(manifest["display"],"standalone")
            self.assertEqual(manifest["scope"],"/")
        for icon in manifest["icons"]:
            with self.client.get(icon["src"]) as response:
                self.assertEqual(response.status_code,200)


if __name__ == "__main__":
    unittest.main(verbosity=2)
