'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const code=fs.readFileSync(__dirname+'/../dashboard.js','utf8');
const html=fs.readFileSync(__dirname+'/../dashboard.html','utf8');
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1]);
let checks=0;
function equal(a,b,label){assert.equal(a,b,label);checks++}
const wait=()=>new Promise(resolve=>setImmediate(resolve));
function mock(responses){
 const controls=new Map();
 function element(id){const self={id,value:'',checked:false,disabled:false,textContent:'',className:'',children:[],listeners:new Map(),appendChild(child){this.children.push(child)},addEventListener(type,cb){this.listeners.set(type,cb)},async fire(type='click'){return this.listeners.get(type)?.()},click(){return this.fire('click')},setAttribute(){}};return self;}
 for(const id of ids)controls.set(id,element(id));
 const $=id=>{if(!controls.has(id))throw Error('Missing element '+id);return controls.get(id)};
 $('category').value='wall';$('maxBatch').value='0';$('delayMs').value='2000';$('consent').checked=true;
 const page={id:11,url:'https://vk.ru/feed?filter=wall&section=likes',windowId:5};
 const msgs=[];
 let tabState={mode:'idle',category:'wall',inReactions:true,visible:4,attempts:0,log:[],selectorMatches:[]};
 const chrome={tabs:{query:async()=>[page],get:async()=>page,update:async()=>page,reload:async()=>{},sendMessage:async(id,m)=>({ok:true,state:tabState})},
  runtime:{id:'ext',getURL:p=>'chrome-extension://ext/'+p,sendMessage:async m=>{msgs.push(m);if(m.kind==='VKLC_STOP_BATCH')return {ok:true,stopping:true};if(m.kind==='VKLC_START_BATCH'){
     const result=responses.shift();if(!result)throw Error('No more chunks expected');
     return typeof result==='function'?result(m):result;
    }return {ok:false,error:'unknown'};}},windows:{update:async()=>{}},storage:{local:{get:async()=>({})}},scripting:{executeScript:async()=>{}}};
 const document={getElementById:$,createElement:()=>element('dynamic')};
 const window={addEventListener(){}};
 const context=vm.createContext({document,window,chrome,URL,Date,console,Promise,confirm:()=>true,setTimeout:fn=>{setImmediate(fn)},setInterval:()=>{},navigator:{clipboard:{writeText:async()=>{}}},Blob:function(){},Object});
 vm.runInContext(code,context,{filename:'dashboard.js'});
 return {context,$,msgs,chrome,tabState};
}
async function settled(x,condition,message){for(let i=0;i<100;i++){await wait();if(condition())return;}throw Error('Timeout '+message);}
(async()=>{
 let x=mock([{ok:true,done:10,exhausted:false},{ok:true,done:2,exhausted:true,reason:'No new reactions'}]);
 await settled(x,()=>vm.runInContext('state.data!==null && !!state.tab',x.context),'initial connection');
 equal(x.$('start').disabled,false,'can start unlimited on valid VK tab');
 equal(x.$('autoScroll').checked,true,'unlimited mode forces scrolling');
 equal(x.$('autoScroll').disabled,true,'cannot turn off required scrolling');
 await x.$('start').fire();
 await settled(x,()=>!vm.runInContext('state.continuousActive',x.context)&&x.msgs.filter(m=>m.kind==='VKLC_START_BATCH').length===2,'two chunks finished');
 equal(vm.runInContext('state.continuousDone',x.context),12,'continuous count aggregates both chunks');
 equal(vm.runInContext('state.continuousChunks',x.context),2,'continuous counts chunks');
 equal(x.msgs.filter(m=>m.kind==='VKLC_START_BATCH').every(m=>m.amount===10&&m.autoScroll===true&&m.continuous===true),true,'only small safe chunks');
 equal(x.$('start').disabled,false,'can start new deliberate session');
 let resolvePending;
 x=mock([()=>new Promise(resolve=>{resolvePending=resolve}),{ok:true,done:2,exhausted:true}]);
 await settled(x,()=>vm.runInContext('state.data!==null && !!state.tab',x.context),'pause initial connection');
 await x.$('start').fire();
 await settled(x,()=>Boolean(resolvePending),'pending chunk exists');
 await x.$('pause').fire();
 equal(x.msgs.some(m=>m.kind==='VKLC_STOP_BATCH'),true,'pause signals stopping active batch');
 resolvePending({ok:true,done:3,stopped:true});
 await settled(x,()=>!vm.runInContext('state.batchRunning',x.context),'paused chunk settled');
 equal(vm.runInContext('state.continuousPaused',x.context),true,'session paused');
 equal(vm.runInContext('state.continuousActive',x.context),true,'session can resume');
 equal(vm.runInContext('state.continuousDone',x.context),3,'pause preserves work');
 await x.$('resume').fire();
 await settled(x,()=>!vm.runInContext('state.continuousActive',x.context),'resumed session finished');
 equal(vm.runInContext('state.continuousDone',x.context),5,'resume continues same aggregate');
 equal(x.msgs.filter(m=>m.kind==='VKLC_START_BATCH').length,2,'resume no replay of first chunk');
 // Stopping a session while a chunk is outstanding cannot start a second chunk.
 x=mock([()=>new Promise(resolve=>{resolvePending=resolve})]);
 await settled(x,()=>vm.runInContext('state.data!==null && !!state.tab',x.context),'stop initial connection');
 await x.$('start').fire();
 await settled(x,()=>Boolean(resolvePending),'pending stop chunk exists');
 await x.$('stop').fire();
 resolvePending({ok:true,done:1,stopped:true});
 await settled(x,()=>!vm.runInContext('state.batchRunning',x.context),'stopped chunk settled');
 equal(vm.runInContext('state.continuousActive',x.context),false,'stop final');
 equal(vm.runInContext('state.continuousDone',x.context),1,'stop counts finished click');
 equal(x.msgs.filter(m=>m.kind==='VKLC_START_BATCH').length,1,'stop not followed by another batch');
 // The user can still choose the original finite batch.
 x=mock([{ok:true,done:3,exhausted:false}]);
 await settled(x,()=>vm.runInContext('state.data!==null && !!state.tab',x.context),'manual initial connection');
 x.$('maxBatch').value='3';
 vm.runInContext('render()',x.context);
 equal(x.$('autoScroll').disabled,false,'manual scrolling optional');
 await x.$('start').fire();
 await settled(x,()=>x.msgs.some(m=>m.kind==='VKLC_START_BATCH'),'finite batch sent');
 equal(x.msgs.find(m=>m.kind==='VKLC_START_BATCH').continuous,undefined,'manual not marked unlimited');
 console.log('PASS dashboard v0.2.6: '+checks+' assertions');
})().catch(e=>{console.error(e);process.exitCode=1});
