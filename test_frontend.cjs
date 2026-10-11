// Run with: node --test test_frontend.cjs. No browser or npm dependencies required.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(__dirname+'/static/app.js','utf8');
function setup(names) {
  const data = new Map(), elements = new Map();
  const ctx = {console, Date, Math, JSON, Promise, globalThis: {},
    localStorage: {getItem:k=>data.get(k)||null, setItem:(k,v)=>data.set(k,v), removeItem:k=>data.delete(k)},
    $: k=>{if(!elements.has(k)) elements.set(k,{value:'',innerHTML:''});return elements.get(k)},
    readLocal:(k,f)=>{try{return JSON.parse(data.get(k))??f}catch(_){return f}},
    updateSyncStatus(){}, renderRecords(){}, loadTasks:async()=>{},
    saveSettings(){}, render(){}, syncWakeLock(){}, stopKeepalive(){}, closeProgressNotif(){},
    clearMediaSession(){}, closeModal(){}, openModal(){}, toast(){},
    loadRecords:async()=>{}, loadStats:async()=>{}, refreshAll(){}, startTimer(){},
    autoSettleDone(){}, fmtHM:String, escapeHtml:String, fmtDT:d=>d.toISOString()};
  vm.createContext(ctx);
  vm.runInContext("let S, saving=false, flushing=null, syncError=''; const TIMER_KEY='timer', PENDING_KEY='queue';",ctx);
  for(const name of names) {
    const match = new RegExp('(?:async )?function '+name+'\\(').exec(source);
    const start=match.index, end=source.indexOf('\n}',start)+2;
    vm.runInContext(source.slice(start,end),ctx);
  }
  ctx.state = value=>vm.runInContext(value,ctx);
  return {ctx,data};
}
test('concurrent sync and queue append preserve exactly one upload per session',async()=>{
  const {ctx,data}=setup(['newSessionId','flushQueue']);
  data.set('queue',JSON.stringify([{session_id:'one'}]));
  let posts=0,release;
  ctx.api=async()=>{posts++;await new Promise(r=>release=r);return {ok:true}};
  const a=ctx.flushQueue(), b=ctx.flushQueue();
  data.set('queue',JSON.stringify([{session_id:'one'},{session_id:'two'}]));
  release();await Promise.all([a,b]);
  assert.equal(posts,1);
  assert.equal(JSON.parse(data.get('queue'))[0].session_id,'two');
});
test('retry keeps the generated ID for old offline records',async()=>{
  const {ctx,data}=setup(['newSessionId','flushQueue']);
  data.set('queue',JSON.stringify([{kind:'done'}]));
  const ids=[];ctx.api=async(_,{body})=>{ids.push(body.session_id);return {ok:ids.length>1}};
  await ctx.flushQueue();await ctx.flushQueue();
  assert.ok(ids[0]);assert.equal(ids[0],ids[1]);assert.equal(data.has('queue'),false);
});
test('offline settlement advances the round and clears its timer snapshot',async()=>{
  const {ctx,data}=setup(['newSessionId','queueRecord','saveRecord','afterRecord','saveTimerState']);
  ctx.state("S={sessionId:'round-one',startedAt:new Date(),acc:10,segStart:null,round:0,durations:{short:5,long:15},opts:{}};");
  ctx.api=async()=>({ok:false,error:'无法连接后端'});
  data.set('timer','old snapshot');
  await ctx.saveRecord('done',25,25,'');
  assert.equal(ctx.state('S.mode'),'short');assert.equal(ctx.state('S.round'),1);
  assert.equal(ctx.state('S.startedAt'),null);assert.equal(data.has('timer'),false);
  assert.equal(JSON.parse(data.get('queue'))[0].session_id,'round-one');
});
test('restoration includes the running segment and retains the session ID',()=>{
  for(const legacy of [false,true]) {
    const {ctx,data}=setup(['newSessionId','maybeResume','saveTimerState']);
    const now=Date.now();ctx.Date={now:()=>now};
    // Use the real Date constructor with a deterministic now method.
    ctx.Date=class extends Date {static now(){return now}};
    ctx.state("S={durations:{focus:25},running:false,segStart:null};");
    const snap={mode:'focus',total:1500,remain:1380,running:true,endAt:now+1080000,
      acc:120,startedAt:now-420000,sessionId:'restored',round:0,task:'task'};
    if(!legacy)snap.segStart=now-300000;
    data.set('timer',JSON.stringify(snap));ctx.maybeResume();
    assert.equal(ctx.state('S.acc'),420);assert.equal(ctx.state('S.remain'),1080);
    assert.equal(ctx.state('S.sessionId'),'restored');
    assert.equal(JSON.parse(data.get('timer')).running,false);
  }
});

test('early skip retains actual runtime rather than the planned minutes',()=>{
  const {ctx}=setup(['recordSkip']);
  ctx.state("let PENDING={planned:25,elapsedMin:3};");
  let payload;ctx.saveRecord=(...args)=>{payload=args};
  ctx.recordSkip();assert.deepEqual(payload,['skip',25,3,'']);
});

function featureSetup(names) {
  const {ctx,data}=setup([]);
  const features=fs.readFileSync(__dirname+'/static/features.js','utf8');
  vm.runInContext("let TASKS=[], AUX_QUEUE_KEY='aux', auxFlushing=null;",ctx);
  ctx.newSessionId=(()=>{let n=0;return ()=>String(++n)})();
  ctx.updateTaskList=()=>{};ctx.loadFeatures=async()=>{};
  ctx.loadQuit=async()=>{};ctx.renderQuitHeatmap=async()=>{};
  for(const name of names) {
    const match=new RegExp('(?:async )?function '+name+'\\(').exec(features);
    vm.runInContext(features.slice(match.index,features.indexOf('\n}',match.index)+2),ctx);
  }
  return {ctx,data};
}
test('offline goals keep the latest edit and overlay the cached task map',()=>{
  const {ctx,data}=featureSetup(['readLocal','queueAux','taskView']);
  ctx.state("TASKS=[{name:'report',target_pomos:2,completed_pomos:1}];");
  ctx.queueAux('task',{name:'report',target_pomos:4},'PUT');
  ctx.queueAux('task',{name:'report',target_pomos:6},'PUT');
  assert.equal(JSON.parse(data.get('aux')).length,1);
  assert.equal(ctx.taskView()[0].target_pomos,6);
  ctx.queueAux('task',{name:'report'},'DELETE');
  assert.equal(ctx.taskView()[0].target_pomos,null);
  assert.equal(ctx.taskView()[0].completed_pomos,1);
});
test('reason saved during in-flight initial quit upload is not lost',async()=>{
  const {ctx,data}=featureSetup(['readLocal','queueAux','flushAuxQueue']);
  ctx.queueAux('quit',{event_id:'quit1',quit_at:'2026-10-11 14:00:00',reason:''});
  let release;ctx.api=async()=>{await new Promise(r=>release=r);return {ok:true}};
  const upload=ctx.flushAuxQueue();
  ctx.queueAux('quit',{event_id:'quit1',quit_at:'2026-10-11 14:00:00',reason:'电话'});
  release();await upload;
  assert.equal(JSON.parse(data.get('aux'))[0].payload.reason,'电话');
});
test('record is durable before the network response arrives',async()=>{
  const {ctx,data}=setup(['newSessionId','queueRecord','saveRecord','afterRecord','saveTimerState']);
  ctx.state("S={sessionId:'durable',startedAt:new Date(),acc:10,segStart:null,round:0,durations:{short:5,long:15},opts:{}};");
  let release;ctx.api=async()=>{await new Promise(r=>release=r);return {ok:true}};
  const save=ctx.saveRecord('skip',25,3,'');
  assert.equal(JSON.parse(data.get('queue'))[0].actual_minutes,3);
  release();await save;
  assert.equal(data.has('queue'),false);
  assert.equal(ctx.state('S.round'),1);
});
test('reload during settlement does not restore an already queued session',()=>{
  const {ctx,data}=setup(['maybeResume','afterRecord','saveTimerState']);
  ctx.state("S={round:0,durations:{short:5,long:15},opts:{},running:false};");
  data.set('timer',JSON.stringify({sessionId:'settled',startedAt:Date.now(),round:2}));
  data.set('queue',JSON.stringify([{session_id:'settled',kind:'skip'}]));
  ctx.maybeResume();
  assert.equal(ctx.state('S.round'),3);
  assert.equal(ctx.state('S.mode'),'short');
  assert.equal(data.has('timer'),false);
});
