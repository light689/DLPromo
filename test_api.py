# -*- coding: utf-8 -*-
"""DLPromo · ТОМАТО-ЧАСЫ 后端集成测试（unittest，使用临时数据库）"""
import os
import tempfile
import unittest
import datetime

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

    def test_static_assets(self):
        for path in ("/static/style.css", "/static/app.js", "/static/dseg7.woff2"):
            r = self.client.get(path)
            self.assertEqual(r.status_code, 200, path)
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

    def test_api_404_json(self):
        r = self.client.get("/api/nonexistent")
        self.assertEqual(r.status_code, 404)
        self.assertEqual(r.get_json()["ok"], False)


if __name__ == "__main__":
    unittest.main(verbosity=2)
