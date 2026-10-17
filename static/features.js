/* 双口径、任务进度、中断洞察与 PWA。与 app.js 共享计时与 API。 */
let TASKS = [];
let INSIGHTS = null;
let metric = localStorage.getItem('pomo_metric') === 'actual' ? 'actual' : 'credited';
const AUX_QUEUE_KEY = 'pomo_aux_queue';
let auxFlushing = null;
let syncError = '';
let installPrompt = null;

function readLocal(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch (_) { return fallback; }
}

function updateSyncStatus() {
  const box = $('#syncStatus');
  if (!box) return;
  const records = readLocal(PENDING_KEY, []);
  const extras = readLocal(AUX_QUEUE_KEY, []);
  const count = records.length + extras.length;
  box.textContent = (flushing || auxFlushing ? '正在同步 · ' : '')
    + (count ? count+' 项待同步，已保存在本机' : '本地记录已同步')
    + (syncError ? ' · '+syncError : '');
  $('#btnSync').disabled = !!(flushing || auxFlushing);
}

function queueAux(kind, payload, method='POST') {
  const queue = readLocal(AUX_QUEUE_KEY, []);
  const key = kind === 'task' ? payload.name : payload.event_id;
  const existing = queue.find(item => item.kind === kind && item.key === key);
  if (kind === 'quit' && existing?.payload.reason && !payload.reason) return;
  const entry = {id:newSessionId(), kind, key, method, payload};
  const rest = queue.filter(item => !(item.kind === kind && item.key === key));
  rest.push(entry);
  localStorage.setItem(AUX_QUEUE_KEY, JSON.stringify(rest));
  syncError = '';
  updateSyncStatus();
}

function flushAuxQueue() {
  if (auxFlushing) return auxFlushing;
  const run = async () => {
    const queue = readLocal(AUX_QUEUE_KEY, []);
    let synced = false;
    for (const item of queue) {
      const path = item.kind === 'task' ? '/api/tasks' : '/api/quit';
      const result = await api(path, {method:item.method, body:item.payload});
      if (!result.ok) {
        syncError = result.error || '同步暂未完成';
        break;
      }
      const rest = readLocal(AUX_QUEUE_KEY, []).filter(entry => entry.id !== item.id);
      if (rest.length) localStorage.setItem(AUX_QUEUE_KEY, JSON.stringify(rest));
      else localStorage.removeItem(AUX_QUEUE_KEY);
      synced = true;
      updateSyncStatus();
    }
    if (synced) await Promise.all([loadFeatures(), loadQuit(), renderQuitHeatmap()]);
  };
  auxFlushing = run().finally(() => { auxFlushing = null; updateSyncStatus(); });
  updateSyncStatus();
  return auxFlushing;
}

function pendingQuit() {
  const raw = localStorage.getItem(PENDING_QUIT_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch (_) { return {quit_at:raw, legacy:true}; }
}

async function loadFeatures() {
  await Promise.all([loadTasks(), loadInsights()]);
}

async function loadTasks() {
  const result = await api('/api/tasks?tz_offset='+(-new Date().getTimezoneOffset()));
  if (result.ok) {
    TASKS = result.data;
    localStorage.setItem('pomo_tasks', JSON.stringify(TASKS));
  } else TASKS = readLocal('pomo_tasks', []);
  renderTaskMap();
}

async function loadInsights() {
  const days = $('#insightDays').value;
  const key = 'pomo_insights_'+days;
  const result = await api('/api/insights?days='+days+'&tz_offset='+(-new Date().getTimezoneOffset()));
  // 用户切换范围时，忽略旧请求迟到的结果。
  if ($('#insightDays').value !== days) return;
  if (result.ok) {
    INSIGHTS = result.data;
    localStorage.setItem(key, JSON.stringify(INSIGHTS));
  } else INSIGHTS = readLocal(key, null);
  renderInsights();
}

function renderDualStats() {
  if (!STATS) return;
  $('#dualCredited').textContent = fmtHM(STATS.alltime_minutes || 0);
  $('#dualActual').textContent = fmtHM(STATS.alltime_actual_minutes || 0);
  $('#dualPeriods').innerHTML = [
    ['今日',STATS.today_minutes,STATS.today_actual_minutes],
    ['本周',STATS.week_minutes,STATS.week_actual_minutes],
    ['近30日均',STATS.avg30,STATS.avg30_actual]
  ].map(([label,credited,actual]) => '<div><b>'+label+'</b>计划 '+fmtHM(credited||0)+' / 实际 '+fmtHM(actual||0)+'</div>').join('');
  $$('[data-metric]').forEach(button => button.classList.toggle('active',button.dataset.metric === metric));
}

function renderInsights() {
  const data = INSIGHTS;
  $('#insightReasons').innerHTML = '';
  $('#insightHours').innerHTML = '';
  $('#insightAdvice').textContent = '';
  if (!data) {
    $('#insightSummary').textContent = '当前离线，尚无此范围的缓存。联网后可查看分析。';
    return;
  }
  $('#insightSummary').textContent = '近 '+data.days+' 天 · '+data.total+' 次中断 · 日均 '+data.average_per_day+' 次 · '+data.unlabelled+' 次未填写理由';
  $('#insightReasons').innerHTML = data.reasons.length
    ? data.reasons.map(row => '<div class="reason-row"><span>'+escapeHtml(row.reason)+'</span><b>'+row.count+' 次</b></div>').join('')
    : '<p class="feature-note">尚无理由记录。可开启返回后的理由提示，了解常见干扰。</p>';
  const max = Math.max(1,...data.hours.map(row => row.count));
  $('#insightHours').innerHTML = data.hours.map(row => '<div class="hour-column" title="'+row.hour+':00–'+row.hour+':59 · '+row.count+' 次"><div class="hour-bar" style="height:'+Math.max(2,row.count/max*75)+'px"></div><span class="hour-label">'+(row.hour%6===0 ? row.hour : '')+'</span></div>').join('');
  $('#insightHours').setAttribute('aria-label',data.hours.map(row => row.hour+'点 '+row.count+'次').join('，'));
  $('#insightAdvice').textContent = data.total
    ? '中断最集中在 '+data.peak_hour+':00–'+data.peak_hour+':59。可以尝试提前处理消息，或在这一时段安排短休。'
    : '这段时间没有记录到中断。保持适合自己的节奏。';
}

function taskView() {
  const tasks = new Map(TASKS.map(task => [task.name,{...task}]));
  for (const entry of readLocal(AUX_QUEUE_KEY, [])) {
    if (entry.kind !== 'task') continue;
    const task = tasks.get(entry.payload.name) || {name:entry.payload.name,completed_pomos:0,credited_minutes:0,actual_minutes:0,abandons:0};
    task.target_pomos = entry.method === 'DELETE' ? null : entry.payload.target_pomos;
    task.pending = true;
    tasks.set(task.name, task);
  }
  return [...tasks.values()];
}

function renderTaskMap() {
  const tasks = taskView();
  $('#taskMap').innerHTML = tasks.length ? tasks.map(task => {
    const target = task.target_pomos;
    const done = task.completed_pomos;
    const pct = target ? Math.min(100,Math.round(done/target*100)) : 0;
    const progress = target ? done+' / '+target+' 个番茄 · '+pct+'%' : done+' 个番茄 · 尚未设置目标';
    return '<article class="task-card'+(target && done>=target ? ' complete' : '')+'" data-task="'+escapeHtml(task.name)+'">'
      +'<div class="task-card-top"><h3>'+escapeHtml(task.name)+'</h3><span class="task-detail">'+progress+(task.pending?' · 目标待同步':'')+'</span></div>'
      +(target ? '<progress max="'+target+'" value="'+Math.min(done,target)+'" aria-label="'+escapeHtml(task.name)+'完成进度"></progress>' : '')
      +'<p class="task-detail">计划入账 '+fmtHM(task.credited_minutes)+' · 实际投入 '+fmtHM(task.actual_minutes)+' · 放弃 '+task.abandons+' 次</p>'
      +'<div class="task-actions"><button class="btn btn-sm btn-red" data-task-action="focus">专注此任务</button><button class="btn btn-sm" data-task-action="edit">设置目标</button>'
      +(target ? '<button class="btn btn-sm btn-ghost" data-task-action="remove">移除目标</button>' : '')+'</div></article>';
  }).join('') : '<p class="feature-note">为任务设置预计番茄数，开始绘制你的进度地图。</p>';
  updateTaskList();
}

async function saveTaskGoal(event) {
  event.preventDefault();
  const name = $('#goalName').value.trim();
  const target = Number($('#goalTarget').value);
  if (!name || name.length>200 || !Number.isInteger(target) || target<1 || target>10000) {
    toast('请填写任务名称与有效的预计番茄数','warn'); return;
  }
  queueAux('task',{name,target_pomos:target},'PUT');
  renderTaskMap();
  toast('目标已保存在本机','ok');
  await flushAuxQueue();
}

function initFeatures() {
  $('#optRequireReason').checked = S.opts.requireReason !== false;
  $('#optRequireReason').addEventListener('change', event => {
    S.opts.requireReason = event.target.checked;
    saveSettings();
  });
  $('#taskGoalForm').addEventListener('submit',saveTaskGoal);
  $('#taskMap').addEventListener('click',async event => {
    const button = event.target.closest('[data-task-action]');
    if (!button) return;
    const name = button.closest('[data-task]').dataset.task;
    const task = taskView().find(row => row.name === name);
    if (button.dataset.taskAction === 'focus') {
      if (S.startedAt) { toast('请先结算当前一轮，再切换任务','warn'); return; }
      if (S.mode !== 'focus') switchMode('focus');
      $('#taskInput').value = name;
      $('#taskInput').scrollIntoView({behavior:'smooth',block:'center'});
      toast('已选择任务，点击开始即可专注','ok');
    } else if (button.dataset.taskAction === 'edit') {
      $('#goalName').value = name;
      $('#goalTarget').value = task.target_pomos || 4;
      $('#goalTarget').focus();
    } else if (confirm('移除「'+name+'」的目标？历史专注记录会保留。')) {
      queueAux('task',{name},'DELETE'); renderTaskMap(); await flushAuxQueue();
    }
  });
  $('#insightDays').addEventListener('change',loadInsights);
  $$('[data-metric]').forEach(button => button.addEventListener('click',() => {
    metric = button.dataset.metric;
    localStorage.setItem('pomo_metric',metric);
    renderStats(); renderHeatmap();
  }));
  $('#btnSync').addEventListener('click',async () => {
    syncError = '';
    await Promise.all([flushQueue(),flushAuxQueue()]);
    await refreshAll();
  });
  window.addEventListener('offline',() => { setNet(false); updateSyncStatus(); });
  window.addEventListener('storage',event => {
    if ([PENDING_KEY,AUX_QUEUE_KEY].includes(event.key)) { updateSyncStatus(); renderTaskMap(); }
  });
  window.addEventListener('beforeinstallprompt',event => {
    event.preventDefault(); installPrompt = event; $('#btnInstall').hidden = false;
  });
  $('#btnInstall').addEventListener('click',async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    installPrompt = null; $('#btnInstall').hidden = true;
  });
  window.addEventListener('appinstalled',() => { $('#btnInstall').hidden = true; });
  updateSyncStatus();
  initOfflineApp();
}

async function initOfflineApp() {
  const label = $('#offlineReady');
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    label.textContent = '使用 HTTPS 或 localhost 可启用离线打开'; return;
  }
  try {
    let controlled = !!navigator.serviceWorker.controller;
    let pendingUpdate = false, reloading = false;
    const applyUpdate = () => {
      if (!pendingUpdate || reloading) return;
      if (S.running || S.startedAt || saving || document.querySelector('.modal.open')) {
        label.textContent = '新版已就绪 · 当前会话结束后自动更新';
        return;
      }
      reloading = true;
      saveTimerState();
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (controlled) { pendingUpdate = true; applyUpdate(); }
      controlled = true;
    });
    const registration = await navigator.serviceWorker.register('/sw.js', {updateViaCache: 'none'});
    const checkUpdate = () => registration.update().catch(() => {});
    checkUpdate();
    window.addEventListener('online', checkUpdate);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) { checkUpdate(); applyUpdate(); }
    });
    setInterval(() => { if (!document.hidden) checkUpdate(); }, 300000);
    setInterval(applyUpdate, 1000);
    await navigator.serviceWorker.ready;
    label.textContent = '离线打开已就绪 · 可添加到主屏幕';
  } catch (_) { label.textContent = '离线资源未就绪，联网后重试'; }
}
