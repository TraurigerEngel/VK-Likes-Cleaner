/* VK Likes Cleaner v0.2.6 — bounded chunks for continuous mode through native Chromium input. */
'use strict';
const runs = new Map();
const PROGRESS_KEY='vklc.progress.v022';
const MAX_SCROLLS=60;
const MAX_IDLE_SCROLLS=4;
// Keep a bounded aggregate only: no URLs, post IDs, cookies, tokens or post texts.
async function recordOutcome(category,result) {
  const stored=await chrome.storage.local.get(PROGRESS_KEY);
  const progress=stored?.[PROGRESS_KEY] || {version:'0.2.2',categories:{}};
  const row=progress.categories[category] || {confirmed:0,probable:0};
  if(result==='confirmed') row.confirmed++;
  else if(result==='probable') row.probable++;
  else throw Error('Only verified outcomes may be saved.');
  progress.categories[category]=row;
  progress.updatedAt=new Date().toISOString();
  await chrome.storage.local.set({[PROGRESS_KEY]:progress});
}

const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
const routeOK = url => {
  try { const u=new URL(url); return u.protocol==='https:' && ['vk.ru','vk.com'].includes(u.hostname) &&
    u.pathname.replace(/\/$/,'')==='/feed' && u.searchParams.get('section')==='likes' &&
    ['all','wall','wall_reply','clips','video'].includes(u.searchParams.get('filter')||'all'); }
  catch { return false; }
};
chrome.action.onClicked.addListener(async()=>{
  const url=chrome.runtime.getURL('dashboard.html');
  const tabs=await chrome.tabs.query({});
  const existing=tabs.find(t=>t.url===url);
  if(existing?.id){await chrome.tabs.update(existing.id,{active:true});
    if(existing.windowId) await chrome.windows.update(existing.windowId,{focused:true});}
  else await chrome.tabs.create({url});
});
const cmd=async (tabId,name,extra={})=>{
  const res=await chrome.tabs.sendMessage(tabId,{scope:'VKLC',cmd:name,...extra});
  if(!res?.ok) throw Error(res?.error||'Нет ответа от вкладки ВК.');
  return res;
};
// Challenge detection runs before every scroll and every click. It never
// interacts with CAPTCHA and never automatically resumes after a challenge.
async function guardHumanCheck(tabId) {
  const response=await chrome.tabs.sendMessage(tabId,{scope:'VKLC',cmd:'checkVerification'});
  if(!response?.ok){
    const error=Error(response?.error||'Требуется ручная проверка ВК.');
    error.verificationRequired=response?.verificationRequired===true;
    throw error;
  }
}
const mouse=(target,type,x,y,button,buttons,clickCount)=>{
  if(!['mouseMoved','mousePressed','mouseReleased'].includes(type)) throw Error('Invalid mouse event');
  return chrome.debugger.sendCommand(target,'Input.dispatchMouseEvent',{
    type,x,y,button,buttons,clickCount,modifiers:0,pointerType:'mouse'});
};
async function verifyTab(tabId,category) {
  const tab=await chrome.tabs.get(tabId);
  if(!routeOK(tab?.url)) throw Error('Вкладка ВК покинула раздел реакций.');
  const parsed=new URL(tab.url);
  if((parsed.searchParams.get('filter')||'all')!==category) throw Error('Изменилась категория реакций.');
  const active=await chrome.tabs.query({active:true,windowId:tab.windowId});
  if(!active.some(t=>t.id===tabId)) throw Error('Вкладка ВК больше не активна. Порция остановлена.');
  return tab;
}
async function oneTap(tabId,category) {
  const target={tabId}; let attached=false,pressed=false,released=false,sent=false,pos=null,cursorParked=false;
  try {
    await verifyTab(tabId,category);
    await guardHumanCheck(tabId);
    const prepared=await cmd(tabId,'nativePrepare');
    pos={x:prepared.x,y:prepared.y};
    await chrome.debugger.attach(target,'1.3');attached=true;
    await mouse(target,'mouseMoved',pos.x,pos.y,'none',0,0);
    await sleep(240);
    await verifyTab(tabId,category);
    await guardHumanCheck(tabId);
    const ready=await cmd(tabId,'nativeArmed');
    if(Math.abs(ready.x-pos.x)>3 || Math.abs(ready.y-pos.y)>3)
      throw Error('Кнопка реакции сместилась. Клик отменён.');
    await mouse(target,'mousePressed',pos.x,pos.y,'left',1,1);pressed=true;sent=true;
    await mouse(target,'mouseReleased',pos.x,pos.y,'left',0,1);released=true;
    // Release is complete: park the cursor away from the hover-reaction menu.
    // No further press/release events; any failure leaves the result unverified.
    if(Number.isFinite(ready.parkX)&&Number.isFinite(ready.parkY)) {
      try {
        await mouse(target,'mouseMoved',ready.parkX,ready.parkY,'none',0,0);
        cursorParked=true;
      } catch (_) { cursorParked=false; }
    }
  } catch(error) {
    if(pressed&&!released&&attached&&pos){
      try{await mouse(target,'mouseReleased',pos.x,pos.y,'left',0,1);released=true;}catch{}
    }
    try{await cmd(tabId,'nativeAbort',{reason:'Порция остановлена: '+String(error?.message||error),pressed:sent});}catch{}
    throw error;
  } finally {
    if(attached) try{await chrome.debugger.detach(target);}catch{}
  }
  const result=await cmd(tabId,'nativeComplete',{pressed:sent&&released,cursorParked});
  await guardHumanCheck(tabId);
  return result.state?.lastAttempt?.result||'unknown';
}
async function batch(tabId,amount,category,autoScroll=false,delayMs=2000,continuous=false,ownerTabId=null) {
  if(!Number.isSafeInteger(tabId)||runs.size>0) throw Error('Порция уже запущена. Дождитесь завершения или остановите её.');
  if(continuous ? amount!==10 : ![1,3,10,25].includes(amount)) throw Error('Неверный размер порции (в режиме «До конца» — внутренние шаги по 10).');
  if(continuous && !autoScroll) throw Error('Для режима «До конца» нужна автопрокрутка.');
  if(typeof autoScroll!=='boolean') throw Error('Некорректный режим прокрутки.');
  if(![2000,3000,5000].includes(delayMs)) throw Error('Допустимы только паузы 2, 3 и 5 секунд.');
  if(!['all','wall','wall_reply','clips','video'].includes(category)) throw Error('Некорректная категория.');
  // Reserve synchronously before any await: concurrent dashboard messages cannot
  // pass the same has(tabId) check and double-click one reaction.
  const job={stop:false,ownerTabId};runs.set(tabId,job);
  let done=0, attemptStarted=false, stopReason='Порция завершена. Обновите ВК и проверьте снятые реакции.';
  let scrolls=0,idleScrolls=0;
  try {
    if(!chrome.debugger?.attach || !chrome.debugger?.sendCommand) throw Error('API отладки недоступен.');
    if(!await chrome.permissions.contains({permissions:['debugger']})) throw Error('Нет разрешения «Отладка».');
    const tab=await chrome.tabs.get(tabId);
    if(!routeOK(tab?.url)) throw Error('Нужен раздел реакций ВК.');
    if((new URL(tab.url).searchParams.get('filter')||'all')!==category) throw Error('Открыт другой раздел ВК.');
    await guardHumanCheck(tabId);
    const current=await cmd(tabId,'ping');
    if(current.state?.mode==='blocked') throw Error('Предыдущая попытка не подтверждена. Сначала проверьте результат и перезагрузите ВК.');
    if(!continuous && Number(current.state?.attempts||0)+amount>25) throw Error('Сумма предыдущих и выбранных попыток превышает 25. Перезагрузите вкладку ВК.');
    await cmd(tabId,'batchSettings',{delayMs,continuous});
    if(job.stop) {return {ok:true,done,stopped:true,reason:'Остановлено до первого клика.'};}
    await chrome.tabs.update(tabId,{active:true});
    if(tab.windowId) await chrome.windows.update(tab.windowId,{focused:true});
    for(let i=0;i<amount;i++){
      if(job.stop){stopReason='Остановлено по запросу. Проверьте последний лайк вручную.';break;}
      if(i>0){
        for(let ms=0;ms<delayMs;ms+=250){if(job.stop)break;await sleep(250);}
        if(job.stop){stopReason='Остановлено перед следующим нажатием.';break;}
      }
      await verifyTab(tabId,category);
      await guardHumanCheck(tabId);
      // Prefer existing eligible reactions; scroll ONLY if none remain in the DOM.
      let availability=await cmd(tabId,'eligible');
      if(!availability.count && autoScroll){
        while(!availability.count && scrolls<MAX_SCROLLS && idleScrolls<MAX_IDLE_SCROLLS){
          if(job.stop)break;
          await verifyTab(tabId,category);
          await guardHumanCheck(tabId);
          const step=await cmd(tabId,'advanceFeed');
          scrolls++;
          if(!step.moved) idleScrolls++; else idleScrolls=0;
          for(let ms=0;ms<1500;ms+=250){if(job.stop)break;await sleep(250);}
          if(job.stop)break;
          await verifyTab(tabId,category);
          await guardHumanCheck(tabId);
          availability=await cmd(tabId,'eligible');
        }
      }
      if(job.stop){stopReason='Остановка до следующего клика.';break;}
      if(!availability.count){
        stopReason=autoScroll?'Доступные реакции не найдены после ограниченной прокрутки. Лента не обязательно полностью очищена.':'На загруженной странице больше нет подходящих реакций. Включите прокрутку при необходимости.';
        break;
      }
      await verifyTab(tabId,category);
      attemptStarted=true;
      const outcome=await oneTap(tabId,category);
      if(!['confirmed','probable'].includes(outcome)) {
        throw Error('После нажатия нет устойчивого признака снятия. Следующие клики запрещены.');
      }
      done++;
      try {await recordOutcome(category,outcome);}catch(e){
        throw Error('Реакция обработана, но не удалось сохранить прогресс. Проверьте результат перед продолжением. '+String(e?.message||e));
      }
    }
    try{await cmd(tabId,'batchFinish',{reason:stopReason});}catch{}
    return {ok:true,done,limit:amount,scrolls,stopped:job.stop,exhausted:!job.stop&&done<amount,reason:stopReason};
  } catch(error){
    if(attemptStarted) try{await cmd(tabId,'batchFinish',{reason:'Порция остановлена: '+String(error?.message||error)});}catch{}
    return {ok:false,done,verificationRequired: Boolean(error?.verificationRequired),error:String(error?.message||error)};
  } finally {runs.delete(tabId);}
}

// Closing the control panel must not leave a hidden cleaning job running.
chrome.tabs.onRemoved?.addListener(closedId=>{
  for(const run of runs.values()) if(run.ownerTabId===closedId) run.stop=true;
});
chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  if(!msg || !['VKLC_START_BATCH','VKLC_STOP_BATCH'].includes(msg.kind)) return;
  if(sender.id!==chrome.runtime.id || sender.url!==chrome.runtime.getURL('dashboard.html')){
    sendResponse({ok:false,error:'Доступ разрешён только панели расширения.'});return;
  }
  if(msg.kind==='VKLC_STOP_BATCH'){
    const run=runs.get(msg.tabId);
    if(run){run.stop=true;sendResponse({ok:true,stopping:true});}
    else sendResponse({ok:true,stopping:false});
    return;
  }
  batch(msg.tabId,msg.amount,msg.category,msg.autoScroll===true,msg.delayMs,msg.continuous===true,sender.tab?.id??null).then(sendResponse).catch(e=>sendResponse({ok:false,error:String(e?.message||e)}));
  return true;
});
