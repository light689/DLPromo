# -*- coding: utf-8 -*-
"""DLPromo · ТОМАТО-ЧАСЫ 后端集成测试（使用 Flask test_client）"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import main

app = main.app
client = app.test_client()

def show(name, r):
    try:
        j = r.get_json()
    except Exception:
        j = r.get_data(as_text=True)[:60]
    print(f"{name}: {r.status_code} -> {j}")

# 1. health
show('health', client.get('/api/health'))

# 2. 首页
r = client.get('/')
text = r.get_data(as_text=True)
print('index:', r.status_code, 'bytes:', len(text), '| ТОМАТО present:', 'ТОМАТО' in text)

# 3. 完成记录
show('POST done', client.post('/api/records', json={
    'kind':'done','task':'写论文','planned_minutes':25,'actual_minutes':25,'reason':'',
    'start_at':'2026-08-24 10:00:00','end_at':'2026-08-24 10:25:00'}))

# 4. 跳过记录
show('POST skip', client.post('/api/records', json={
    'kind':'skip','task':'读代码','planned_minutes':25,'actual_minutes':25,'reason':'',
    'start_at':'2026-08-24 11:00:00','end_at':'2026-08-24 11:25:00'}))

# 5. 放弃-无原因（应 400）
show('POST abandon(no reason)', client.post('/api/records', json={
    'kind':'abandon','task':'写代码','planned_minutes':25,'actual_minutes':9,'reason':'',
    'start_at':'2026-08-24 12:00:00','end_at':'2026-08-24 12:09:00'}))

# 6. 放弃-有原因
show('POST abandon', client.post('/api/records', json={
    'kind':'abandon','task':'写代码','planned_minutes':25,'actual_minutes':9,'reason':'被电话打断',
    'start_at':'2026-08-24 12:00:00','end_at':'2026-08-24 12:09:00'}))

# 7. 列表
r = client.get('/api/records')
data = r.get_json()['data']
print('records:', len(data), [d['kind'] for d in data])

# 8. stats：done+skip=50 计入，abandon 9 不计入
r = client.get('/api/stats?days=365')
s = r.get_json()['data']
print('stats total:', s['total_minutes'], '(expect 50)')
print('stats counts:', s['counts'])
print('stats today:', s['today_minutes'], '| week:', s['week_minutes'], '| streak:', s['streak'], '| avg30:', s['avg30'])
print('stats daily len:', len(s['daily']))

# 9. PATCH 编辑
rid = data[0]['id']
show('PATCH', client.patch(f'/api/records/{rid}', json={
    'kind':'done','task':'写论文-改','planned_minutes':30,'actual_minutes':30,'reason':'',
    'start_at':'2026-08-24 10:00:00','end_at':'2026-08-24 10:30:00'}))

# 10. DELETE
show('DELETE', client.delete(f'/api/records/{rid}'))

# 11. 导出
r = client.get('/api/export?format=csv')
print('CSV head:', r.get_data(as_text=True)[:70].replace('\n','|'))
r = client.get('/api/export?format=json')
print('JSON export:', r.status_code, len(r.data), 'bytes')

# 12. 非法 kind / 负数
show('bad kind', client.post('/api/records', json={'kind':'xxx','planned_minutes':25}))
show('bad minutes', client.post('/api/records', json={
    'kind':'done','planned_minutes':-5,'start_at':'2026-08-24 10:00:00','end_at':'2026-08-24 10:25:00'}))

# 13. 清理测试数据
for d in client.get('/api/records').get_json()['data']:
    client.delete(f"/api/records/{d['id']}")
print('cleanup remaining:', len(client.get('/api/records').get_json()['data']))

print('=== ALL TESTS DONE ===')
