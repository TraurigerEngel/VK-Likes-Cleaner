'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const src=fs.readFileSync(__dirname+'/../background.js','utf8');
let checks=0;
const eq=(a,b,msg)=>{assert.equal(a,b,msg);checks++};
let handler, tabsRemoved, history=[], stored={},active=true,permission=true,armed=true,attachFails=false,
    outcome='probable', eligible=30, scrollMoves=true, autoLoad=false, attempts=0, waitTicks=[], humanVerification=false, verificationAtCheck=Infinity, checkCount=0;
const reset=(count=30)=>{history=[];stored={};active=true;permission=true;armed=true;attachFails=false;outcome='probable';eligible=count;scrollMoves=true;autoLoad=false;attempts=0;waitTicks=[];humanVerification=false;verificationAtCheck=Infinity;checkCount=0};
const chrome={
 runtime:{id:'ext',getURL:p=>'chrome-extension://ext/'+p,onMessage:{addListener:h=>handler=h}},
 action:{onClicked:{addListener(){}}},permissions:{contains:async()=>permission},
 tabs:{onRemoved:{addListener:h=>tabsRemoved=h},query:async()=>active?[{id:11}]:[],get:async()=>({url:'https://vk.ru/feed?filter=wall&section=likes',windowId:9}),update:async()=>{},
  sendMessage:async(tabId,m)=>{
   history.push('cmd:'+m.cmd);
   if(m.cmd==='ping')return {ok:true,state:{attempts}};
   if(m.cmd==='checkVerification'){checkCount++;return (humanVerification || checkCount>=verificationAtCheck)?{ok:false,verificationRequired:true,error:'ВК запросил проверку «Я не робот».'}:{ok:true};}
   if(m.cmd==='batchSettings'){history.push('settings:'+m.delayMs);return [2000,3000,5000].includes(m.delayMs)?{ok:true}:{ok:false,error:'bad delay'};}
   if(m.cmd==='eligible')return {ok:true,count:eligible};
   if(m.cmd==='advanceFeed'){
    history.push('scroll'); if(autoLoad){eligible=8;autoLoad=false}
    return {ok:true,moved:scrollMoves,count:eligible};
   }
   if(m.cmd==='nativePrepare'){attempts++;return {ok:true,x:135,y:210}}
   if(m.cmd==='nativeArmed')return armed?{ok:true,x:135,y:210,parkX:1384,parkY:784}:{ok:false,error:'overlapped'};
   if(m.cmd==='nativeComplete'){eligible=Math.max(0,eligible-1);return {ok:true,state:{lastAttempt:{result:outcome}}}}
   if(m.cmd==='nativeAbort'||m.cmd==='batchFinish')return {ok:true};
   throw Error('unexpected command '+m.cmd);
  }},
 windows:{update:async()=>{}},storage:{local:{
   get:async(key)=>key in stored?{[key]:structuredClone(stored[key])}:{},
   set:async(value)=>{Object.assign(stored,structuredClone(value));}
 }},
 debugger:{attach:async()=>{history.push('attach');if(attachFails)throw Error('not permitted')},detach:async()=>{history.push('detach')},
  sendCommand:async(_,method,args)=>{eq(method,'Input.dispatchMouseEvent','native pointer only');history.push(args.type);if(args.type==='mouseMoved'&&args.x===1384)eq(args.y,784,'mouse parking');else{eq(args.x,135,'manual X');eq(args.y,210,'manual Y');}}
 }};
vm.runInNewContext(src,{chrome,URL,Promise,console,setTimeout:(f,ms)=>{waitTicks.push(ms);setImmediate(f)},Date},{filename:'background.js'});
const sender={id:'ext',url:'chrome-extension://ext/dashboard.html'};
function request(kind,other={},who=sender){return new Promise(resolve=>handler({kind,tabId:11,...other},who,resolve))}
function run(amount=3,autoScroll=false,who=sender,delayMs=2000,continuous=false){return request('VKLC_START_BATCH',{amount,category:'wall',autoScroll,delayMs,continuous},who)}
(async()=>{
 reset();let r=await run(3);eq(r.ok,true,'3 works');eq(r.done,3,'3 handled');eq(history.filter(s=>s==='mousePressed').length,3,'3 presses');eq(history.filter(s=>s==='mouseReleased').length,3,'3 releases');eq(history.filter(s=>s==='detach').length,3,'detach each');eq(stored['vklc.progress.v022'].categories.wall.probable,3,'persist 3 per-category');
 // 2sec turbo mode: 8 × 250ms ticks between each pair of confirmed/probable attempts.
 eq(waitTicks.filter(x=>x===250).length,16,'2sec cooldown between 3 attempts, twice');
 eq(history.includes('settings:2000'),true,'turbo 2sec sent to content status');
 reset();r=await run(3,false,sender,3000);eq(r.ok,true,'3sec compatibility mode');
 eq(waitTicks.filter(x=>x===250).length,24,'3sec cooldown between 3 attempts, twice');
 eq(history.includes('settings:3000'),true,'3sec sent to content status');
 reset();r=await run(3,false,sender,5000);eq(r.ok,true,'5sec compatibility mode');
 eq(waitTicks.filter(x=>x===250).length,40,'5sec cooldown between 3 attempts, twice');
 eq(history.includes('settings:5000'),true,'5sec sent to content status');
 reset();r=await run(3,false,sender,1000);eq(r.ok,false,'too aggressive delay prohibited');eq(history.length,0,'no native input on bad delay');
 reset();r=await run(3,false,sender,0);eq(r.ok,false,'zero delay forbidden');eq(history.length,0,'zero delay no native input');
 reset(30);r=await run(10);eq(r.ok,true,'10 accepted');eq(r.done,10,'10 handled');eq(history.filter(s=>s==='mousePressed').length,10,'10 distinct presses');eq(stored['vklc.progress.v022'].categories.wall.probable,10,'persist all 10');
 reset(30);r=await run(25);eq(r.ok,true,'25 allowed');eq(r.done,25,'25 processed');eq(history.filter(s=>s==='mousePressed').length,25,'no >25');eq(stored['vklc.progress.v022'].categories.wall.probable,25,'persist all 25');
 reset();r=await run(26);eq(r.ok,false,'26 prohibited');eq(history.length,0,'no actions on invalid limit');
 reset(3);r=await run(10,false);eq(r.ok,true,'limited page finishes');eq(r.done,3,'stops when no elements');eq(history.includes('scroll'),false,'scroll OFF by default');
 reset(2);autoLoad=true;r=await run(10,true);eq(r.ok,true,'autoscroll can continue');eq(r.done,10,'ten from scrolled feed');eq(history.includes('scroll'),true,'scroll command sent');eq(history.filter(s=>s==='mousePressed').length,10,'no duplicates');
 reset(0);scrollMoves=false;r=await run(10,true);eq(r.ok,true,'idle stop is graceful');eq(r.done,0,'nothing clicked on empty feed');eq(history.filter(s=>s==='scroll').length,4,'four idle scroll stop');eq(history.includes('mousePressed'),false,'no blind clicking');
 reset(30);outcome='changed-unverified';r=await run(10,true);eq(r.ok,false,'uncertain stops');eq(r.done,0,'uncertain not counted');eq(history.filter(s=>s==='mousePressed').length,1,'uncertain never clicks again');
 reset();armed=false;r=await run(3);eq(r.ok,false,'blocked target rejects');eq(history.includes('mousePressed'),false,'no press on overlay');eq(history.includes('detach'),true,'detach after blocked');
 reset();permission=false;r=await run(3);eq(r.ok,false,'permission required');eq(history.length,0,'no actions on missing permission');
 reset();r=await run(3,false,{id:'ext',url:'https://attacker.example'});eq(r.ok,false,'sender restricted');eq(history.length,0,'no foreign origin');
 reset();active=false;r=await run(3);eq(r.ok,false,'inactive tab blocked');eq(history.includes('mousePressed'),false,'no input to background tab');
 reset();const pair=await Promise.all([run(3),run(3)]);eq(pair.filter(x=>x.ok).length,1,'one batch globally');eq(history.filter(s=>s==='mousePressed').length,3,'no overlapping presses');
 reset();const pending=run(10);const stop=await request('VKLC_STOP_BATCH');eq(stop.ok,true,'stop accepted');r=await pending;eq(r.done,0,'stop before first');eq(history.includes('mousePressed'),false,'stop leaves reactions unchanged');
 reset();attachFails=true;r=await run(3);eq(r.ok,false,'attach errors stop');eq(history.includes('mousePressed'),false,'attach error sends no input');
 reset();attempts=19;r=await run(10);eq(r.ok,false,'cannot exceed 25 per page');eq(history.includes('mousePressed'),false,'rejection before pressing');
 reset(3);r=await run(3);eq(r.ok,true,'later persisted case');eq(stored['vklc.progress.v022'].categories.wall.probable,3,'storage count correct');
 // Open-ended mode: individual messages remain bounded to ten even after
 // far more than 25 reactions on the same (unreloaded) page.
 reset(50);attempts=30;r=await run(10,true,sender,2000,true);
 eq(r.ok,true,'infinite chunk allowed after 25 on same tab');eq(r.done,10,'chunk of ten');
 eq(history.filter(s=>s==='mousePressed').length,10,'no more than ten clicks per chunk');
 eq(stored['vklc.progress.v022'].categories.wall.probable,10,'progress saved during infinite chunk');
 reset(50);r=await run(25,true,sender,2000,true);
 eq(r.ok,false,'continuous mode cannot request 25 in a chunk');eq(history.length,0,'bad infinite chunk cannot press');
 reset(50);r=await run(10,false,sender,2000,true);
 eq(r.ok,false,'continuous mode requires autoscroll');eq(history.length,0,'no clicks without autoscroll');
 reset(1);scrollMoves=false;r=await run(10,true,sender,2000,true);
 eq(r.ok,true,'continuous mode ends safely at no new reactions');eq(r.done,1,'only real reaction touched');
 eq(r.exhausted,true,'backend signals exhausted rather than re-running forever');
 eq(history.filter(s=>s==='scroll').length,4,'four idle scroll limit intact');
 reset(50);const owner={...sender,tab:{id:99}};const ownerJob=run(10,true,owner,2000,true);
 tabsRemoved(99);r=await ownerJob;
 eq(r.ok,true,'dashboard tab close gracefully stops');eq(r.done,0,'no hidden click after closing dashboard');
 eq(history.includes('mousePressed'),false,'no press after dashboard closed');
 reset(40);r=await run(10,true,sender,2000,true);eq(r.ok,true,'first chunk');
 r=await run(10,true,sender,2000,true);eq(r.ok,true,'next chunk');
 r=await run(10,true,sender,2000,true);eq(r.ok,true,'third chunk');
 eq(attempts,30,'same page can exceed 25 clicks across chunks');
 eq(stored['vklc.progress.v022'].categories.wall.probable,30,'cumulative progress across chunks');
 reset();humanVerification=true;r=await run(10,true,sender,2000,true);
 eq(r.ok,false,'human verification stops batch');eq(r.verificationRequired,true,'explicit verification reason');
 eq(r.done,0,'no unconfirmed reaction counted');eq(history.includes('mousePressed'),false,'captcha: never click');
 eq(history.includes('scroll'),false,'captcha: never scroll');
 reset();verificationAtCheck=5;r=await run(10,true,sender,2000,true);
 eq(r.ok,false,'captcha surfacing during work stops');eq(r.verificationRequired,true,'late challenge reported');
 eq(history.filter(x=>x==='mousePressed').length<=1,true,'no repeated clicks after challenge');
 console.log('PASS background v0.2.6: '+checks+' assertions');
})().catch(e=>{console.error(e);process.exitCode=1});
