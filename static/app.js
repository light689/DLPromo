
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
function fmtSec(s) {
  const m = Math.floor(s/60), r = Math.round(s%60);
  if (r === 60) { return fmtSec((m+1)*60); }
  return m>0 ? (r>0 ? m+'分'+r+'秒' : m+'分钟') : r+'秒';
}
function level(min) {
  if (min<=0) return 0; if (min<25) return 1; if (min<50) return 2;
  if (min<100) return 3; if (min<200) return 4; return 5;
}

// ---- 状态 ----
const DEFAULTS = {
  durations: { focus: 1500, short: 300, long: 900 },
  opts: { autoShort:false, autoFocus:false, sound:true, notify:false, longEvery:4 }
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
let lastQuitTs = 0;
let saving = false;        // 防止重复提交
const TIMER_KEY = 'tomato_timer';
const PENDING_KEY = 'pomo_pending';

function initState() {
  const saved = JSON.parse(localStorage.getItem('tomato_settings') || '{}');
  const dur = Object.assign({}, DEFAULTS.durations, saved.durations);
  // 旧版本以分钟存储，迁移为秒
  if (dur.focus < 60) dur.focus *= 60;
  if (dur.short < 60) dur.short *= 60;
  if (dur.long < 60) dur.long *= 60;
  const opts = Object.assign({}, DEFAULTS.opts, saved.opts);
  S = {
    mode: 'focus',
    running: false,
    total: dur.focus,
    remain: dur.focus,
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
  S.total = snap.total || S.durations[S.mode];
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
  m.addEventListener('click', e => { if (e.target===m && !m.dataset.locked) closeModal(m.id); });
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
// 为圆环生成 60 个刻度线（每 6° 一根，整 5 分刻度加粗）
function buildRingTicks() {
  const svg = $('#ringWrap svg');
  const NS = 'http://www.w3.org/2000/svg';
  const g = document.createElementNS(NS, 'g');
  g.setAttribute('id', 'ringTicks');
  for (let i = 0; i < 60; i++) {
    const a = i * 6 * Math.PI / 180;
    const major = i % 5 === 0;
    const r1 = 84, r2 = major ? 78 : 81;
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', (110 + Math.sin(a) * r1).toFixed(2));
    line.setAttribute('y1', (110 - Math.cos(a) * r1).toFixed(2));
    line.setAttribute('x2', (110 + Math.sin(a) * r2).toFixed(2));
    line.setAttribute('y2', (110 - Math.cos(a) * r2).toFixed(2));
    line.setAttribute('stroke', 'rgba(251,247,236,.5)');
    line.setAttribute('stroke-width', major ? '2' : '1');
    line.setAttribute('stroke-linecap', 'round');
    g.appendChild(line);
  }
  svg.appendChild(g);
}

function render() {
  const m = Math.floor(S.remain/60), s = S.remain%60;
  $('#time').textContent = pad(m)+':'+pad(s);
  const C = 2*Math.PI*98, prog = S.total>0 ? S.remain/S.total : 0;
  $('#ringFg').style.strokeDashoffset = C*(1-prog);
  document.body.dataset.mode = S.mode;
  // 运行时外发光
  document.body.classList.toggle('running', S.running);
  // 随模式更新浏览器主题色
  const mc = document.body.dataset.mode;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', mc==='short' ? '#d4a000' : mc==='long' ? '#1e50aa' : '#e01f26');
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
  const every = Math.max(1, S.opts.longEvery||4);
  const r = S.round % every;
  const disp = S.round===0 ? 0 : (r===0?every:r);
  $('#cycleLabel').textContent = '本轮 '+disp+' / '+every+' 个番茄';
  // 更新预设按钮状态
  $$('#presets button[data-min]').forEach(b => {
    b.classList.toggle('active', +b.dataset.min*60 === S.durations.focus);
  });
  // 模式标签
  $$('#modeTabs button').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === S.mode);
  });
  // 结束按钮可见性
  $('#btnEnd').style.display = S.mode==='focus' ? '' : 'none';
  // 沉浸式全屏同步
  if (fsActive) {
    $('#fsTime').textContent = pad(m)+':'+pad(s);
    $('#fsSub').textContent = S.mode==='focus' ? '专注 · FOCUS' : S.mode==='short' ? '短休 · BREAK' : '长休 · REST';
    const t = $('#taskInput').value.trim();
    $('#fsTask').textContent = t ? '本轮 · '+t : '';
  }
}

// ---- 沉浸式全屏 ----
let fsActive = false;

function openFS() {
  try { $('#fsExit').focus(); } catch(e) {}
  fsActive = true;
  $('#fsLayer').classList.add('open');
  document.body.classList.add('fs-on');
  // 真实浏览器全屏
  const el = document.documentElement;
  const rfs = el.requestFullscreen || el.webkitRequestFullscreen;
  if (rfs && !document.fullscreenElement) rfs.call(el);
  // 尽量锁横屏（仅在支持且用户手势下生效）
  try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(()=>{}); } catch(e) {}
  render();
}

function closeFS() {
  if (!fsActive) return;
  fsActive = false;
  $('#fsLayer').classList.remove('open');
  document.body.classList.remove('fs-on');
  // 退出真实全屏
  if (document.fullscreenElement) { const e = document.exitFullscreen || document.webkitExitFullscreen; if (e) e.call(document); }
  try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch(e) {}
}

// 全屏点击层：开始/暂停（绑定见 bindEvents）

// 浏览器全屏被用户退出（Esc 等）时同步关闭沉浸层
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && fsActive) closeFS();
});
document.addEventListener('webkitfullscreenchange', () => {
  if (!document.fullscreenElement && fsActive) closeFS();
});

// ---- 计时器控制 ----
function tick() {
  S.remain = Math.max(0, Math.round((S.endAt - Date.now())/1000));
  render();
  if (S.remain <= 0) { onTimerEnd(); }
}

function startTimer() {
  if (S.running) return;
  if (S.remain <= 0) {
S.total = S.durations[S.mode];
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
  syncWakeLock();
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
  syncWakeLock();
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
  syncWakeLock();
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
  syncWakeLock();
  if (S.mode === 'focus') {
    closeFS();
    playWhistle();
    notify('番茄结束', '本轮 '+fmtSec(S.durations.focus)+' 已到，请结算');
    openEndModal(false);
  } else {
    closeFS();
    playWhistle();
    notify('休息结束', '准备开始下一轮专注');
    S.mode = 'focus'; resetTimer();
    if (S.opts.autoFocus) startTimer();
  }
}

function endSession() {
  if (S.mode !== 'focus') return;
  if (S.remain <= 0 && !S.running) { closeFS(); openEndModal(false); return; }
  if (!S.startedAt) { toast('还没有开始计时','warn'); return; }
  pauseTimer();
  closeFS();
  openEndModal(true);
}

// ---- 结算 ----
function openEndModal(early) {
  const plannedSec = S.durations.focus;
  let elapsedMin = plannedSec/60;
  if (early && S.startedAt) {
    elapsedMin = Math.max(0.016, actualElapsedSeconds()/60);
  }
  PENDING = { early, plannedSec, planned: Math.round(plannedSec/60*10)/10, elapsedMin: elapsedMin || plannedSec/60 };
  const pl = PENDING.planned, el = Math.round(PENDING.elapsedMin*10)/10;
  $('#endTitle').textContent = early ? '提前结束 // РАНО' : '计时结束 // ГОТОВО';
  $('#endDesc').innerHTML = early
    ? '本轮计划 <b>'+fmtSec(plannedSec)+'</b> · 已实际专注 <b>'+el+'</b> 分钟<br>请选择结算方式：'
    : '本轮 <b>'+fmtSec(plannedSec)+'</b> 已完成，专注入账。';
  // 自然结束：只显示完成；提前结束：显示跳过+放弃，隐藏完成
  $('#btnDone').style.display = early ? 'none' : '';
  $('#btnSkip').style.display = early ? '' : 'none';
  $('#btnAbandon').style.display = early ? '' : 'none';
  $('#btnDone').textContent = '完成 · 入账 '+fmtSec(plannedSec);
  $('#btnSkip').textContent = '跳过 · 按 '+fmtSec(plannedSec)+' 入账';
  $('#btnAbandon').textContent = '放弃 · 不计入总时长';
  const notes = $('#endModal .end-notes');
  if (notes) notes.style.display = early ? '' : 'none';
  openModal('endModal');
}

function recordDone() { saveRecord('done', PENDING.planned, PENDING.planned, ''); }
function recordSkip() { saveRecord('skip', PENDING.planned, PENDING.planned, ''); }
function recordAbandon() {
  closeModal('endModal');
  $('#abInfo').innerHTML = '计划 <b>'+fmtSec(PENDING.plannedSec)+'</b> · 实际专注 <b>'+Math.round(PENDING.elapsedMin*10)/10+'</b> 分钟<br><span style="color:var(--red)">不计入总专注时间</span>';
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
        toast('已记录放弃（'+Math.round(actual*10)/10+' 分钟，不计入总时长）','warn');
      } else {
        toast('已入账 '+fmtSec(PENDING.plannedSec)+' 专注','ok');
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
  const every = Math.max(1, S.opts.longEvery||4);
  const isLong = S.round>0 && S.round%every===0;
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
  await Promise.all([loadRecords(), loadStats(), loadQuit()]);
  updateTaskList();
  render();
  flushQueue();
  renderQuitHeatmap();
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
  const planned = parseFloat($('#ePlanned').value) || 0;
  const actual = parseFloat($('#eActual').value) || planned;
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
  if (e.key === 'e' || e.key === 'E') { endSession(); }
});

// ---- 任务列表 ----
function updateTaskList() {
  const tasks = [...new Set(RECS.map(r => r.task).filter(Boolean))].slice(0,20);
  $('#taskList').innerHTML = tasks.map(t => '<option value="'+escapeHtml(t)+'">').join('');
}

// ---- 切出检测（手机切后台 / 锁屏 / 离开页面） ----
let quitThisHide = false;
let exiting = false;                       // 退出模式：不记录切出
let wakeLock = null;                       // Screen Wake Lock 句柄
const PENDING_QUIT_KEY = 'pomo_pending_quit';
const QUIT_COOLDOWN_MS = 60000;            // 切出冷却：1 分钟内最多 1 次

function quitLocalNow() {
  const d = new Date();
  return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())
    +' '+pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());
}
function fmtDTLocal(v) {   // "YYYY-MM-DD HH:MM:SS" -> datetime-local value
  return v ? v.slice(0,10)+'T'+v.slice(11,16) : '';
}
function dtFromLocal(v) {  // datetime-local value -> "YYYY-MM-DD HH:MM:00"
  if (!v) return '';
  const r = v.replace('T',' ');
  return r.length===16 ? r+':00' : r;
}

function focusInProgress() {
  return S && S.mode === 'focus' && S.startedAt;
}

// 页面切出（hidden）时调用
function onPageHidden() {
  if (exiting) return;
  if (!focusInProgress()) {              // 未开始专注 / 休息阶段：只标记提示
    quitThisHide = true;
    return;
  }
  if (S.running) pauseTimer();           // 专注切出：默认暂停
  // 冷却：1 分钟内最多 1 次，且未填理由期间不再新增
  const now = Date.now();
  const hasPending = !!localStorage.getItem(PENDING_QUIT_KEY);
  if (now - lastQuitTs >= QUIT_COOLDOWN_MS && !hasPending) {
    lastQuitTs = now;
    try {
      if (navigator.sendBeacon) navigator.sendBeacon('/api/quit');
      else fetch('/api/quit', { method:'POST', keepalive:true }).catch(()=>{});
    } catch(e) {}
    localStorage.setItem(PENDING_QUIT_KEY, quitLocalNow());
    const chip = $('#chipQuit');
    if (chip) {
      const n = (parseInt(chip.dataset.v||'0',10)||0)+1;
      chip.dataset.v = n;
      chip.textContent = n+'次';
    }
  }
  quitThisHide = true;
}

// 页面回来（visible）时调用
function onPageVisible() {
  refreshAll();
  if (!quitThisHide) return;
  quitThisHide = false;
  if (!focusInProgress()) {
    toast('检测到切出（未开始计时 / 休息，不记录）','warn');
    return;
  }
  showBackModal();
}

// 切出回来：弹窗激励 + 填理由（专注模式必须填理由）
function showBackModal() {
  const chip = $('#chipQuit');
  const n = chip ? (parseInt(chip.dataset.v||'0',10)||0) : 0;
  const t = S && S.running
    ? '计时器还在运转，剩余 <b>'+fmtHM(Math.max(1,Math.round(S.remain/60)))+'</b>'
    : '随时可以开始新的一轮';
  let title, desc;
  if (n <= 1) {
    title = '欢迎回来！';
    desc = '你刚刚切出了 <b>'+n+'</b> 次。专注的敌人是打断，坚持就是胜利！<br>'+t+'。';
  } else if (n <= 3) {
    title = '还在坚持！';
    desc = '今日已切出 <b>'+n+'</b> 次，但你每次都回来了。韧性可嘉，继续！<br>'+t+'。';
  } else {
    title = '稳住节奏！';
    desc = '今日已切出 <b>'+n+'</b> 次。每一次回归都是进步，深呼吸，回到当下。<br>'+t+'。';
  }
  $('#backTitle').textContent = title;
  $('#backDesc').innerHTML = desc;
  $('#backReason').value = '';
  openModal('backModal');
}

// 保存切出理由：补到最近一条空理由记录，或新建一条（专注必须填）
async function saveBackReason() {
  const reason = $('#backReason').value.trim();
  if (!reason) { $('#backReason').focus(); toast('专注切出必须填写理由','warn'); return; }
  const quitAt = localStorage.getItem(PENDING_QUIT_KEY);
  const list = await api('/api/quit_logs?limit=1');
  let saved = false;
  if (list.ok && list.data && list.data.length && !list.data[0].reason) {
    const r = await api('/api/quit_logs/'+list.data[0].id, { method:'PATCH', body:{ reason, quit_at: quitAt } });
    saved = !!(r && r.ok);
  }
  if (!saved) {
    const body = { reason };
    if (quitAt) body.quit_at = quitAt;
    await api('/api/quit', { method:'POST', body });
  }
  localStorage.removeItem(PENDING_QUIT_KEY);
  closeModal('backModal');
  refreshAll();
  toast('切出理由已记录','ok');
}

// ---- Screen Wake Lock（专注时屏幕常亮） ----
async function requestWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch(e) { wakeLock = null; }
}
function releaseWakeLock() {
  if (wakeLock) { try { wakeLock.release(); } catch(e) {} wakeLock = null; }
}
function syncWakeLock() {
  if (S && S.mode === 'focus' && S.running) requestWakeLock();
  else releaseWakeLock();
}

// ---- 退出功能（黑屏关机，不记录切出） ----
function doQuit() {
  exiting = true;
  if (S && S.running) pauseTimer();
  releaseWakeLock();
  localStorage.removeItem(PENDING_QUIT_KEY);
  $('#shutdownLayer').classList.add('open');
}
function cancelQuit() {
  $('#shutdownLayer').classList.remove('open');
  exiting = false;
}

// ---- 切出热力图（红色警示） ----
function quitLevel(q) {
  if (q<=0) return 0; if (q<=1) return 1; if (q<=3) return 2;
  if (q<=6) return 3; if (q<=10) return 4; return 5;
}
async function renderQuitHeatmap() {
  const tzo = new Date().getTimezoneOffset();
  const j = await api('/api/session_meta?days=365&tz_offset='+(-tzo));
  const box = $('#quitHmCols');
  if (!j.ok || !box) return;
  const items = j.data.items || [];
  const map = {}; let sum=0;
  items.forEach(d => { map[d.date]=d.quit_count; sum+=d.quit_count; });
  const end = new Date(); end.setHours(0,0,0,0);
  const start = new Date(end); start.setDate(end.getDate()-(items.length-1));
  const dow = start.getDay(); if (dow!==0) start.setDate(start.getDate()-dow);
  let prevMonth = -1, html = '';
  for (let w=0;;w++) {
    const ws = new Date(start); ws.setDate(start.getDate()+w*7);
    if (ws > end) break;
    const cells = [];
    for (let i=0;i<7;i++) {
      const dd = new Date(ws); dd.setDate(ws.getDate()+i);
      const ds = fmtDate(dd);
      const q = map[ds]||0;
      const future = dd > end ? ' future' : '';
      cells.push('<div class="hm-cell'+future+'" data-l="'+quitLevel(q)+'" data-date="'+ds+'" title="'+ds+' · 切出 '+q+' 次"></div>');
    }
    const m = ws.getMonth();
    const label = (m!==prevMonth && ws.getDate()<=7) ? (m+1)+'月' : '';
    prevMonth = m;
    html += '<div class="hm-col">'+cells.join('')+'<div class="hm-ml">'+label+'</div></div>';
  }
  box.innerHTML = html;
  const info = $('#quitHmInfo');
  if (info) info.textContent = items.length+' 天 · 合计切出 '+sum+' 次';
}

async function loadQuit() {
  const tzo = new Date().getTimezoneOffset();
  const j = await api('/api/session_meta?days=1&tz_offset='+(-tzo));
  if (j.ok && j.data.items && j.data.items[0]) {
    const n = j.data.items[0].quit_count;
    const chip = $('#chipQuit');
    if (chip) { chip.dataset.v = n; chip.textContent = n+'次'; }
  }
}

// ---- 切出记录管理（查看 / 编辑 / 删除） ----
async function loadQuitList() {
  const j = await api('/api/quit_logs?limit=200');
  const box = $('#quitList');
  if (!j.ok) { box.innerHTML = '<div class="end-desc">加载失败</div>'; return; }
  const rows = j.data;
  $('#quitHint').textContent = rows.length ? '共 '+j.total+' 条切出记录，可修改时间与理由。' : '还没有切出记录。';
  box.innerHTML = rows.map(r => {
    const dt = fmtDTLocal(r.quit_at);
    return '<div class="quit-row" data-id="'+r.id+'">'
      +'<div class="quit-fields">'
      +'<input type="datetime-local" class="q-time" value="'+dt+'" aria-label="切出时间">'
      +'<input type="text" class="q-reason" maxlength="200" value="'+escapeHtml(r.reason)+'" placeholder="切出理由">'
      +'</div>'
      +'<div class="quit-acts">'
      +'<button class="btn btn-sm q-save">保存</button>'
      +'<button class="btn btn-sm btn-ghost danger q-del">删除</button>'
      +'</div>'
      +'</div>';
  }).join('');
  $$('.q-save', box).forEach(b => b.addEventListener('click', () => saveQuitRow(b)));
  $$('.q-del', box).forEach(b => b.addEventListener('click', () => delQuitRow(b)));
}

async function saveQuitRow(btn) {
  const row = btn.closest('.quit-row');
  const id = row.dataset.id;
  const quit_at = dtFromLocal($$('.q-time', row)[0].value);
  const reason = $$('.q-reason', row)[0].value.trim();
  const r = await api('/api/quit_logs/'+id, { method:'PATCH', body:{ quit_at, reason } });
  if (r.ok) { toast('已保存','ok'); refreshAll(); loadQuitList(); }
  else toast(r.error||'保存失败','err');
}

async function delQuitRow(btn) {
  const row = btn.closest('.quit-row');
  const id = row.dataset.id;
  // 打开删除理由模态框
  window._delQuitId = id;
  $('#delQuitReason').value = '';
  openModal('delQuitModal');
}

// ---- 可见性 / 生命周期 ----
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    visibilityHidden = true;
    onPageHidden();
  }
  else if (visibilityHidden) {
    visibilityHidden = false;
    onPageVisible();
  }
});
document.addEventListener('visibilitychange', releaseWakeLockOnHide);
function releaseWakeLockOnHide() {
  if (document.hidden && wakeLock) releaseWakeLock();
}

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
  $('#btnEnd').addEventListener('click', endSession);
  // 预设
  $$('#presets button[data-min]').forEach(b => {
    b.addEventListener('click', () => {
      S.durations.focus = +b.dataset.min*60;
      saveSettings();
      if (S.mode==='focus') resetTimer();
      render();
    });
  });
  // 自定义
  $('#btnCustom').addEventListener('click', () => {
    $('#cuFocusMin').value = Math.floor(S.durations.focus/60);
    $('#cuFocusSec').value = S.durations.focus % 60;
    $('#cuShort').value = Math.round(S.durations.short/60);
    $('#cuLong').value = Math.round(S.durations.long/60);
    $('#cuLongEvery').value = S.opts.longEvery||4;
    openModal('customModal');
  });
  $('#cuSave').addEventListener('click', () => {
    const fm = parseInt($('#cuFocusMin').value) || 0;
    const fs = parseInt($('#cuFocusSec').value) || 0;
    const s = parseInt($('#cuShort').value) || 0;
    const l = parseInt($('#cuLong').value) || 0;
    const focusSec = fm*60 + Math.max(0,Math.min(59,fs));
    S.durations = {
      focus: Math.max(60,Math.min(36000,focusSec)),
      short: Math.max(60,Math.min(7200, s*60)),
      long: Math.max(60,Math.min(10800, l*60))
    };
    S.opts.longEvery = Math.max(1, Math.min(12, parseInt($('#cuLongEvery').value) || 4));
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
  // 沉浸式全屏
  $('#btnFullscreen').addEventListener('click', openFS);
  $('#fsTap').addEventListener('click', () => { S.running ? pauseTimer() : startTimer(); });
  $('#fsExit').addEventListener('click', closeFS);
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
  // 切出回来：保存理由并继续（必填理由，不可跳过/关闭）
  $('#btnBackFocus').addEventListener('click', saveBackReason);
  // 切出 chip：点击打开记录管理
  $('#chipQuit').addEventListener('click', () => { loadQuitList(); openModal('quitModal'); });
  $('#quitRefresh').addEventListener('click', loadQuitList);
  // 启动页进入
  $('#bootEnter').addEventListener('click', () => {
    $('#bootLayer').classList.add('hide');
    render();
    refreshAll();
  });
  // 退出按钮（黑屏关机）
  $('#btnQuit').addEventListener('click', doQuit);
  // 退出黑屏点击恢复
  $('#shutdownLayer').addEventListener('click', cancelQuit);
  // 删除切出记录确认
  $('#delQuitCancel').addEventListener('click', () => closeModal('delQuitModal'));
  $('#delQuitConfirm').addEventListener('click', async () => {
    const id = window._delQuitId;
    const reason = $('#delQuitReason').value.trim();
    if (!reason) { $('#delQuitReason').focus(); toast('请填写删除理由','warn'); return; }
    const r = await api('/api/quit_logs/'+id, { method:'DELETE', body:{ reason } });
    closeModal('delQuitModal');
    if (r.ok) { toast('已删除','ok'); refreshAll(); loadQuitList(); }
    else toast(r.error||'删除失败','err');
  });
  // 切出热力图刷新
  $('#quitHmRefresh').addEventListener('click', renderQuitHeatmap);
}

// ---- 启动 ----
bindEvents();
buildRingTicks();
render();
maybeResume();
refreshAll();
// 每 5 分钟自动刷新（后台静默）
setInterval(() => { if (!document.hidden) refreshAll(); }, 300000);

console.log('DLPromo · ТОМАТО-ЧАСЫ 已启动');
