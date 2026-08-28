
/* ============================================================
   DLPromo · ТОМАТО-ЧАСЫ — 交互脚本
   ============================================================ */

// ---- 工具 ----
const $ = (s, p=document) => p.querySelector(s);
const $$ = (s, p=document) => [...p.querySelectorAll(s)];
const pad = n => String(n).padStart(2,'0');
const KIND_CN = { done:'完成', skip:'跳过', abandon:'放弃' };
const escChar = c => '&#' + c.charCodeAt(0) + ';';
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, escChar);

function fmtDate(d) {
  return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
}
function fmtDT(d) {
  return fmtDate(d)+' '+pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());
}
function fmtHM(m) {
  const h = Math.floor(m/60), n = m%60;
  return h>0 ? h+'h'+n+'m' : n+'m';
}
function level(min) {
  if (min<=0) return 0; if (min<25) return 1; if (min<50) return 2;
  if (min<100) return 3; if (min<200) return 4; return 5;
}

// ---- 状态 ----
const DEFAULTS = {
  durations: { focus:25, short:5, long:15 },
  opts: { autoShort:false, autoFocus:false, sound:true, notify:false }
};
let S = null;              // 计时器状态
let RECS = [];             // 已加载记录
let REC_TOTAL = 0;         // 服务器端记录总数
let REC_OFFSET = 0;        // 分页偏移
const REC_LIMIT = 100;     // 每页条数
let STATS = null;          // 统计缓存
let F = { kind:'all' };    // 记录过滤器
let PENDING = null;        // 待结算信息
let editingId = null;      // 编辑中的记录 id
let offline = false;       // 在线状态
let visibilityHidden = false;
let saving = false;        // 防止重复提交
const TIMER_KEY = 'tomato_timer';
const PENDING_KEY = 'pomo_pending';

function initState() {
  const saved = JSON.parse(localStorage.getItem('tomato_settings') || '{}');
  const dur = Object.assign({}, DEFAULTS.durations, saved.durations);
  const opts = Object.assign({}, DEFAULTS.opts, saved.opts);
  S = {
    mode: 'focus',
    running: false,
    total: dur.focus*60,
    remain: dur.focus*60,
    endAt: 0,
    tickId: null,
    startedAt: null,
    acc: 0,               // 已累计的运行秒数（排除暂停）
    segStart: null,       // 当前运行段的开始时间
    round: saved.round || 0,
    durations: dur,
    opts: opts,
  };
}
initState();

// ---- 持久化 ----
function saveSettings() {
  localStorage.setItem('tomato_settings', JSON.stringify({
    durations: S.durations, opts: S.opts, round: S.round
  }));
}

// 计时器快照：用于页面刷新/关闭后恢复
function saveTimerState() {
  if (!S.startedAt && !S.running && S.remain === S.total) {
    localStorage.removeItem(TIMER_KEY);
    return;
  }
  localStorage.setItem(TIMER_KEY, JSON.stringify({
    mode: S.mode, total: S.total, remain: S.remain, running: S.running,
    endAt: S.endAt, acc: S.acc,
    startedAt: S.startedAt ? S.startedAt.getTime() : null,
    round: S.round, task: $('#taskInput').value,
  }));
}

function maybeResume() {
  const raw = localStorage.getItem(TIMER_KEY);
  if (!raw) return;
  let snap;
  try { snap = JSON.parse(raw); } catch(e) { localStorage.removeItem(TIMER_KEY); return; }
  if (!snap || !snap.startedAt) return;
  S.mode = snap.mode || 'focus';
  S.total = snap.total || S.durations[S.mode]*60;
  S.remain = snap.remain;
  S.acc = snap.acc || 0;
  S.round = snap.round || 0;
  S.startedAt = new Date(snap.startedAt);
  $('#taskInput').value = snap.task || '';
  if (snap.running && snap.endAt) {
    S.remain = Math.max(0, Math.round((snap.endAt - Date.now())/1000));
  }
  saveSettings();
  if (S.remain <= 0) {
    // 离开期间已到期：专注则进入结算，休息则直接重置
    localStorage.removeItem(TIMER_KEY);
    if (S.mode === 'focus') { S.running = false; render(); openEndModal(false); }
    else { S.mode = 'focus'; resetTimer(); }
    return;
  }
  const modeCN = S.mode==='focus' ? '专注' : S.mode==='short' ? '短休' : '长休';
  $('#resumeInfo').innerHTML = '模式 <b>'+modeCN+'</b> · 剩余 <b>'+fmtHM(Math.round(S.remain/60)||1)+'</b> 分钟'
    + (snap.task ? ' · 任务 <b>'+escapeHtml(snap.task)+'</b>' : '');
  openModal('resumeModal');
}

// ---- API 调用 ----
async function api(path, opts={}) {
  let res;
  try {
    res = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch(e) {
    setNet(false);
    return { ok:false, error:'无法连接后端' };
  }
  setNet(true);
  const j = await res.json().catch(() => ({ ok:false, error:'响应解析失败' }));
  return j;
}

function setNet(ok) {
  const was = offline;
  offline = !ok;
  document.body.classList.toggle('offline', offline);
  $('#netState').textContent = offline ? '离线' : '在线';
}

// ---- 提示 ----
function toast(msg, type='ok') {
  const t = document.createElement('div');
  t.className = 'toast' + (type==='err' ? ' err' : type==='warn' ? ' warn' : '');
  t.innerHTML = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.classList.add('out'), 2600);
  setTimeout(() => t.remove(), 3000);
}

// ---- 模态框 ----
function openModal(id) { $('#'+id).classList.add('open'); }
function closeModal(id) { $('#'+id).classList.remove('open'); }
$$('.modal').forEach(m => {
  m.addEventListener('click', e => { if (e.target===m) closeModal(m.id); });
});
$$('.modal .x').forEach(x => {
  x.addEventListener('click', () => closeModal(x.closest('.modal').id));
});

// ---- 音效 ----
let AC = null;
function ac() {
  if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)();
  if (AC.state==='suspended') AC.resume();
  return AC;
}
function beep(f, dur, delay=0, type='square', vol=.24) {
  try {
    const t = ac().currentTime + delay;
    const o = ac().createOscillator();
    const g = ac().createGain();
    o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t+0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t+dur);
    o.connect(g); g.connect(ac().destination);
    o.start(t); o.stop(t+dur+0.05);
  } catch(e) {}
}
function playWhistle() {
  if (!S.opts.sound) return;
  beep(740, .16, 0, 'square', .22);
  beep(740, .16, .22, 'square', .22);
  beep(988, .50, .44, 'square', .28);
}

// ---- 通知 ----
function notify(title, body) {
  if (!S.opts.notify || !('Notification' in window) || Notification.permission!=='granted') return;
  try { new Notification(title, { body }); } catch(e) {}
}

// ---- 渲染计时器 ----
function render() {
  const m = Math.floor(S.remain/60), s = S.remain%60;
  $('#time').textContent = pad(m)+':'+pad(s);
  const C = 2*Math.PI*98, prog = S.total>0 ? S.remain/S.total : 0;
  $('#ringFg').style.strokeDashoffset = C*(1-prog);
  document.body.dataset.mode = S.mode;
  $('#modeLabel').textContent = S.mode==='focus' ? '专注·FOCUS' : S.mode==='short' ? '短休·BREAK' : '长休·REST';
  $('#btnStart').style.display = S.running ? 'none' : '';
  $('#btnPause').style.display = S.running ? '' : 'none';
  if (S.remain <= 0 && !S.running) {
    $('#btnStart').textContent = '再来一轮';
  } else if (S.remain === S.total && !S.startedAt) {
    $('#btnStart').textContent = '开始';
  } else {
    $('#btnStart').textContent = '继续';
  }
  document.title = pad(m)+':'+pad(s)+' · '+(S.mode==='focus'?'专注':'休息')+' | ТОМАТО';
  const r = S.round % 4;
  const disp = S.round===0 ? 0 : (r===0?4:r);
  $('#cycleLabel').textContent = '本轮 '+disp+' / 4 个番茄';
  // 更新预设按钮状态
  $$('#presets button[data-min]').forEach(b => {
    b.classList.toggle('active', +b.dataset.min === S.durations.focus);
  });
  // 模式标签
  $$('#modeTabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === S.mode);
  });
  // 结束按钮可见性
  $('#btnEnd').style.display = S.mode==='focus' ? '' : 'none';
}

// ---- 计时器控制 ----
function tick() {
  S.remain = Math.max(0, Math.round((S.endAt - Date.now())/1000));
  render();
  if (S.remain <= 0) { onTimerEnd(); }
}

function startTimer() {
  if (S.running) return;
  if (S.remain <= 0) {
    S.total = S.durations[S.mode]*60;
    S.remain = S.total;
  }
  S.running = true;
  S.endAt = Date.now() + S.remain*1000;
  S.segStart = Date.now();
  if (!S.startedAt) S.startedAt = new Date();
  S.tickId = setInterval(tick, 200);
  // 请求通知权限
  if (S.opts.notify && 'Notification' in window && Notification.permission==='default') {
    Notification.requestPermission();
  }
  saveTimerState();
  render();
}

function pauseTimer() {
  if (!S.running) return;
  clearInterval(S.tickId);
  S.tickId = null;
  S.remain = Math.max(0, Math.round((S.endAt - Date.now())/1000));
  if (S.segStart) S.acc += (Date.now() - S.segStart)/1000;
  S.segStart = null;
  S.running = false;
  saveTimerState();
  render();
}

function resetTimer() {
  if (S.running) { clearInterval(S.tickId); S.tickId = null; S.running = false; }
  S.total = S.durations[S.mode]*60;
  S.remain = S.total;
  S.startedAt = null;
  S.acc = 0;
  S.segStart = null;
  saveTimerState();
  render();
}

function switchMode(mode) {
  if (S.running) pauseTimer();
  S.mode = mode;
  resetTimer();
}

// 实际已专注的秒数（排除暂停时间）
function actualElapsedSeconds() {
  let s = S.acc || 0;
  if (S.running && S.segStart) s += (Date.now() - S.segStart)/1000;
  return s;
}

// ---- 计时结束 ----
function onTimerEnd() {
  clearInterval(S.tickId); S.tickId = null;
  S.running = false; S.remain = 0; S.acc = 0; S.segStart = null;
  saveTimerState();
  render();
  if (S.mode === 'focus') {
    playWhistle();
    notify('番茄结束', '本轮 '+S.durations.focus+' 分钟已到，请结算');
    openEndModal(false);
  } else {
    playWhistle();
    notify('休息结束', '准备开始下一轮专注');
    S.mode = 'focus'; resetTimer();
    if (S.opts.autoFocus) startTimer();
  }
}

function endSession() {
  if (S.mode !== 'focus') return;
  if (S.remain <= 0 && !S.running) { openEndModal(false); return; }
  if (!S.startedAt) { toast('还没有开始计时','warn'); return; }
  pauseTimer();
  openEndModal(true);
}

// ---- 结算 ----
function openEndModal(early) {
  const planned = S.durations.focus;
  let elapsedMin = planned;
  if (early && S.startedAt) {
    elapsedMin = Math.max(1, Math.round(actualElapsedSeconds()/60));
  }
  PENDING = { early, planned, elapsedMin: elapsedMin || planned };
  $('#endTitle').textContent = early ? '提前结束 // РАНО' : '计时结束 // ГОТОВО';
  $('#endDesc').innerHTML = early
    ? '本轮计划 <b>'+planned+'</b> 分钟 · 已实际专注 <b>'+elapsedMin+'</b> 分钟<br>请选择结算方式：'
    : '本轮 <b>'+planned+'</b> 分钟已到，请结算：';
  $('#btnDone').style.display = early ? 'none' : '';
  $('#btnDone').textContent = '完成 · 入账 '+planned+' 分钟';
  $('#btnSkip').textContent = '跳过 · 按 '+planned+' 分钟入账';
  $('#btnAbandon').textContent = '放弃 · 不计入总时长';
  openModal('endModal');
}

function recordDone() { saveRecord('done', PENDING.planned, PENDING.planned, ''); }
function recordSkip() { saveRecord('skip', PENDING.planned, PENDING.planned, ''); }
function recordAbandon() {
  closeModal('endModal');
  $('#abInfo').innerHTML = '计划 <b>'+PENDING.planned+'</b> 分钟 · 实际专注 <b>'+PENDING.elapsedMin+'</b> 分钟<br><span style="color:var(--red)">不计入总专注时间</span>';
  $('#abReason').value = '';
  openModal('abandonModal');
}

// ---- 离线写入队列 ----
function queueRecord(payload) {
  const q = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
  q.push(payload);
  localStorage.setItem(PENDING_KEY, JSON.stringify(q));
}

async function flushQueue() {
  const q = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
  if (!q.length) return;
  const rest = [];
  for (const p of q) {
    const r = await api('/api/records', { method:'POST', body:p });
    if (!(r && r.ok)) rest.push(p);
  }
  if (rest.length) {
    localStorage.setItem(PENDING_KEY, JSON.stringify(rest));
  } else {
    localStorage.removeItem(PENDING_KEY);
    toast('离线记录已同步','ok');
  }
}

async function saveRecord(kind, planned, actual, reason) {
  if (saving) return;
  saving = true;
  try {
    const end = new Date();
    const start = S.startedAt || end;
    const payload = {
      kind, task: $('#taskInput').value.trim(),
      planned_minutes: planned, actual_minutes: actual, reason,
      start_at: fmtDT(start), end_at: fmtDT(end)
    };
    closeModal('endModal');
    closeModal('abandonModal');
    const res = await api('/api/records', { method:'POST', body: payload });
    if (res && res.ok) {
      if (kind === 'abandon') {
        toast('已记录放弃（'+actual+' 分钟，不计入总时长）','warn');
      } else {
        toast('已入账 '+planned+' 分钟专注','ok');
      }
      afterRecord(kind);
      refreshAll();
    } else if (res && res.error === '无法连接后端') {
      // 离线：入队，联网后自动同步
      queueRecord(payload);
      toast('已离线暂存，联网后自动同步','warn');
    } else {
      toast('保存失败：'+(res&&res.error||'网络错误'),'err');
    }
  } finally {
    saving = false;
  }
}

function afterRecord(kind) {
  S.startedAt = null;
  S.acc = 0;
  S.segStart = null;
  if (kind !== 'abandon') S.round++;
  const isLong = S.round>0 && S.round%4===0;
  S.mode = kind==='abandon' ? 'short' : (isLong ? 'long' : 'short');
  S.total = S.durations[S.mode]*60;
  S.remain = S.total;
  saveSettings();
  saveTimerState();
  render();
  if (kind !== 'abandon' && S.opts.autoShort) startTimer();
}

// ---- 数据刷新 ----
async function refreshAll() {
  await Promise.all([loadRecords(), loadStats()]);
  updateTaskList();
  render();
  flushQueue();
}

async function loadRecords() {
  let url = '/api/records?limit='+REC_LIMIT+'&offset='+REC_OFFSET;
  if (F.kind !== 'all') url += '&kind='+F.kind;
  const j = await api(url);
  if (j.ok) {
    REC_TOTAL = j.total;
    RECS = REC_OFFSET === 0 ? j.data : RECS.concat(j.data);
    localStorage.setItem('pomo_recs', JSON.stringify(RECS));
    $('#btnLoadMore').style.display = RECS.length < REC_TOTAL ? '' : 'none';
  } else {
    try { RECS = JSON.parse(localStorage.getItem('pomo_recs')||'[]'); } catch(e) { RECS=[]; }
  }
  renderRecords();
}

async function loadStats() {
  const tzo = new Date().getTimezoneOffset();
  const j = await api('/api/stats?days=365&tz_offset='+(-tzo));
  if (j.ok) {
    STATS = j.data;
    localStorage.setItem('pomo_stats', JSON.stringify(STATS));
  } else {
    try { STATS = JSON.parse(localStorage.getItem('pomo_stats')||'null'); } catch(e) { STATS=null; }
  }
  renderStats();
  renderHeatmap();
}

// ---- 渲染记录 ----
function renderRecords() {
  const tbody = $('#recBody');
  if (RECS.length === 0) {
    tbody.innerHTML = '';
    $('#recEmpty').style.display = '';
    $('#recCount').textContent = '';
    return;
  }
  $('#recEmpty').style.display = 'none';
  $('#recCount').textContent = '共 '+REC_TOTAL+' 条';
  tbody.innerHTML = RECS.map(r => {
    const d = r.end_at.slice(0,10).replace(/-/g,'/');
    const t = r.start_at.slice(11,16)+'–'+r.end_at.slice(11,16);
    const min = r.kind==='abandon' ? r.actual_minutes+'分' : r.planned_minutes+'分';
    const reason = r.reason
      ? '<span class="rec-reason" title="'+escapeHtml(r.reason)+'">「'+escapeHtml(r.reason).slice(0,14)+'」</span>'
      : '';
    return '<tr data-id="'+r.id+'">'
      +'<td class="c-date">'+d+'<span class="c-time">'+t+'</span></td>'
      +'<td><span class="bd bd-'+r.kind+'">'+KIND_CN[r.kind]+'</span></td>'
      +'<td class="c-task">'+(escapeHtml(r.task)||'—')+'</td>'
      +'<td class="c-min">'+min+'</td>'
      +'<td class="c-reason">'+reason+'</td>'
      +'<td class="c-act"><button class="btn btn-sm btn-ghost" data-act="edit">编辑</button> <button class="btn btn-sm btn-ghost danger" data-act="del">删</button></td>'
      +'</tr>';
  }).join('');
}

// ---- 渲染统计 ----
function renderStats() {
  if (!STATS) return;
  const c = STATS.counts || {};
  $('#chipToday').textContent = fmtHM(STATS.today_minutes);
  $('#chipWeek').textContent = fmtHM(STATS.week_minutes);
  const alltime = STATS.alltime_minutes != null ? STATS.alltime_minutes : STATS.total_minutes;
  $('#chipTotal').textContent = fmtHM(alltime);
  $('#statDone').textContent = c.done||0;
  $('#statSkip').textContent = c.skip||0;
  $('#statAbandon').textContent = c.abandon||0;
  $('#statStreak').textContent = STATS.streak+' 天';
  $('#statAvg').textContent = STATS.avg30+' 分';
  $('#statTotal2').textContent = fmtHM(alltime);
}

// ---- 渲染热力图 ----
function renderHeatmap() {
  const daily = STATS ? STATS.daily : [];
  if (!daily.length) return;
  const map = {};
  let active=0, sum=0;
  daily.forEach(d => { map[d.date]=d.minutes; if(d.minutes>0){active++; sum+=d.minutes;} });
  const end = new Date(); end.setHours(0,0,0,0);
  const start = new Date(end); start.setDate(end.getDate()-(daily.length-1));
  const dow = start.getDay(); if (dow!==0) start.setDate(start.getDate()-dow);
  let prevMonth = -1, html = '';
  for (let w=0;;w++) {
    const ws = new Date(start); ws.setDate(start.getDate()+w*7);
    if (ws > end) break;
    const cells = [];
    for (let i=0;i<7;i++) {
      const dd = new Date(ws); dd.setDate(ws.getDate()+i);
      const ds = fmtDate(dd);
      const min = map[ds]||0;
      const future = dd > end ? ' future' : '';
      cells.push('<div class="hm-cell'+future+'" data-l="'+level(min)+'" data-date="'+ds+'" title="'+ds+' · '+min+' 分钟"></div>');
    }
    const m = ws.getMonth();
    const label = (m!==prevMonth && ws.getDate()<=7) ? (m+1)+'月' : '';
    prevMonth = m;
    html += '<div class="hm-col">'+cells.join('')+'<div class="hm-ml">'+label+'</div></div>';
  }
  $('#hmCols').innerHTML = html;
  $('#hmInfo').textContent = daily.length+' 天 · 专注 '+active+' 天 · 合计 '+fmtHM(sum);
}

// ---- 日详情 ----
$('#hmCols').addEventListener('click', async e => {
  const c = e.target.closest('.hm-cell');
  if (!c || c.classList.contains('future')) return;
  const ds = c.dataset.date;
  const from = ds+' 00:00:00', to = ds+' 23:59:59';
  const j = await api('/api/records?from='+encodeURIComponent(from)+'&to='+encodeURIComponent(to));
  const recs = j.ok ? j.data : [];
  const min = STATS ? STATS.daily.find(d => d.date===ds) : null;
  $('#dayTitle').textContent = ds + ' 共 '+(recs.length||0)+' 条';
  if (min && min.minutes>0) {
    $('#dayTitle').textContent += ' · 专注 '+fmtHM(min.minutes)+' · 放弃 '+(min.abandons||0)+' 次';
  }
  if (recs.length) {
    $('#dayBody').innerHTML = recs.map(r => {
      const t = r.start_at.slice(11,16)+'–'+r.end_at.slice(11,16);
      return '<div class="day-row">'
        +'<span class="bd bd-'+r.kind+'">'+KIND_CN[r.kind]+'</span>'
        +'<span class="day-task">'+(escapeHtml(r.task)||'（无任务）')+'</span>'
        +'<span class="day-time">'+t+'</span>'
        +'<span class="day-min">'+(r.kind==='abandon'?r.actual_minutes:r.planned_minutes)+'分</span>'
        +'</div>';
    }).join('');
  } else {
    $('#dayBody').innerHTML = '<div class="empty">当日无记录</div>';
  }
  openModal('dayModal');
});

// ---- 编辑记录 ----
function openEdit(rec) {
  editingId = rec.id;
  $('#eKind').value = rec.kind;
  $('#ePlanned').value = rec.planned_minutes;
  $('#eActual').value = rec.actual_minutes;
  $('#eTask').value = rec.task;
  $('#eReason').value = rec.reason;
  $('#eStart').value = rec.start_at.slice(0,16).replace(' ','T');
  $('#eEnd').value = rec.end_at.slice(0,16).replace(' ','T');
  syncActualField();
  openModal('editModal');
}

function syncActualField() {
  const k = $('#eKind').value;
  const dis = k !== 'abandon';
  $('#eActual').disabled = dis;
  if (dis) $('#eActual').value = $('#ePlanned').value;
}

$('#eKind').addEventListener('change', syncActualField);
$('#ePlanned').addEventListener('input', () => {
  if ($('#eKind').value !== 'abandon') $('#eActual').value = $('#ePlanned').value;
});

async function saveEdit() {
  const kind = $('#eKind').value;
  const planned = parseInt($('#ePlanned').value) || 0;
  const actual = parseInt($('#eActual').value) || planned;
  const task = $('#eTask').value.trim();
  const reason = $('#eReason').value.trim();
  const start = $('#eStart').value.replace('T',' ')+':00';
  const end = $('#eEnd').value.replace('T',' ')+':00';
  if (planned <= 0) { toast('计划时长必须大于 0','err'); return; }
  if (kind === 'abandon' && !reason) { toast('放弃记录必须填写原因','err'); return; }
  if (!start || !end) { toast('时间不能为空','err'); return; }
  const res = await api('/api/records/'+editingId, {
    method: 'PATCH',
    body: { kind, task, planned_minutes:planned, actual_minutes:actual, reason, start_at:start, end_at:end }
  });
  if (res.ok) {
    toast('已更新记录','ok');
    closeModal('editModal');
    refreshAll();
  } else {
    toast('更新失败：'+(res.error||'错误'),'err');
  }
}

async function deleteEdit() {
  if (!confirm('确认删除此记录？')) return;
  const res = await api('/api/records/'+editingId, { method:'DELETE' });
  if (res.ok) {
    toast('已删除记录','ok');
    closeModal('editModal');
    refreshAll();
  } else {
    toast('删除失败','err');
  }
}

// ---- 记录操作事件 ----
$('#recBody').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const tr = btn.closest('tr');
  const id = +tr.dataset.id;
  const rec = RECS.find(r => r.id===id);
  if (!rec) return;
  if (btn.dataset.act === 'edit') {
    openEdit(rec);
  } else if (btn.dataset.act === 'del') {
    if (btn.dataset.confirm) {
      const res = await api('/api/records/'+id, { method:'DELETE' });
      if (res.ok) { toast('已删除','ok'); refreshAll(); }
      else { toast('删除失败','err'); }
    } else {
      btn.dataset.confirm = '1';
      btn.textContent = '确认?';
      setTimeout(() => { delete btn.dataset.confirm; btn.textContent='删'; }, 2500);
    }
  }
});

// ---- 筛选 ----
$$('#filters button').forEach(b => {
  b.addEventListener('click', () => {
    $$('#filters button').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    F.kind = b.dataset.kind;
    REC_OFFSET = 0;
    RECS = [];
    loadRecords();
  });
});

// ---- 加载更多 ----
$('#btnLoadMore').addEventListener('click', () => {
  REC_OFFSET = RECS.length;
  loadRecords();
});

// ---- 导出 ----
$('#btnExportJson').addEventListener('click', () => window.open('/api/export?format=json'));
$('#btnExportCsv').addEventListener('click', () => window.open('/api/export?format=csv'));

// ---- 快捷键 ----
document.addEventListener('keydown', e => {
  if (e.target.closest('input,textarea,select,button,a,[contenteditable="true"]')) return;
  if (e.code === 'Space') { e.preventDefault(); S.running ? pauseTimer() : startTimer(); }
  if (e.key === 'r' || e.key === 'R') { resetTimer(); }
  if (e.key === 'e' || e.key === 'E') { endSession(); }
});

// ---- 任务列表 ----
function updateTaskList() {
  const tasks = [...new Set(RECS.map(r => r.task).filter(Boolean))].slice(0,20);
  $('#taskList').innerHTML = tasks.map(t => '<option value="'+escapeHtml(t)+'">').join('');
}

// ---- 可见性 / 生命周期 ----
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { visibilityHidden = true; }
  else if (visibilityHidden) { refreshAll(); visibilityHidden = false; }
});

// 关闭/刷新页面：提醒未完成计时，并保存快照以便恢复
window.addEventListener('beforeunload', e => {
  if (S.running) { e.preventDefault(); e.returnValue=''; }
});
window.addEventListener('pagehide', saveTimerState);

// 网络恢复时同步离线队列
window.addEventListener('online', () => { flushQueue(); refreshAll(); });

// ---- 设置事件绑定 ----
function bindEvents() {
  // 模式切换
  $$('#modeTabs button').forEach(b => {
    b.addEventListener('click', () => switchMode(b.dataset.mode));
  });
  // 开始/暂停
  $('#btnStart').addEventListener('click', startTimer);
  $('#btnPause').addEventListener('click', pauseTimer);
  $('#btnReset').addEventListener('click', resetTimer);
  $('#btnEnd').addEventListener('click', endSession);
  // 预设
  $$('#presets button[data-min]').forEach(b => {
    b.addEventListener('click', () => {
      S.durations.focus = +b.dataset.min;
      saveSettings();
      if (S.mode==='focus') resetTimer();
      render();
    });
  });
  // 自定义
  $('#btnCustom').addEventListener('click', () => {
    $('#cuFocus').value = S.durations.focus;
    $('#cuShort').value = S.durations.short;
    $('#cuLong').value = S.durations.long;
    openModal('customModal');
  });
  $('#cuSave').addEventListener('click', () => {
    const f = parseInt($('#cuFocus').value) || 25;
    const s = parseInt($('#cuShort').value) || 5;
    const l = parseInt($('#cuLong').value) || 15;
    S.durations = { focus: Math.max(1,Math.min(600,f)), short: Math.max(1,Math.min(120,s)), long: Math.max(1,Math.min(180,l)) };
    saveSettings();
    if (S.mode==='focus') resetTimer();
    render();
    toast('已设置自定义时长','ok');
    closeModal('customModal');
  });
  $('#cuCancel').addEventListener('click', () => closeModal('customModal'));
  // 选项
  ['autoShort','autoFocus','sound','notify'].forEach(key => {
    const el = $('#opt'+key[0].toUpperCase()+key.slice(1));
    if (el) {
      el.checked = S.opts[key];
      el.addEventListener('change', () => {
        S.opts[key] = el.checked;
        saveSettings();
      });
    }
  });
  // 结算按钮
  $('#btnDone').addEventListener('click', recordDone);
  $('#btnSkip').addEventListener('click', recordSkip);
  $('#btnAbandon').addEventListener('click', recordAbandon);
  $('#abConfirm').addEventListener('click', () => {
    const reason = $('#abReason').value.trim();
    if (!reason) { $('#abReason').focus(); toast('请填写放弃原因','warn'); return; }
    saveRecord('abandon', PENDING.planned, PENDING.elapsedMin, reason);
  });
  $('#abCancel').addEventListener('click', () => { closeModal('abandonModal'); openEndModal(PENDING.early); });
  // 编辑保存
  $('#eSave').addEventListener('click', saveEdit);
  $('#eCancel').addEventListener('click', () => closeModal('editModal'));
  $('#eDelete').addEventListener('click', deleteEdit);
  // 刷新
  $('#btnRefresh').addEventListener('click', refreshAll);
  // 恢复会话
  $('#btnResume').addEventListener('click', () => {
    closeModal('resumeModal');
    startTimer();
    toast('已继续计时','ok');
  });
  $('#btnDiscard').addEventListener('click', () => {
    closeModal('resumeModal');
    localStorage.removeItem(TIMER_KEY);
    resetTimer();
  });
}

// ---- 启动 ----
bindEvents();
render();
maybeResume();
refreshAll();
// 每 5 分钟自动刷新（后台静默）
setInterval(() => { if (!document.hidden) refreshAll(); }, 300000);

console.log('DLPromo · ТОМАТО-ЧАСЫ 已启动');
