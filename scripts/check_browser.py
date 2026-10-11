from playwright.sync_api import sync_playwright
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.request import urlopen


def wait_js(page, expression):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if page.evaluate(expression):
            return
        time.sleep(0.1)
    raise AssertionError("Timed out: " + expression)

# Optional end-to-end check: install playwright and Chromium first.
# Runs against a disposable database, with the normal CSP enabled.
with tempfile.TemporaryDirectory(prefix="dlpromo-browser-") as tempdir:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    base_url = f"http://127.0.0.1:{port}"
    server_python = os.environ.get("DLPROMO_TEST_PYTHON", sys.executable)
    environment = dict(os.environ, PORT=str(port), DLPROMO_DB=str(Path(tempdir)/"test.db"))
    server = subprocess.Popen([server_python, "main.py"], cwd=Path(__file__).resolve().parents[1],
                              env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(100):
            try:
                with urlopen(base_url+"/api/health", timeout=1):
                    break
            except OSError:
                if server.poll() is not None:
                    raise RuntimeError("Test server exited. Install requirements.txt in the selected Python environment.")
                time.sleep(0.1)
        else:
            raise RuntimeError("Test server did not start")
        with sync_playwright() as p:
         browser=p.chromium.launch(executable_path=p.chromium.executable_path,headless=True,args=['--no-sandbox'])
         context=browser.new_context(viewport={'width':1280,'height':1000})
         page=context.new_page();errors=[]
         page.on('pageerror',lambda error:errors.append(str(error)))
         page.goto(base_url)
         page.click('#bootEnter')
         wait_js(page,"document.querySelector('#offlineReady').textContent.includes('已就绪')")
         wait_js(page,'!!navigator.serviceWorker.controller')
         page.fill('#goalName','浏览器测试任务');page.fill('#goalTarget','3');page.click('#taskGoalForm button')
         wait_js(page,"document.querySelector('#taskMap').textContent.includes('0 / 3')")
         page.click('[data-task-action="focus"]');assert page.input_value('#taskInput')=='浏览器测试任务'
         page.click('#btnStart');page.evaluate('S.acc=180; S.segStart=Date.now();');page.click('#btnEnd');page.click('#btnSkip')
         wait_js(page,"document.querySelector('#taskMap').textContent.includes('1 / 3')")
         wait_js(page,"document.querySelector('#dualActual').textContent==='3m'")
         assert page.inner_text('#dualCredited')=='25m'
         page.click('[data-metric="actual"]');assert page.inner_text('#chipToday')=='3m'
         # 离线加载、记录与目标修改
         context.set_offline(True);page.reload();page.click('#bootEnter')
         wait_js(page,"document.querySelector('#taskMap').textContent.includes('浏览器测试任务')")
         page.fill('#goalName','离线任务');page.fill('#goalTarget','2');page.click('#taskGoalForm button')
         wait_js(page,"document.querySelector('#taskMap').textContent.includes('离线任务')")
         page.click('[data-task="离线任务"] [data-task-action="focus"]');page.click('#btnStart')
         page.evaluate('S.acc=120;S.segStart=Date.now();');page.click('#btnEnd');page.click('#btnSkip')
         wait_js(page,"document.querySelector('#recBody').textContent.includes('待同步')")
         wait_js(page,"S.mode==='short' && S.startedAt===null")
         # 离线中断与补充理由
         page.evaluate("S.mode='focus';resetTimer();document.querySelector('#taskInput').value='离线任务';startTimer();onPageHidden();onPageVisible();")
         page.fill('#backReason','手机消息');page.click('#btnBackFocus')
         wait_js(page,"!document.querySelector('#backModal').classList.contains('open')")
         assert page.evaluate("JSON.parse(localStorage.getItem('pomo_aux_queue')).some(item=>item.kind==='quit' && item.payload.reason==='手机消息')")
         context.set_offline(False);page.click('#btnSync')
         wait_js(page,"!localStorage.getItem('pomo_pending') && !localStorage.getItem('pomo_aux_queue')")
         wait_js(page,"document.querySelector('[data-task=\"离线任务\"]').textContent.includes('1 / 2')")
         wait_js(page,"document.querySelector('#insightReasons').textContent.includes('手机消息')")
         assert page.evaluate("fetch('/api/quit_logs').then(r=>r.json()).then(j=>j.total)")==1
         # 轻量模式无需填理由
         page.uncheck('#optRequireReason')
         page.evaluate('onPageHidden();onPageVisible();')
         assert not page.locator('#backModal').evaluate("el=>el.classList.contains('open')")
         page.set_viewport_size({'width':390,'height':844})
         page.evaluate('resetTimer();')
         page.screenshot(path=str(Path(tempdir)/'mobile.png'),full_page=True)
         print('page errors:',errors)
         assert not errors
         assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'mobile overflow'
         print('PASS: dual metrics, task goal/progress, offline reload/write/sync, quit reason dedup, lightweight mode, mobile layout')
         browser.close()
    finally:
        server.terminate()
        server.wait(timeout=10)
