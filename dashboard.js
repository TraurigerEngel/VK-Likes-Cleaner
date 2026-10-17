'use strict';
const $ = id => document.getElementById(id);
const state = { tab: null, data: null, busy: false, batchRunning: false, error: '', refreshing: false, selectedTouched: false, retryAfter: new Map(), diagnostic: null, observationReport: null, progress: null,
  continuousActive:false, continuousPaused:false, continuousStopRequested:false, continuousSession:null, continuousDone:0, continuousChunks:0, continuousReason:'' };
const ATTEMPT_RESULTS = Object.freeze({
  pending:'выполняется', armed:'клик подготовлен', confirmed:'снятие подтверждено по кнопке', probable:'вероятно снято (проверьте вручную)',
  'changed-unverified':'состояние изменилось, нужна ручная проверка',
  verification:'появилась проверка ВК — результат последнего клика не засчитан',
  unverified:'результат не подтверждён',
  disappeared:'элемент исчез, нужна ручная проверка',
  'menu-opened':'открылось меню реакций',
  'cancelled-before-click':'отменено до клика',
  'page-changed':'страница изменилась',
  interrupted:'тест прерван', error:'ошибка проверки'
});
const CATEGORIES = Object.freeze({
  all: 'Все реакции', wall: 'Записи', wall_reply: 'Комментарии', clips: 'Клипы', video: 'Видео'
});
const route = category => {
  const u = new URL('https://vk.ru/feed');
  if (category !== 'all') u.searchParams.set('filter', category);
  u.searchParams.set('section', 'likes');
  return u.href;
};
const categoryFromURL = url => {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !['vk.com', 'vk.ru'].includes(u.hostname) || u.pathname.replace(/\/$/,'') !== '/feed' || u.searchParams.get('section') !== 'likes') return null;
    const category = u.searchParams.get('filter') || 'all';
    return Object.hasOwn(CATEGORIES, category) ? category : null;
  } catch { return null; }
};
const selected = () => $('category').value;
async function findTab(preferred = selected()) {
  const tabs = await chrome.tabs.query({});
  const found = tabs.filter(t => Number.isInteger(t.id) && categoryFromURL(t.url));
  found.sort((a,b) => Number(categoryFromURL(b.url) === preferred) - Number(categoryFromURL(a.url) === preferred) || Number(b.active) - Number(a.active) || (b.lastAccessed||0) - (a.lastAccessed||0));
  return found[0] || null;
}
function setStatus(label, kind = '') {
  $('status').textContent = label;
  $('status').className = 'pill ' + kind;
  $('dot').className = 'dot ' + (kind === 'good' ? 'good' : '');
}
function format(value) { return Number(value || 0).toLocaleString('ru-RU'); }
function renderLog(log = []) {
  const root = $('log');
  root.textContent = '';
  if (!log.length) {
    const el = document.createElement('div');
    el.className = 'empty'; el.textContent = 'Журнал появится после начала обработки.';
    root.appendChild(el); return;
  }
  for (const item of log) {
    const div = document.createElement('div');
    div.className = 'entry ' + (['ok','warn'].includes(item.kind) ? item.kind : '');
    const time = document.createElement('time'); time.textContent = item.time || '';
    const message = document.createElement('span'); message.textContent = item.message || '';
    div.append(time, message); root.appendChild(div);
  }
}
function render() {
  const d = state.data;
  const mode = d?.mode || 'idle';
  const running = mode === 'running';
  const paused = mode === 'paused' || state.continuousPaused;
  const unlimited = $('maxBatch').value === '0';
  if(unlimited) $('autoScroll').checked = true;
  const match = Boolean(state.tab && d?.inReactions && d.category === selected());
  $('selectedRoute').textContent = route(selected());
  $('copyDiagnostic').disabled = !state.diagnostic;
  $('saveDiagnostic').disabled = !state.diagnostic;
  $('diagnose').disabled = state.busy || !state.tab;
  const watching = Boolean(d?.observation?.active);
  $('observeStart').disabled = state.busy || watching || !match || running || paused;
  $('observeStop').disabled = state.busy || !watching;
  $('observeSave').disabled = !state.observationReport;
  if (watching) $('observeStatus').textContent = `Наблюдение идёт · ручных нажатий: ${d.observation.clicks} · максимум 90 секунд. Перейдите в ВК и снимите ОДНУ реакцию вручную.`;

  $('removed').textContent = d ? format(d.removed) : '0';
  $('suspected').textContent = d ? format(d.suspected) : '0';
  $('visible').textContent = d ? format(d.visible) : '—';
  $('failed').textContent = d ? format(d.failed) : '0';
  $('attemptCount').textContent = d ? format(d.attempts) : '0';
  $('progressStatus').textContent = state.progress ? `Сохранено между обновлениями: ${Object.entries(CATEGORIES).map(([key,name])=>{const p=state.progress.categories?.[key];return name+': '+format((p?.confirmed||0)+(p?.probable||0));}).join(' · ')}. Числа отражают действия инструмента, не независимую проверку ВК.` : 'История обработки появится после первого успешного теста v0.2.6.';
  $('attemptStatus').textContent = d?.lastAttempt ? `Последнее нажатие: ${ATTEMPT_RESULTS[d.lastAttempt.result] || d.lastAttempt.result}. Доверенный клик по цели: ${d.lastAttempt.trustedTargetClick ? 'да' : 'нет'}. ${unlimited || state.continuousActive ? 'Режим «До конца» без ограничения числа лайков.':'Обычная порция: максимум 25 попыток на загрузку вкладки.'}` : 'Автоматическая попытка ещё не выполнялась. Сканирование ничего не удаляет.';
  $('continuousStatus').textContent = state.continuousActive ? `Режим «До конца» · обработано в этом запуске: ${format(state.continuousDone)} · внутренних порций: ${format(state.continuousChunks)} · ${state.continuousPaused?'ПАУЗА':state.continuousStopRequested?'ОСТАНОВКА…':'работает'}. Панель оставляйте открытой.` : (state.continuousReason || 'Режим «До конца» не запущен.');
  renderLog(d?.log);
  $('category').disabled = running || paused || state.busy || state.continuousActive;
  $('autoScroll').disabled = running || state.busy || unlimited || state.continuousActive;
  $('maxBatch').disabled = running || state.busy || state.continuousActive;
  $('delayMs').disabled = running || state.busy || state.continuousActive;
  $('open').disabled = running || paused || state.busy || state.continuousActive;
  $('scan').disabled = state.busy;
  $('start').disabled = Boolean(d?.verificationRequired) || !match || (!d?.visible && !$('autoScroll').checked) || !$('consent').checked || ['running','preparing'].includes(mode) || mode==='blocked' || (!unlimited && Number(d?.attempts||0)>=25) || state.busy || watching || state.continuousActive;
  $('pause').disabled = !state.continuousActive || state.continuousPaused || state.continuousStopRequested;
  $('resume').disabled = Boolean(d?.verificationRequired) || !state.continuousActive || !state.continuousPaused || state.batchRunning || state.continuousStopRequested;
  $('stop').disabled = !state.batchRunning && !state.continuousActive;
  $('reset').disabled = !state.tab || ['running','preparing','paused'].includes(mode) || state.busy || state.continuousActive;
  $('reload').disabled = !state.tab || state.busy || state.continuousActive;
  $('start').textContent = unlimited ? 'Начать очистку · До конца ∞' : `Начать порцию: ${$('maxBatch').value} ${$('maxBatch').value==='1'?'реакция':'реакций'}`;
  const selectors = Array.isArray(d?.selectorMatches) ? d.selectorMatches : [];
  $('scanDetails').textContent = !d ? 'Диагностика появится после подключения к странице.' :
    `На открытой странице: ${CATEGORIES[d.category] || 'неизвестный раздел'} · распознано активных кнопок: ${format(d.visible)}. ` +
    (selectors.length ? `Совпали признаки: ${selectors.map(x => x.selector + ' (' + x.count + ')').join('; ')}.` :
      'Если в ленте видны ваши лайки, но здесь 0 — нужна диагностика кнопок ВК.');
  if (d?.verificationRequired || mode === 'verification') {setStatus('Проверка ВК','warn');$('hint').textContent='ВК запросил «Я не робот». Автоматическая очистка прекращена. Пройдите проверку вручную в ВК, а затем обновите вкладку. Не возобновляйте автоматизацию при повторных проверках.';}
  else if (state.error) { setStatus('Требуется внимание','warn'); $('hint').textContent = state.error; }
  else if (!state.tab) { setStatus('ВК не открыт'); $('hint').textContent = 'Выберите категорию и откройте её в ВК. Для подключения войдите в свой аккаунт.'; }
  else if (!d) { setStatus('Нет соединения','warn'); $('hint').textContent = 'Вкладка найдена, но связи нет. Перезагрузите вкладку ВК и нажмите «Сканировать без удаления».'; }
  else if (!match) { setStatus('Другой раздел','warn'); $('hint').textContent = `Сейчас открыто: ${CATEGORIES[d.category] || 'неизвестная категория'}. Для работы выберите её в списке или откройте нужный раздел.`; }
  else if(state.continuousPaused) { setStatus('На паузе','warn'); $('hint').textContent = 'Новые лайки не снимаются. Нажмите «Продолжить» или «Остановить».'; }
  else if(state.continuousActive || running || mode==='preparing' || state.batchRunning) { setStatus(state.continuousActive?'Очистка до конца…':'Порция выполняется','warn'); $('hint').textContent = 'Не взаимодействуйте с ВК до окончания обработки. В режиме «До конца» можно нажать «Пауза» или «Остановить».'; }
  else if (watching) { setStatus('Наблюдение','warn'); $('hint').textContent = 'Расширение не нажимает ничего. Вручную снимите один лайк во вкладке ВК и завершите наблюдение.'; }
  else if (mode === 'blocked') { setStatus('Проверка нужна','warn'); $('hint').textContent = d.reason; }
  else if (paused) { setStatus('Пауза','warn'); $('hint').textContent = d.reason || 'На паузе. Можно продолжить или остановить.'; }
  else if (mode === 'no_match') { setStatus('Кнопки не найдены','warn'); $('hint').textContent = d.reason; }
  else if (mode === 'done') { setStatus('Лента проверена','good'); $('hint').textContent = d.reason; }
  else if (mode === 'limit') { setStatus('Порция готова','good'); $('hint').textContent = d.reason; }
  else if (mode === 'stopped') { setStatus('Остановлено'); $('hint').textContent = d.reason; }
  else { setStatus('Подключено','good'); $('hint').textContent = `В разделе «${CATEGORIES[selected()]}» найдено ${format(d.visible)} активных реакций. Выберите лимит и, если нужно, ограниченную прокрутку. После порции обязательно обновите ВК и проверьте результат. После порции проверьте реакции вручную.`; }
}
async function messageTab(cmd, extra = {}) {
  if (!state.tab) throw Error('Откройте один из разделов реакций ВК.');
  const tabId = state.tab.id;
  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, {scope:'VKLC', cmd, ...extra});
  } catch (original) {
    // Some browsers do not inject content scripts into tabs opened before an extension was installed.
    // A one-time, permission-scoped injection can recover without asking for cookies or tokens.
    if (!['ping','scan','diagnose'].includes(cmd)) throw Error('Связь со вкладкой прервана. Сканируйте страницу ещё раз.');
    const last = state.retryAfter.get(tabId) || 0;
    if (Date.now() < last) throw Error('Скрипт ещё не подключился. Обновите вкладку ВК и повторите сканирование.');
    state.retryAfter.set(tabId, Date.now() + 8000);
    try {
      await chrome.scripting.executeScript({target:{tabId},files:['content.js']});
      response = await chrome.tabs.sendMessage(tabId,{scope:'VKLC',cmd,...extra});
    } catch (_) {
      throw Error('Нет связи с вкладкой vk.ru. Перезагрузите её после обновления расширения.');
    }
  }
  if (!response?.ok) throw Error(response?.error || 'Команда не выполнена.');
  state.data = response.state;
  state.error = '';
  return response;
}
async function refresh() {
  if ((state.busy && !state.batchRunning) || state.refreshing) return;
  state.refreshing = true;
  try {
    const tab = await findTab();
    if (!tab || tab.id !== state.tab?.id) { state.data = null; state.diagnostic = null; }
    state.tab = tab;
    if (tab) {
      await messageTab('ping');
      try {const stored=await chrome.storage.local.get('vklc.progress.v022'); state.progress=stored['vklc.progress.v022']||null;}catch(_){}
      if (!state.data?.observation?.active && state.data?.observation?.clicks > 0 && !state.observationReport) {
        try { const r = await messageTab('observeReport'); state.observationReport = r.report; } catch(_) {}
      }
      if (!state.selectedTouched && state.data?.category) $('category').value = state.data.category;
    } else state.error = '';
  } catch (e) { state.data = null; state.error = e?.message || 'Неизвестная ошибка соединения.'; }
  finally { state.refreshing = false; render(); }
}
async function action(cmd, extra = {}) {
  state.busy = true; render();
  try { await messageTab(cmd, extra); }
  catch(e) { state.error = e?.message || 'Ошибка действия.'; }
  finally { state.busy = false; render(); }
}
$('category').addEventListener('change', () => {state.diagnostic = null; state.selectedTouched = true; state.data = null; state.tab = null; state.error = ''; render(); void refresh();});
$('open').addEventListener('click', async () => {
  if (state.busy) return;
  state.busy = true; render();
  try {
    const targetCategory = selected();
    const tab = await findTab(targetCategory);
    if (tab?.id && categoryFromURL(tab.url) === targetCategory) {
      await chrome.tabs.update(tab.id, {active: true});
      if (tab.windowId) await chrome.windows.update(tab.windowId,{focused:true});
    } else if (tab?.id && !['running','paused'].includes(state.data?.mode)) {
      await chrome.tabs.update(tab.id,{url:route(targetCategory),active:true});
    } else await chrome.tabs.create({url:route(targetCategory)});
    state.data = null; state.tab = null; state.selectedTouched = false; state.error = '';
  } catch(e) { state.error = e?.message || 'Не удалось открыть вкладку ВК.'; }
  finally {state.busy = false; render(); setTimeout(refresh, 1300);}
});
$('scan').addEventListener('click', () => void refresh());
$('diagnose').addEventListener('click', async () => {
  state.busy = true; render();
  try {
    const response = await messageTab('diagnose');
    state.diagnostic = response.diagnostic;
    const d = state.diagnostic;
    $('diagnosticStatus').textContent = `Найдено элементов с признаками реакций: ${d.signalElements}. Шаблонов: ${d.signalPatterns.length}. Совпадений признаков активных реакций: ${d.activeSelectors.reduce((n,x)=>n+x.count,0)}. Теперь скопируйте диагностический отчёт и пришлите его в чат.`;
  } catch (e) {
    $('diagnosticStatus').textContent = 'Ошибка: ' + (e?.message || 'неизвестная');
    state.error = e?.message || 'Ошибка диагностики';
  } finally { state.busy = false; render(); }
});
const diagnosticJSON = () => JSON.stringify(state.diagnostic, null, 2);
$('copyDiagnostic').addEventListener('click', async () => {
  if (!state.diagnostic) return;
  try {
    await navigator.clipboard.writeText(diagnosticJSON());
    $('diagnosticStatus').textContent = 'Отчёт скопирован. Вставьте его сюда в чат.';
  } catch (e) {
    $('diagnosticStatus').textContent = 'Не удалось скопировать. Нажмите «Сохранить JSON».';
  }
});
$('saveDiagnostic').addEventListener('click', () => {
  if (!state.diagnostic) return;
  const blob = new Blob([diagnosticJSON()], {type:'application/json;charset=utf-8'});
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href=href; link.download='VK-Likes-Cleaner-Diagnostics.json'; link.click();
  setTimeout(()=>URL.revokeObjectURL(href), 1000);
});
$('observeStart').addEventListener('click', async () => {
  state.busy = true; render();
  try {
    const response = await messageTab('observeStart');
    state.observationReport = null;
    $('observeStatus').textContent = 'Наблюдение начато. Во вкладке ВК вручную нажмите на одну уже поставленную реакцию. Не обновляйте вкладку.';
  } catch(e) { $('observeStatus').textContent = 'Ошибка: ' + (e?.message || 'неизвестная'); state.error = e?.message || ''; }
  finally { state.busy = false; render(); }
});
$('observeStop').addEventListener('click', async () => {
  state.busy = true; render();
  try {
    const response = await messageTab('observeStop');
    state.observationReport = response.report;
    $('observeStatus').textContent = `Наблюдение завершено. Отмечено ручных нажатий на реакции: ${response.report?.clicks?.length || 0}. Сохраните JSON и пришлите его в чат.`;
  } catch(e) { $('observeStatus').textContent = 'Ошибка: ' + (e?.message || 'неизвестная'); state.error = e?.message || ''; }
  finally { state.busy = false; render(); }
});
$('observeSave').addEventListener('click', () => {
  if (!state.observationReport) return;
  const blob = new Blob([JSON.stringify(state.observationReport,null,2)], {type:'application/json;charset=utf-8'});
  const u = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = u; a.download = 'VK-Likes-Cleaner-Manual-Trace-v2.json'; a.click();
  setTimeout(()=>URL.revokeObjectURL(u), 1000);
});
$('consent').addEventListener('change', render);
$('maxBatch').addEventListener('change',render);
$('delayMs').addEventListener('change',render);
$('autoScroll').addEventListener('change',render);
// The UI orchestrates small bounded background calls. No single MV3 message
// is held open for hours: an open dashboard requests the next 10 reactions.
const quietWait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function requestChunkStop() {
  const tabId=state.continuousSession?.tabId ?? state.tab?.id;
  if(tabId==null)return;
  try {await chrome.runtime.sendMessage({kind:'VKLC_STOP_BATCH',tabId});}
  catch(e){state.error='Не удалось передать стоп: '+String(e?.message||e);}
}
async function runContinuous() {
  const session=state.continuousSession;
  if(!session || state.batchRunning || state.continuousStopRequested) return;
  state.continuousPaused=false;state.batchRunning=true;state.busy=true;
  state.error='';render();
  try {
    while(!state.continuousStopRequested && !state.continuousPaused) {
      const tab=await chrome.tabs.get(session.tabId);
      if(state.continuousStopRequested||state.continuousPaused)break;
      if(categoryFromURL(tab.url)!==session.category)throw Error('Выбранная вкладка покинула нужный раздел ВК.');
      const result=await chrome.runtime.sendMessage({kind:'VKLC_START_BATCH',tabId:session.tabId,amount:10,category:session.category,autoScroll:true,delayMs:session.delayMs,continuous:true});
      state.continuousDone+=Number(result?.done||0);
      if(result?.ok)state.continuousChunks++;
      if(!result?.ok)throw Error(result?.error||'Очистка прервана: проверьте последний лайк.');
      try{await messageTab('ping');}catch(e){throw Error('Вкладка ВК не отвечает: '+String(e?.message||e));}
      render();
      if(state.continuousStopRequested || state.continuousPaused)break;
      if(result.stopped){state.continuousReason=result.reason||'Выполнение остановлено.';break;}
      if(result.exhausted || result.done<10){
        state.continuousReason='Не обнаружено новых доступных реакций после прокрутки. Это НЕ доказательство полной очистки истории.';
        break;
      }
      // Keep the interval between the LAST click in a chunk and the FIRST
      // click in the next chunk; the caller may pause during this cooldown.
      for(let elapsed=0;elapsed<session.delayMs;elapsed+=250){
        if(state.continuousStopRequested||state.continuousPaused)break;
        await quietWait(250);
      }
    }
  }catch(e){
    state.continuousReason='Остановлено: '+String(e?.message||e);
    state.error=state.continuousReason;
  }finally{
    state.batchRunning=false;state.busy=false;
    if(state.continuousStopRequested){
      state.continuousReason=`Остановлено пользователем. Обработано за запуск: ${format(state.continuousDone)}. Проверьте результат во ВК.`;
      state.continuousActive=false;state.continuousPaused=false;state.continuousSession=null;
    }else if(!state.continuousPaused){
      if(!state.continuousReason)state.continuousReason=`Завершено. Обработано за запуск: ${format(state.continuousDone)}. Проверьте результат во ВК.`;
      state.continuousActive=false;state.continuousSession=null;
    }
    render();void refresh();
  }
}
$('start').addEventListener('click', async () => {
  if (state.busy || state.continuousActive || !$('consent').checked || !state.tab || !state.data || state.data.category !== selected()) return;
  const amount=Number($('maxBatch').value);
  if(![0,1,3,10,25].includes(amount)) return;
  const autoScroll=amount===0 ? true : $('autoScroll').checked;
  const delayMs=Number($('delayMs').value);
  if(![2000,3000,5000].includes(delayMs) || state.data?.verificationRequired) return;
  if(amount===0){
    if(!confirm(`Запустить режим «До конца» в разделе «${CATEGORIES[selected()]}»?\n\nОбщего лимита лайков не будет. Каждая внутренняя порция — 10 нажатий с паузой ${delayMs/1000} сек., автопрокрутка обязательна. Очистка продолжится, пока появляются реакции. Остановится при ошибке, отсутствии новых реакций, смене вкладки или по кнопке «Пауза/Стоп».\n\nОставьте эту панель ОТКРЫТОЙ. Проверяйте результат после обновления ВК. Расширение использует широкое разрешение «Отладка».`))return;
    state.continuousSession={tabId:state.tab.id,category:selected(),delayMs};
    state.continuousActive=true;state.continuousPaused=false;state.continuousStopRequested=false;
    state.continuousDone=0;state.continuousChunks=0;state.continuousReason='';
    void runContinuous();return;
  }
  if(!confirm(`Начать обработку до ${amount} реакций в разделе «${CATEGORIES[selected()]}»?\n\nОтладчик Chromium отправляет по одному нажатию с паузой ${delayMs/1000} секунды. Проверка: ${delayMs===2000?'турбо, возможно раннее завершение':'полная, до 4,5 секунды'}. Автопрокрутка: ${autoScroll?'до 60 шагов':'выключена'}. После порции обновите ВК и проверьте результат.`))return;
  state.busy=true;state.batchRunning=true;state.error='';render();
  try {
    const result=await chrome.runtime.sendMessage({kind:'VKLC_START_BATCH',tabId:state.tab.id,amount,category:selected(),autoScroll,delayMs});
    if(!result?.ok) throw Error(result?.error||'Порция остановлена. Проверьте последний лайк во ВК.');
    if(result.done<amount) $('hint').textContent = result.reason || 'Видимых реакций больше не найдено.';
    await messageTab('ping');
  } catch(e) { state.error=e?.message||'Ошибка обработки. Не повторяйте без проверки.'; }
  finally {state.batchRunning=false;state.busy=false;render();void refresh();}
});
$('pause').addEventListener('click',async()=>{
  if(!state.continuousActive||state.continuousPaused)return;
  state.continuousPaused=true;render();
  if(state.batchRunning)await requestChunkStop();
});
$('resume').addEventListener('click',()=>{
  if(!state.continuousActive||!state.continuousPaused||state.batchRunning||state.continuousStopRequested)return;
  if(!state.tab||state.tab.id!==state.continuousSession?.tabId||state.data?.category!==state.continuousSession?.category){
    state.error='Для продолжения вернитесь на ту же вкладку и в тот же раздел ВК.';render();return;
  }
  state.continuousPaused=false;state.continuousReason='';void runContinuous();
});
$('stop').addEventListener('click',async()=>{
  if(state.continuousActive){
    state.continuousStopRequested=true;state.continuousPaused=false;render();
    if(state.batchRunning)await requestChunkStop();
    else{
      state.continuousActive=false;state.continuousSession=null;
      state.continuousReason=`Остановлено пользователем. Обработано: ${format(state.continuousDone)}.`;render();
    }
    return;
  }
  if(!state.batchRunning||!state.tab)return;
  try{await chrome.runtime.sendMessage({kind:'VKLC_STOP_BATCH',tabId:state.tab.id});
      $('hint').textContent='Остановка запрошена. Текущее нажатие и проверка закончатся, новые клики не начнутся.';
  }catch(e){state.error=String(e?.message||e);render();}
});
window.addEventListener('beforeunload',()=>{
  if(state.batchRunning){
    const tabId=state.continuousSession?.tabId ?? state.tab?.id;
    if(tabId!=null)void chrome.runtime.sendMessage({kind:'VKLC_STOP_BATCH',tabId});
  }
});
$('reset').addEventListener('click',()=>{
  if (confirm('Сбросить счётчики и журнал текущей вкладки? Сохранённая история по категориям останется. Снятые реакции не вернутся.')) void action('reset');
});
$('reload').addEventListener('click', async()=>{
  if (!state.tab) return;
  if (state.data?.mode === 'running' && !confirm('Перезагрузка прервёт очистку. Продолжить?')) return;
  try { await chrome.tabs.reload(state.tab.id); state.data = null; state.error=''; render(); setTimeout(refresh,1500); }
  catch(e) {state.error=e?.message || 'Перезагрузить вкладку не удалось.';render();}
});
$('export').addEventListener('click',()=>{
  const report={app:'VK Likes Cleaner', version:'0.2.6', savedAt:new Date().toISOString(), category:state.data?.category ?? null, ...state.data,
    continuousSession:{active:state.continuousActive,paused:state.continuousPaused,processed:state.continuousDone,chunks:state.continuousChunks,reason:state.continuousReason}};
  delete report.url;
  const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download='VK-Likes-Cleaner-Report-v0.2.6.json';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
});
render();
void refresh();
setInterval(refresh,1800);
