'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const src=fs.readFileSync(__dirname+'/../content.js','utf8');
let checks=0;
const eq=(a,b,n)=>{assert.equal(a,b,n);checks++};
function environment({category='wall',role=true,testid=true,obstruct=false}={}){
 let listener, active=true, actionNull=false, dialog=false, clicks=0,scroll=0, shifted=false, challenge=false, challengeText=false;
 const handlers=new Map();
 const element={tagName:'DIV',isConnected:true,
   classList:{contains:s=>s==='vkuiInternalTappable',[Symbol.iterator]:function*(){yield 'vkuiInternalTappable'}},
   matches:s=>s==='button,[role="button"],a',
   getAttribute(k){if(k==='aria-label')return actionNull?null:(active?'Убрать реакцию':'Поставить реакцию');
     if(k==='role')return role?'button':null;
     if(k==='data-testid')return testid?'like-button':'comment';return null;},
   getClientRects:()=>[{}],getBoundingClientRect:()=>({left:100+(shifted?30:0),top:200,width:100,height:40}),
   scrollIntoView:()=>{scroll++}, contains:target=>target===element||target===child,
   click:()=>{clicks++;throw Error('DOM click prohibited');}};
 const child={tagName:'SPAN',parentElement:element};
 const overlay={getClientRects:()=>[{}]};
 const captcha={getClientRects:()=>[{}]};
 const captchaText={getClientRects:()=>[{}],textContent:'Подтвердите, что вы не робот'};
 const scroller={scrollTop:0,scrollHeight:5000};
 const doc={scrollingElement:scroller,
   querySelectorAll(s){if(s.startsWith('iframe[src*="captcha" i]'))return challenge?[captcha]:[];
     if(s==='label,[role="checkbox"],[role="dialog"],[role="alertdialog"],[aria-modal="true"]')return challengeText?[captchaText]:[];
     if(s==='[role="dialog"],[role="menu"]')return dialog?[overlay]:[];
     if(s.includes('[aria-label]')||s.includes('[title]'))return [element];return []},
   elementFromPoint:()=>obstruct?overlay:child,
   addEventListener:(k,f)=>handlers.set(k,f),
   removeEventListener:(k,f)=>{if(handlers.get(k)===f)handlers.delete(k)},
   documentElement:{scrollHeight:1000},body:{scrollHeight:1000}};
 const chrome={runtime:{onMessage:{addListener:f=>listener=f}},storage:{local:{set(){}}}};
 vm.runInNewContext(src,{document:doc,window:{innerWidth:1400,innerHeight:800,scrollBy:({top})=>{scroller.scrollTop+=top;}},chrome,
   location:{href:`https://vk.ru/feed?filter=${category}&section=likes`},URL,Date,console,setTimeout:(fn)=>setImmediate(fn),clearTimeout:()=>{},Promise},{filename:'content.js'});
 const ask=(cmd,more={})=>new Promise(resolve=>listener({scope:'VKLC',cmd,...more},{},resolve));
 function fire(type,trusted=true){handlers.get(type)?.({type,isTrusted:trusted,target:child,button:0});}
 return {ask,fire,settings:{set active(v){active=v},set actionNull(v){actionNull=v},set dialog(v){dialog=v},set obstruct(v){obstruct=v},set shifted(v){shifted=v},set challenge(v){challenge=v},set challengeText(v){challengeText=v}},
  get clicks(){return clicks},get scroll(){return scroll},get handlers(){return handlers}};
}
(async()=>{
 for(const category of ['wall','video','clips','wall_reply','all']){
  const x=environment({category});eq((await x.ask('scan')).state.visible,1,`${category}: reactions scan`);
  eq((await x.ask('start')).ok,false,'legacy start unavailable');
 }
 const config=environment();
 eq((await config.ask('batchSettings',{delayMs:2000})).ok,true,'2sec turbo setting accepted');
 eq((await config.ask('ping')).state.delay,2000,'2sec setting reflected in report');
 eq((await config.ask('batchSettings',{delayMs:3000})).ok,true,'3sec setting accepted');
 eq((await config.ask('ping')).state.delay,3000,'3sec setting reflected in report');
 eq((await config.ask('batchSettings',{delayMs:5000})).ok,true,'5sec mode accepted');
 eq((await config.ask('ping')).state.delay,5000,'5sec setting reflected in report');
 eq((await config.ask('batchSettings',{delayMs:1000})).ok,false,'1sec mode rejected');
 eq((await config.ask('batchSettings',{delayMs:0})).ok,false,'zero delay rejected');
 eq((await config.ask('batchSettings',{delayMs:1500})).ok,false,'fractional rapid mode rejected');
 // Turbo mode may exit after 2100ms only when two temporally separated
 // observations of the same connected control agree and the menu is closed.
 const fast=environment();
 eq((await fast.ask('batchSettings',{delayMs:2000})).ok,true,'turbo enabled');
 eq((await fast.ask('nativePrepare')).ok,true,'turbo prepare');
 eq((await fast.ask('nativeArmed')).ok,true,'turbo armed');
 fast.fire('pointerdown');fast.fire('pointerup');fast.fire('click');fast.settings.actionNull=true;
 const fastResult=await fast.ask('nativeComplete',{pressed:true,cursorParked:true});
 eq(fastResult.state.suspected,1,'turbo result remains probable');
 eq(fastResult.state.lastAttempt.samples.length,4,'fast exit at 2100ms');
 eq(fastResult.state.lastAttempt.verification.completedAtMs,2100,'fast verification timestamp');
 eq(fastResult.state.lastAttempt.verification.earlyExit,true,'early exit marked');
 eq(fastResult.state.lastAttempt.trustedTargetClick,true,'turbo still requires trusted click');
 const slow=environment();
 eq((await slow.ask('batchSettings',{delayMs:3000})).ok,true,'full verification enabled');
 eq((await slow.ask('nativePrepare')).ok,true,'full prepare');
 eq((await slow.ask('nativeArmed')).ok,true,'full armed');
 slow.fire('pointerdown');slow.fire('pointerup');slow.fire('click');slow.settings.actionNull=true;
 const slowResult=await slow.ask('nativeComplete',{pressed:true,cursorParked:true});
 eq(slowResult.state.lastAttempt.samples.length,6,'3sec still full verification');
 eq(slowResult.state.lastAttempt.verification.completedAtMs,4500,'standard needs 4500ms');
 eq(slowResult.state.lastAttempt.verification.earlyExit,false,'standard no early exit');
 const quickOverlay=environment();
 eq((await quickOverlay.ask('batchSettings',{delayMs:2000})).ok,true,'turbo with overlay enabled');
 eq((await quickOverlay.ask('nativePrepare')).ok,true,'overlay turbo prepare');
 eq((await quickOverlay.ask('nativeArmed')).ok,true,'overlay turbo armed');
 quickOverlay.fire('pointerdown');quickOverlay.fire('pointerup');quickOverlay.fire('click');
 quickOverlay.settings.actionNull=true;quickOverlay.settings.dialog=true;
 const overlayResult=await quickOverlay.ask('nativeComplete',{pressed:true,cursorParked:true});
 eq(overlayResult.state.lastAttempt.verification.earlyExit,false,'overlay cannot cause early exit');
 eq(overlayResult.state.lastAttempt.samples.length,6,'overlay falls back full wait');
 eq(overlayResult.state.failed,1,'overlay stops batch on uncertainty');
 const quickUntrusted=environment();
 eq((await quickUntrusted.ask('batchSettings',{delayMs:2000})).ok,true,'turbo untrusted scenario');
 eq((await quickUntrusted.ask('nativePrepare')).ok,true,'untrusted prepare');
 eq((await quickUntrusted.ask('nativeArmed')).ok,true,'untrusted armed');
 quickUntrusted.settings.actionNull=true;
 const untrustedResult=await quickUntrusted.ask('nativeComplete',{pressed:true,cursorParked:true});
 eq(untrustedResult.state.failed,1,'fast state change with no trusted click is rejected');
 eq(untrustedResult.state.suspected,0,'fast untrusted not counted probable');
 const x=environment();eq((await x.ask('batchSettings',{delayMs:3000})).ok,true,'legacy full-check scenario');const prep=await x.ask('nativePrepare');
 eq(prep.ok,true,'real trace button prepared');eq(prep.x,135,'manual X is 35%');eq(prep.y,210,'manual Y is 25%');
 eq(prep.parkX,1384,'safe pointer parking X');eq(prep.parkY,784,'safe pointer parking Y');
 eq(x.scroll,1,'scroll to center');
 x.settings.dialog=true;eq((await x.ask('nativeArmed')).ok,true,'hover dialog not inherently blocked');
 x.fire('pointerdown');x.fire('pointerup');x.fire('click');x.settings.dialog=false;x.settings.active=false;
 const r=await x.ask('nativeComplete',{pressed:true});
 eq(r.state.removed,1,'explicit stable add transition counted');eq(r.state.lastAttempt.trustedTargetClick,true,'trusted target click');
 eq(r.state.lastAttempt.pointerDown,1,'pointer down trusted');eq(r.state.lastAttempt.pointerUp,1,'pointer up trusted');
 eq(r.state.lastAttempt.samples.length,6,'samples stored');eq(r.state.mode,'limit','one click limit');
 eq((await x.ask('nativePrepare')).ok,false,'removed only candidate not reused');eq(x.clicks,0,'no DOM clicks');
 const y=environment();eq((await y.ask('nativePrepare')).ok,true,'prepare obstruction scenario');
 y.settings.dialog=true;y.settings.obstruct=true;
 eq((await y.ask('nativeArmed')).ok,false,'occlusion blocks before click');
 eq((await y.ask('nativeAbort',{reason:'blocked',pressed:false})).state.lastAttempt.result,'cancelled-before-click','safe abort');
 eq(y.clicks,0,'no DOM click on obstruction');
 const z=environment();eq((await z.ask('nativePrepare')).ok,true,'prepare movement scenario');
 z.settings.shifted=true;eq((await z.ask('nativeArmed')).ok,false,'movement blocks');
 const m=environment();eq((await m.ask('nativePrepare')).ok,true,'probable scenario');
 eq((await m.ask('nativeArmed')).ok,true,'uncertain armed');
 m.fire('pointerdown');m.fire('pointerup');m.fire('click');m.settings.actionNull=true;
 const u=await m.ask('nativeComplete',{pressed:true,cursorParked:true});
 eq(u.state.removed,0,'null action is not explicit confirmation');
 eq(u.state.suspected,1,'null action with clear overlays counted as probable');
 eq(u.state.lastAttempt.result,'probable','separate probable status');
 eq(u.state.lastAttempt.cursorParked,true,'cursor parking recorded');
 const noPark=environment();eq((await noPark.ask('nativePrepare')).ok,true,'no pointer parking scenario');
 eq((await noPark.ask('nativeArmed')).ok,true,'no parking armed');
 noPark.fire('pointerdown');noPark.fire('pointerup');noPark.fire('click');noPark.settings.actionNull=true;
 const np=await noPark.ask('nativeComplete',{pressed:true,cursorParked:false});
 eq(np.state.suspected,0,'unparked ambiguous reaction not probable');
 eq(np.state.failed,1,'unparked ambiguous reaction stops');
 const overlay=environment();eq((await overlay.ask('nativePrepare')).ok,true,'open menu scenario');
 eq((await overlay.ask('nativeArmed')).ok,true,'open menu arm');
 overlay.fire('pointerdown');overlay.fire('pointerup');overlay.fire('click');
 overlay.settings.actionNull=true;overlay.settings.dialog=true;
 const unclear=await overlay.ask('nativeComplete',{pressed:true});
 eq(unclear.state.suspected,0,'menu left open is not probable');
 eq(unclear.state.failed,1,'unclear attempt blocks');
 // Once a button is acted on, never target that DOM node a second time.
 const multi=environment();
 eq((await multi.ask('nativePrepare')).ok,true,'prepare for anti-double click');
 eq((await multi.ask('nativeArmed')).ok,true,'arm once');
 multi.fire('pointerdown');multi.fire('pointerup');multi.fire('click');
 multi.settings.active=false;
 eq((await multi.ask('nativeComplete',{pressed:true})).state.removed,1,'one saved result');
 multi.settings.active=true;
 eq((await multi.ask('nativePrepare')).ok,false,'same DOM button cannot be clicked again');
 // Autoscroll refuses to move while a click is armed.
 const sc=environment();eq((await sc.ask('nativePrepare')).ok,true,'scroll test setup');
 eq((await sc.ask('nativeArmed')).ok,true,'scroll test armed');
 eq((await sc.ask('advanceFeed')).ok,false,'no scroll during press');
 const empty=environment();empty.settings.active=false;
 const move=await empty.ask('advanceFeed');eq(move.ok,true,'scroll request accepted');eq(move.moved,true,'scroll movement detected');eq(move.state.scrolls,1,'scroll count kept');eq(move.count,0,'scroll alone does not claim new likes');
 for(let i=1;i<60;i++)eq((await empty.ask('advanceFeed')).ok,true,'scroll under limit');
 eq((await empty.ask('advanceFeed')).ok,false,'61st scroll refused');
 const noRole=environment({role:false});eq((await noRole.ask('nativePrepare')).ok,false,'exact role necessary');
 const noTest=environment({testid:false});eq((await noTest.ask('nativePrepare')).ok,false,'exact testid necessary');
 const infinite=environment();infinite.settings.active=false;
 eq((await infinite.ask('batchSettings',{delayMs:3000,continuous:true})).ok,true,'continuous flag set');
 for(let i=0;i<66;i++)eq((await infinite.ask('advanceFeed')).ok,true,'continuous mode can scroll past 60 while still moving');
 eq((await infinite.ask('ping')).state.scrolls,66,'scrolls aggregated beyond old cap');
 eq((await infinite.ask('batchFinish',{reason:'Test complete'})).ok,true,'chunk finish accepted');
 eq((await infinite.ask('advanceFeed')).ok,false,'regular cap restored between chunks');
 eq((await infinite.ask('batchSettings',{delayMs:3000,continuous:true})).ok,true,'next continuous chunk re-enables scrolling');
 eq((await infinite.ask('advanceFeed')).ok,true,'next chunk continues from current scroll');
 eq((await infinite.ask('reset')).ok,true,'reset accepted');
 eq((await infinite.ask('ping')).state.scrolls,0,'reset clears tab scroll counter');
 const human=environment();human.settings.challenge=true;
 eq((await human.ask('checkVerification')).verificationRequired,true,'captcha selector detected');
 eq((await human.ask('ping')).state.mode,'verification','captcha state latched');
 eq((await human.ask('nativePrepare')).ok,false,'no click preparation during captcha');
 human.settings.challenge=false;eq((await human.ask('checkVerification')).ok,false,'does not silently auto-resume');
 const textHuman=environment();textHuman.settings.challengeText=true;
 eq((await textHuman.ask('checkVerification')).verificationRequired,true,'captcha dialog text detected');
 const armHuman=environment();eq((await armHuman.ask('nativePrepare')).ok,true,'preparing before captcha');
 armHuman.settings.challenge=true;eq((await armHuman.ask('nativeArmed')).ok,false,'captcha blocks armed click');
 const during=environment();eq((await during.ask('nativePrepare')).ok,true,'prepare before late captcha');
 eq((await during.ask('nativeArmed')).ok,true,'arm before late captcha');
 during.fire('pointerdown');during.fire('pointerup');during.fire('click');during.settings.challenge=true;
 const stopped=await during.ask('nativeComplete',{pressed:true,cursorParked:true});
 eq(stopped.state.lastAttempt.result,'verification','captcha during verification interrupts');
 eq(stopped.state.suspected,0,'not counted on interrupted click');
 eq(stopped.state.mode,'verification','requires human intervention');
 console.log('PASS v0.2.6 content: '+checks+' assertions');
})().catch(e=>{console.error(e);process.exitCode=1});
