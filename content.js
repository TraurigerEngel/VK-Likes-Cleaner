/* VK Likes Cleaner v0.2.6. Supervised batches and open-ended mode; no external endpoints or credentials. */
(() => {
  'use strict';
  if (window.__VKLC_v026) return;
  window.__VKLC_v026 = true;

  // Only selectors that positively indicate an ACTIVE reaction may be used.
  // The first class is known from a public VK snippet; remaining selectors
  // are conservative fallback patterns, subject to verification on live VK.
  const ACTIVE_SELECTORS = [
    '.PostButtonReactions--active',
    '.like_btn.like_btn_active',
    '.like_btn--active',
    'button[data-testid="like-button"][aria-pressed="true"]',
    '[role="button"][data-testid="like-button"][aria-pressed="true"]',
    'button[aria-label*="Убрать реакцию"]',
    'button[aria-label*="Снять реакцию"]',
    'button[aria-label*="Remove reaction"]'
  ];
  // vk.ru October 2026: own reactions are represented as interactive <div>
  // with an aria-label such as «Убрать реакцию», not as a <button>.
  // Do not depend on obfuscated vkit-* classes recorded in diagnostic 0.1.2.
  const REMOVE_ACTION = /^\s*(?:убрать|снять|remove|unlike)\s+(?:(?:свою|мою|my)\s+)?(?:реакц|лайк|reaction|like)/iu;
  const ADD_ACTION = /^\s*(?:поставить|добавить|оставить|выбрать|add|set)\s+(?:(?:свою|мою|my)\s+)?(?:реакц|лайк|reaction|like)/iu;
  const NEUTRAL_ADD_ACTION = /^\s*(?:нравится|like)\s*$/iu;
  const SELECTOR = ACTIVE_SELECTORS.join(',') + ',[aria-label],[title]';
  function semanticAction(el) {
    if (!el?.getAttribute) return null;
    const labels = [el.getAttribute('aria-label'), el.getAttribute('title')].filter(Boolean);
    if (labels.some(label => REMOVE_ACTION.test(label))) return 'remove';
    if (labels.some(label => ADD_ACTION.test(label) || NEUTRAL_ADD_ACTION.test(label))) return 'add';
    return null;
  }
  function isInteractive(el) {
    if (!el?.isConnected) return false;
    return Boolean(el.matches?.('button,[role="button"],a') ||
      el.classList?.contains?.('vkuiInternalTappable'));
  }
  function semanticRemove(el) {
    return isInteractive(el) && semanticAction(el) === 'remove';
  }

  const storeKey = 'vklc.lastRun.v022';
  const VALID_FILTERS = new Set(['all', 'wall', 'wall_reply', 'clips', 'video']);
  const state = {
    mode: 'idle',
    removed: 0,
    suspected: 0,
    attempts: 0,
    disappeared: 0,
    failed: 0,
    scrolls: 0,
    idleScrolls: 0,
    startedAt: null,
    updatedAt: Date.now(),
    reason: '',
    log: [],
    delay: 2000,
    maxBatch: 25,
    allowContinuous: false,
    batchStart: 0,
    runCategory: null,
    lastAttempt: null
  };
  let workerBusy = false;
  let attemptedTargets = new WeakSet();
  let lastPersist = 0;
  // Read-only, user-driven learning. Never initiates or replays a click.
  let observation = null;
  let observationTimeout = null;

  const inReactions = () => {
    try {
      const url = new URL(location.href);
      return ['vk.ru', 'vk.com'].includes(url.hostname) && url.protocol === 'https:' &&
        url.pathname.replace(/\/$/, '') === '/feed' && url.searchParams.get('section') === 'likes';
    } catch (_) { return false; }
  };

  const currentCategory = () => {
    if (!inReactions()) return null;
    const url = new URL(location.href);
    const filter = url.searchParams.get('filter') || 'all';
    return VALID_FILTERS.has(filter) ? filter : null;
  };
  // Read-only safety detection. Human challenges are NEVER solved, clicked,
  // dismissed, or retried automatically. We do not collect challenge content.
  const HUMAN_CHECK_NOTICE = 'ВК запросил проверку «Я не робот». Очистка остановлена. Пройдите проверку самостоятельно во ВКонтакте; не запускайте очистку повторно без ручной проверки страницы.';
  function humanVerificationVisible() {
    if (!inReactions()) return false;
    try {
      const selectors = 'iframe[src*="captcha" i],iframe[src*="recaptcha" i],iframe[src*="smartcaptcha" i],iframe[src*="turnstile" i],[id*="captcha" i],[class*="captcha" i],[class*="smartcaptcha" i]';
      for (const el of [...document.querySelectorAll(selectors)].slice(0, 60)) {
        if (el.getClientRects?.().length) return true;
      }
      // Limit text inspection to verification-like controls, not publication content.
      const controls = 'label,[role="checkbox"],[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
      for (const el of [...document.querySelectorAll(controls)].slice(0, 80)) {
        if (!el.getClientRects?.().length) continue;
        const text = String(el.textContent || '').slice(0, 350);
        if (/(?:я\s+не\s+робот|подтвердите,?\s+что\s+вы\s+не\s+робот|verify\s+(?:you(?:'re| are)\s+)?human|i(?:'m| am)\s+not\s+a\s+robot|пройдите\s+проверку\s+на\s+робота)/iu.test(text)) return true;
      }
    } catch (_) { /* Detection failure is not permission to skip another guard. */ }
    return false;
  }
  function blockForHumanVerification() {
    if (state.mode !== 'verification') {
      state.mode = 'verification';
      state.reason = HUMAN_CHECK_NOTICE;
      addLog(HUMAN_CHECK_NOTICE, 'warn');
    }
    return {ok:false, verificationRequired:true, error:HUMAN_CHECK_NOTICE};
  }
  function guardHumanVerification() {
    if (state.mode === 'verification' || humanVerificationVisible()) return blockForHumanVerification();
    return {ok:true};
  }
  function selectorMatches() {
    const matches = ACTIVE_SELECTORS.map(selector => {
      let count = 0;
      try { count = document.querySelectorAll(selector).length; } catch (_) {}
      return {selector, count};
    });
    let count = 0;
    try { count = [...document.querySelectorAll('[aria-label],[title]')].filter(semanticRemove).length; } catch (_) {}
    matches.push({selector: 'Интерактивная кнопка «Убрать реакцию»', count});
    return matches;
  }
  function active(el) {
    return el && el.isConnected && (semanticRemove(el) || ACTIVE_SELECTORS.some(s => el.matches?.(s)));
  }
  function candidates() {
    if (!inReactions()) return [];
    const nodes = [...document.querySelectorAll(SELECTOR)];
    const unique = new Set();
    return nodes.filter(el => {
      if (!active(el) || !el.getClientRects().length) return false;
      // Select the innermost active node: clicking an outer wrapper could
      // accidentally activate a different control.
      if (nodes.some(child => child !== el && el.contains(child))) return false;
      if (unique.has(el)) return false;
      unique.add(el);
      return true;
    });
  }
  // Read-only diagnostics: no post text, names, links, IDs, cookies or tokens.
  // Only structural class names and whitelisted boolean/enum control attributes.
  function diagnostics() {
    const safeClasses = el => {
      const cl = el?.classList;
      if (!cl) return [];
      try {
        return [...cl].filter(x => /^[a-zA-Z_][a-zA-Z_0-9-]{0,64}$/.test(x))
          .filter(x => !/^id[-_]?\d+/i.test(x)).slice(0, 12);
      } catch (_) { return []; }
    };
    const safeTag = el => String(el?.tagName || '').toLowerCase().slice(0, 24);
    const signal = /like|liked|reaction|heart|нрав|реакц|сердеч|оцен/i;
    const hasSignal = el => {
      const classes = safeClasses(el).join(' ');
      return signal.test(classes) || ['aria-label','title','data-testid','data-state'].some(a => signal.test(el?.getAttribute?.(a) || ''));
    };
    const labelType = el => {
      const label = [el.getAttribute?.('aria-label'),el.getAttribute?.('title')].filter(Boolean).join(' ');
      return /убрать|снять|remove|unlike/i.test(label) && signal.test(label) ? 'remove-reaction' :
        /реакц|reaction/i.test(label) ? 'reaction' : /нрав|like|heart|сердеч/i.test(label) ? 'like' : null;
    };
    const profile = el => {
      const ancestors = [];
      for (let ancestor = el?.parentElement, i = 0; ancestor && i < 3; ancestor = ancestor.parentElement, i++) {
        if (safeClasses(ancestor).length) ancestors.push({tag: safeTag(ancestor), classes: safeClasses(ancestor)});
      }
      const ariaPressed = el?.getAttribute?.('aria-pressed');
      const ariaChecked = el?.getAttribute?.('aria-checked');
      const state = el?.getAttribute?.('data-state');
      return {
        tag: safeTag(el), classes: safeClasses(el),
        ariaPressed: ['true','false','mixed'].includes(ariaPressed) ? ariaPressed : null,
        ariaChecked: ['true','false','mixed'].includes(ariaChecked) ? ariaChecked : null,
        dataState: ['on','off','active','inactive','pressed','unpressed','checked','unchecked'].includes(state) ? state : null,
        labelType: labelType(el), ancestors
      };
    };
    const selectors = [
      'button', '[role="button"]', '[aria-pressed]', '[aria-label]', '[title]', '[class*="like" i]',
      '[class*="react" i]', '[class*="heart" i]',
      '[aria-label*="нрав" i]', '[aria-label*="реакц" i]',
      '[data-testid*="like" i]'
    ];
    const gathered = new Set();
    const counts = {};
    for (const selector of selectors) {
      try {
        const found = document.querySelectorAll(selector);
        counts[selector] = found.length;
        for (const el of found) if (gathered.size < 6000) gathered.add(el);
      } catch (_) { counts[selector] = -1; }
    }
    const signals = [];
    const controls = [];
    let pressedTrue = 0;
    for (const el of gathered) {
      if (el?.getAttribute?.('aria-pressed') === 'true') pressedTrue++;
      if (!el?.getClientRects?.().length) continue;
      if (hasSignal(el)) signals.push(el);
      else if (el.matches?.('button,[role="button"]')) controls.push(el);
    }
    const dedupe = (els, limit) => {
      const patterns = new Map();
      for (const el of els) {
        const item = profile(el);
        const key = JSON.stringify(item);
        const hit = patterns.get(key);
        if (hit) hit.count++;
        else if (patterns.size < limit) patterns.set(key,{count:1,...item});
      }
      return [...patterns.values()];
    };
    return {
      version: '0.2.6', diagnosticVersion: 2, category: currentCategory(),
      inReactions: inReactions(),
      counts, totalDistinctElements: gathered.size, pressedTrue,
      activeSelectors: selectorMatches(),
      semanticRemoveControls: candidates().filter(semanticRemove).length,
      signalElements: signals.length,
      signalPatterns: dedupe(signals, 30),
      controlSamples: dedupe(controls, 10),
      iframeCount: document.querySelectorAll('iframe').length,
      notice: 'Только структура элементов: без имён, текста публикаций, ссылок, ID, cookies, токенов. Диагностика ничего не нажимает.'
    };
  }
  // Unlike previous automatic experiments, manual observation records the
  // real effect of a trusted human click, not assumptions about VK internals.
  // No texts, links, profile IDs, post IDs, coordinates or token-like values.
  function visibleCount(selector) {
    try { return [...document.querySelectorAll(selector)].filter(el => Boolean(el.getClientRects?.().length)).length; }
    catch (_) { return 0; }
  }
  function observationsSample() {
    return {
      activeRemoveActions: candidates().length,
      allAriaLabels: visibleCount('[aria-label]'),
      reactionLabeled: visibleCount('[aria-label*="реакц" i],[aria-label*="reaction" i]'),
      dialogs: visibleCount('[role="dialog"]'),
      menus: visibleCount('[role="menu"]'),
      actionButtons: visibleCount('button,[role="button"]')
    };
  }
  function nearestReactionControl(target) {
    let el = target;
    for (let i = 0; el && i < 9; i++, el = el.parentElement) {
      if (el.getAttribute && isInteractive(el) && semanticAction(el)) return el;
    }
    return null;
  }
  function observationSummary() {
    return observation ? {active: observation.active, clicks: observation.clicks.length,
      startedAt: observation.startedAt, finishedAt: observation.finishedAt || null} :
      {active:false, clicks:0, startedAt:null, finishedAt:null};
  }
  function safeElementProfile(node) {
    if (!node?.tagName) return null;
    const classes = [...(node.classList || [])].filter(x =>
      /^[a-zA-Z_][a-zA-Z_0-9-]{0,56}$/.test(x) && !/^id[-_]?\d+/i.test(x)).slice(0,8);
    const role=node.getAttribute?.('role');
    const label=node.getAttribute?.('aria-label') || node.getAttribute?.('title') || '';
    const testid=node.getAttribute?.('data-testid') || '';
    return {
      tag:String(node.tagName).toLowerCase().slice(0,20),
      classes, role:['button','menuitem','dialog','checkbox'].includes(role)?role:null,
      action:semanticAction(node),
      labelKind: /реакц|reaction/i.test(label)?'reaction': /нрав|like/i.test(label)?'like':null,
      testKind:/like/i.test(testid)?'like':/reaction/i.test(testid)?'reaction':null,
      interactive:isInteractive(node),
      ariaPressed:['true','false'].includes(node.getAttribute?.('aria-pressed')) ? node.getAttribute('aria-pressed'):null
    };
  }
  function eventTrail(event) {
    const path=typeof event.composedPath==='function' ? event.composedPath() : null;
    const nodes=path || (()=>{
      const nodes=[]; let el=event.target;
      for(let i=0;el&&i<10;i++,el=el.parentElement)nodes.push(el);
      return nodes;
    })();
    return nodes.filter(n=>n?.tagName && !['HTML','BODY'].includes(n.tagName)).slice(0,8)
      .map(safeElementProfile).filter(Boolean);
  }
  function relativeClick(event,control) {
    if(!control?.getBoundingClientRect || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY))return null;
    const r=control.getBoundingClientRect();
    if(r.width<=0||r.height<=0)return null;
    const clamp=n=>Math.max(0,Math.min(1,n));
    return {x:Math.round(clamp((event.clientX-r.left)/r.width)*20)/20,
      y:Math.round(clamp((event.clientY-r.top)/r.height)*20)/20};
  }
  let lastPointerDown=null;
  let lastPointerUp=null;
  function manualPointerEvent(event) {
    if(!observation?.active || !event.isTrusted) return;
    const control=nearestReactionControl(event.target);
    if(!control || semanticAction(control)!=='remove') return;
    const point={type:event.type, button:event.button===0?'left':'other',
      pointerType:['mouse','touch','pen'].includes(event.pointerType)?event.pointerType:'other',
      targetTrail:eventTrail(event), relative:relativeClick(event,control),
      beforeAction:semanticAction(control),ms:Date.now()-observation.startedAt};
    if(event.type==='pointerdown')lastPointerDown=point;
    if(event.type==='pointerup')lastPointerUp=point;
  }
  function manualReactionClick(event) {
    if (!observation?.active || !event.isTrusted) return;
    const control = nearestReactionControl(event.target);
    if (!control || observation.clicks.length >= 3 || semanticAction(control)!=='remove') return;
    const entry = {event:'trusted-click', ms:Date.now()-observation.startedAt,
      beforeAction:semanticAction(control), before:observationsSample(),
      targetTrail:eventTrail(event), relative:relativeClick(event,control),
      button:event.button===0?'left':'other',detail:Number(event.detail)||0,
      pointerDown:lastPointerDown,pointerUp:lastPointerUp,after:[]};
    observation.clicks.push(entry);
    lastPointerDown=null; lastPointerUp=null;
    for(const wait of [150,400,900,2200]){
      setTimeout(()=>{
        if(observation?.clicks.includes(entry)){
          entry.after.push({ms:Date.now()-observation.startedAt,
            controlConnected:Boolean(control.isConnected),
            controlAction:control.isConnected?semanticAction(control):'detached',
            counts:observationsSample()});
        }
      },wait);
    }
  }
  function stopObservation() {
    if (!observation?.active) return;
    observation.active = false;
    observation.finishedAt = Date.now();
    observation.end = observationsSample();
    document.removeEventListener('click', manualReactionClick, true);
    document.removeEventListener('pointerdown', manualPointerEvent, true);
    document.removeEventListener('pointerup', manualPointerEvent, true);
    if (observationTimeout !== null) clearTimeout(observationTimeout);
    observationTimeout = null;
    addLog(`Наблюдение завершено: ${observation.clicks.length} нажатий на реакции. Данные можно сохранить в JSON.`);
  }
  function startObservation() {
    if (observation?.active || state.mode === 'running' || state.mode === 'paused') return false;
    observation = {
      version:'0.2.6', reportType:'manual-reaction-observation-v2',
      category:currentCategory(), startedAt:Date.now(), finishedAt:null,
      active:true, baseline:observationsSample(), clicks:[], end:null,
      notice:'Только техническая структура элементов, положение клика внутри кнопки, действия и времена. Тексты, ссылки, ID, куки, токены и данные публикаций не записываются. Расширение ничего не нажимает.'
    };
    lastPointerDown=null;lastPointerUp=null;
    document.addEventListener('click', manualReactionClick, true);
    document.addEventListener('pointerdown',manualPointerEvent,true);
    document.addEventListener('pointerup',manualPointerEvent,true);
    observationTimeout = setTimeout(stopObservation, 90000);
    addLog('Наблюдение v2: нажмите вручную на ОДНО красное сердечко, затем завершите. Автоматических нажатий нет.');
    return true;
  }
  function observationReport() {
    if (!observation) return null;
    // Return an explicit whitelist instead of a DOM-node-derived object.
    return {
      version:observation.version, reportType:observation.reportType,
      category:observation.category, durationMs:(observation.finishedAt || Date.now()) - observation.startedAt,
      active:observation.active, baseline:observation.baseline,
      clicks:observation.clicks.map(c=>({event:c.event,ms:c.ms,beforeAction:c.beforeAction,
        targetTrail:c.targetTrail,relative:c.relative,button:c.button,detail:c.detail,
        pointerDown:c.pointerDown,pointerUp:c.pointerUp,
        before:c.before,after:c.after.map(a=>({...a}))})),
      end:observation.end || observationsSample(), notice:observation.notice
    };
  }

  function addLog(message, kind = 'info') {
    state.log.unshift({ time: new Date().toLocaleTimeString('ru-RU'), message, kind });
    state.log.splice(180);
    save(true);
  }
  function snapshot() {
    return {
      mode: state.mode, verificationRequired: state.mode === 'verification' || humanVerificationVisible(), inReactions: inReactions(), category: currentCategory(),
      selectorMatches: selectorMatches().filter(item => item.count),
      visible: candidates().length, removed: state.removed, suspected:state.suspected, attempts:state.attempts,
      disappeared: state.disappeared, failed: state.failed,
      scrolls: state.scrolls, idleScrolls: state.idleScrolls,
      startedAt: state.startedAt, updatedAt: state.updatedAt,
      reason: state.reason, log: [...state.log],
      delay: state.delay, maxBatch: state.maxBatch, runCategory: state.runCategory,
      lastAttempt: state.lastAttempt ? {...state.lastAttempt} : null,
      nativeUsed: native.used, observation: observationSummary()
    };
  }
  function save(force = false) {
    const now = Date.now();
    state.updatedAt = now;
    if (!force && now - lastPersist < 1200) return;
    lastPersist = now;
    try { chrome.storage.local.set({ [storeKey]: snapshot() }); } catch (_) { /* Extension unloaded. */ }
  }
  // Bounded native-pointer attempts. No DOM click() and no mouse-event synthesis.
  // The previous manual trace recorded one trusted click on the span child of
  // a role=button VKUI element (relative 0.35, 0.25). Hover popovers are
  // tolerated ONLY if hit testing still identifies this same reaction button.
  const native = { used:false, phase:'idle', target:null, category:null,
    clickCount:0, trustedTargetClick:0, trustedOtherClick:0,
    pointerDown:0, pointerUp:0, listener:null, pointerListener:null,
    px:null, py:null, beforeOverlays:0 };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function overlays() { return visibleCount('[role="dialog"],[role="menu"]'); }
  function nativeClickWatcher(event) {
    if (!['preparing','pressing','checking'].includes(native.phase)) return;
    native.clickCount++;
    const onTarget=event.target===native.target || native.target?.contains?.(event.target);
    if (event.isTrusted && onTarget) native.trustedTargetClick++;
    if (!onTarget) native.trustedOtherClick++;
  }
  function nativePointerWatcher(event) {
    if (!['pressing','checking'].includes(native.phase)) return;
    const onTarget=event.target===native.target || native.target?.contains?.(event.target);
    if (event.isTrusted && onTarget && event.button===0) {
      if (event.type==='pointerdown') native.pointerDown++;
      if (event.type==='pointerup') native.pointerUp++;
    }
  }
  function cleanupNative() {
    if(native.listener) document.removeEventListener('click',native.listener,true);
    if(native.pointerListener) {
      document.removeEventListener('pointerdown',native.pointerListener,true);
      document.removeEventListener('pointerup',native.pointerListener,true);
    }
    native.listener=null;native.pointerListener=null;
  }
  function nativePreflight() {
    const el=native.target;
    if(!native.used || !el || !inReactions() || currentCategory()!==native.category)
      return {ok:false,error:'Раздел ВК изменился.'};
    if(!semanticRemove(el) || !el.getClientRects?.().length)
      return {ok:false,error:'Исходная кнопка больше не имеет действия «Убрать реакцию».'};
    const r=el.getBoundingClientRect?.();
    if(!r || r.width<12 || r.height<12)
      return {ok:false,error:'Невозможно определить размер кнопки.'};
    // Manual trace v2, quantized to 0.05 of the target dimensions.
    const x=Math.round(r.left+r.width*0.35), y=Math.round(r.top+r.height*0.25);
    if(x<2 || y<2 || x>=window.innerWidth-2 || y>=window.innerHeight-2)
      return {ok:false,error:'Кнопка не помещается в видимую область.'};
    if(native.px!==null && (Math.abs(native.px-x)>3 || Math.abs(native.py-y)>3))
      return {ok:false,error:'Кнопка сдвинулась после наведения. Клик запрещён.'};
    const hit=document.elementFromPoint?.(x,y);
    if(!hit || !(hit===el || el.contains(hit)))
      return {ok:false,error:'Точку нажатия перекрыл другой элемент.'};
    // After a native click, move the cursor out of the reaction's hover zone.
    // This NEVER clicks, and does not loosen the before-click hit-test.
    // Keep inside viewport to ensure a real pointer-leave in Chromium.
    const parkX=Math.max(4,Math.round(window.innerWidth-16));
    const parkY=Math.max(4,Math.round(window.innerHeight-16));
    if(Math.hypot(parkX-x,parkY-y)<80)
      return {ok:false,error:'Не нашлось безопасной точки отвода курсора.'};
    return {ok:true,x,y,parkX,parkY,overlays:overlays()};
  }
  function nativeAbort(reason,pressed=false) {
    if(native.phase==='finished') return;
    native.phase='finished';cleanupNative();
    const verification=state.mode==='verification' || humanVerificationVisible();
    if(verification) {
      blockForHumanVerification();
      if(state.lastAttempt) state.lastAttempt.result='verification';
    } else {
      state.mode='blocked';state.failed+=pressed?1:0;
      state.reason=String(reason||'Тест отменён.');
    }
    if(state.lastAttempt) {
      if(!verification)state.lastAttempt.result=pressed?'unverified':'cancelled-before-click';
      state.lastAttempt.clickEvents=native.clickCount;
      state.lastAttempt.trustedTargetClick=native.trustedTargetClick>0;
      state.lastAttempt.pointerDown=native.pointerDown;
      state.lastAttempt.pointerUp=native.pointerUp;
    }
    if(!verification)addLog(state.reason,'warn');
  }
  async function nativePrepare() {
    if(!inReactions() || !currentCategory()) return {ok:false,error:'Откройте раздел реакций ВК.'};
    const humanCheck=guardHumanVerification();if(!humanCheck.ok)return humanCheck;
    if(observation?.active || workerBusy || ['running','preparing','paused'].includes(state.mode))
      return {ok:false,error:'Завершите предыдущую операцию.'};
    if(state.attempts >= 25 && !state.allowContinuous) return {ok:false,error:'Достигнут предел 25 попыток на загрузку вкладки. Для продолжения используйте режим «До конца» или перезагрузите ВК.'};
    if(overlays()) return {ok:false,error:'Перед тестом закройте всплывающие меню ВК.'};
    const el=candidates().find(el=>!attemptedTargets.has(el) && semanticRemove(el) && el.getAttribute?.('role')==='button' &&
      /like/i.test(el.getAttribute?.('data-testid')||''));
    if(!el) return {ok:false,error:'Нет кнопки реакции с подтверждёнными признаками role=button, like, remove.'};
    native.used=true;native.phase='preparing';native.target=el;native.category=currentCategory();
    state.attempts++;
    native.clickCount=0;native.trustedTargetClick=0;native.trustedOtherClick=0;
    native.pointerDown=0;native.pointerUp=0;native.px=null;native.py=null;
    native.beforeOverlays=overlays();native.listener=nativeClickWatcher;
    native.pointerListener=nativePointerWatcher;
    document.addEventListener('click',native.listener,true);
    document.addEventListener('pointerdown',native.pointerListener,true);
    document.addEventListener('pointerup',native.pointerListener,true);
    state.mode='preparing';state.runCategory=native.category;
    state.lastAttempt={method:'chromium-debugger-pointer-trace-v2',category:native.category,
      beforeAction:'remove',result:'preparing',clickEvents:0,trustedTargetClick:false,
      fractionX:0.35,fractionY:0.25,cursorParked:false};
    addLog(`Подготовлено точное нажатие ${state.attempts}${state.allowContinuous?' · до конца':'/25'} (35% × 25%). Ожидание проверки состояния.`);
    el.scrollIntoView({block:'center',behavior:'auto'});
    await sleep(400);
    const check=nativePreflight();
    if(!check.ok) nativeAbort(check.error,false);
    else {native.px=check.x;native.py=check.y;}
    return check;
  }
  function nativeArmed() {
    const humanCheck=guardHumanVerification();
    if(!humanCheck.ok){native.phase='finished';cleanupNative();if(state.lastAttempt)state.lastAttempt.result='cancelled-before-click';return humanCheck;}
    if(native.phase!=='preparing') return {ok:false,error:'Нажатие не подготовлено.'};
    const check=nativePreflight();
    if(!check.ok) {nativeAbort(check.error,false);return check;}
    // Popup after hovering is expected: manual trace had dialog=1 BEFORE
    // successful click. Only obstruction at the target coordinate blocks it.
    native.phase='pressing';state.mode='running';
    state.lastAttempt.result='armed';
    state.lastAttempt.hoverOverlays=check.overlays;
    state.lastAttempt.initialAriaPressed=native.target.getAttribute?.('aria-pressed');
    state.lastAttempt.initialDataState=native.target.getAttribute?.('data-state');
    save(true);
    return check;
  }
  async function nativeComplete(pressed) {
    if(native.phase==='finished') return {ok:true,state:snapshot()};
    native.phase='checking';
    const el=native.target;
    if(!pressed) {nativeAbort('Клик не был отправлен.',false);return {ok:true,state:snapshot()};}
    if(el) attemptedTargets.add(el);
    const samples=[];
    let pageValid=true;
    let previous=0;
    let quickExit=false;
    let challengeDuringCheck=false;
    // Only turbo mode can finish before 4500ms. Two readings separated by
    // >=800ms, the earliest at 1100/2100ms, must agree AND have no overlay.
    // This does not invent a confirmation: an unlabeled button is still
    // reported as "probable" and requires a manual check after the batch.
    const turbo=state.delay===2000;
    for(const delay of [200,500,1100,2100,2900,4500]) {
      await sleep(delay-previous);previous=delay;
      if(!inReactions() || currentCategory()!==native.category) {pageValid=false;break;}
      if(humanVerificationVisible()) {challengeDuringCheck=true;break;}
      const connected=Boolean(el?.isConnected);
      const action=connected?semanticAction(el):'detached';
      const pressedAttr=connected?el.getAttribute?.('aria-pressed'):null;
      const stateAttr=connected?el.getAttribute?.('data-state'):null;
      samples.push({delay,connected,action,overlays:overlays(),
        ariaPressed:['true','false'].includes(pressedAttr)?pressedAttr:null,
        dataState:['on','off'].includes(stateAttr)?stateAttr:null});
      if(turbo && delay>=2100 && samples.length>=2) {
        const earlier=samples[samples.length-2], later=samples[samples.length-1];
        const stable=earlier.connected && later.connected &&
          earlier.overlays===0 && later.overlays===0 &&
          (later.delay-earlier.delay)>=800;
        const explicit=earlier.action==='add' && later.action==='add' ||
          (state.lastAttempt.initialAriaPressed==='true' &&
            earlier.ariaPressed==='false' && later.ariaPressed==='false') ||
          (state.lastAttempt.initialDataState==='on' &&
            earlier.dataState==='off' && later.dataState==='off');
        const unlabeled=Boolean(state.lastAttempt.cursorParked) &&
          earlier.action===null && later.action===null;
        if(stable && (explicit || unlabeled)) {quickExit=true;break;}
      }
    }
    native.phase='finished';cleanupNative();
    const a=state.lastAttempt;
    a.verification={mode:turbo?'turbo':'full',completedAtMs:previous,earlyExit:quickExit};
    a.samples=samples;a.clickEvents=native.clickCount;
    a.trustedTargetClick=native.trustedTargetClick>0;
    a.trustedOtherClicks=native.trustedOtherClick;
    a.pointerDown=native.pointerDown;a.pointerUp=native.pointerUp;
    const last=samples.slice(-2);
    const explicitAdd=last.length===2 && last.every(s=>s.connected && s.action==='add');
    const explicitOff=last.length===2 && last.every(s=>s.connected && (
      (a.initialAriaPressed==='true' && s.ariaPressed==='false') ||
      (a.initialDataState==='on' && s.dataState==='off')));
    const targetTrusted=a.trustedTargetClick && native.trustedTargetClick===1 &&
      native.pointerDown===1 && native.pointerUp===1 && native.trustedOtherClick===0;
    // VKUI may replace the remove label with no label after a real unlike.
    // Report as *probable*, never explicit confirmation. Require two late,
    // stable readings after every dialog/menu has disappeared.
    const probable=last.length===2 && Boolean(a.cursorParked) && last.every(s=>s.connected && s.action===null && s.overlays===0);
    a.pageValid=pageValid;
    if(challengeDuringCheck) {
      a.result='verification';a.pageValid=false;
      blockForHumanVerification();
    } else if(pageValid && targetTrusted && (explicitAdd || explicitOff)) {
      a.result='confirmed';state.removed++;state.mode='limit';
      state.reason='Та же кнопка явно перешла в состояние без реакции. Проверьте сердечко вручную.';
      addLog(state.reason,'ok');
    } else if(pageValid && targetTrusted && probable) {
      a.result='probable';state.suspected++;state.mode='limit';
      state.reason='Вероятно снято: действие «Убрать реакцию» исчезло и меню закрылось. Подтвердите результат вручную после порции.';
      addLog(state.reason,'ok');
    } else {
      a.result=(!pageValid||!samples.length)?'page-changed':
        samples.some(s=>s.action==='detached')?'disappeared':
        last.some(s=>s.action===null && s.connected)?'changed-unverified':
        last.some(s=>s.overlays>0 && s.action==='remove')?'menu-opened':'unverified';
      state.failed++;state.mode='blocked';
      state.reason='Автоматическое снятие не подтверждено. Клик отправлялся один раз; проверьте красное сердечко вручную и сохраните отчёт.';
      addLog(state.reason,'warn');
    }
    return {ok:true,state:snapshot()};
  }
  let scrolling=false;
  function eligible() {
    return candidates().filter(el=>!attemptedTargets.has(el) && semanticRemove(el) && el.getAttribute?.('role')==='button' &&
      /like/i.test(el.getAttribute?.('data-testid')||'')).length;
  }
  async function advanceFeed() {
    const humanCheck=guardHumanVerification();if(!humanCheck.ok)return humanCheck;
    if(scrolling || !inReactions() || !currentCategory() ||
      ['running','preparing'].includes(state.mode) || native.phase==='pressing' || native.phase==='checking')
      return {ok:false,error:'Прокрутка недоступна во время нажатия или вне реакций.'};
    if(state.scrolls>=60 && !state.allowContinuous) return {ok:false,error:'Лимит 60 автоматических прокруток на вкладку достигнут.'};
    if(eligible())return {ok:true,moved:false,count:eligible(),state:snapshot()};
    scrolling=true;
    try {
      const scroller=document.scrollingElement || document.documentElement;
      const before=Number(scroller?.scrollTop)||0;
      const heightBefore=Number(scroller?.scrollHeight)||0;
      const step=Math.max(280,Math.floor(window.innerHeight*0.8));
      // Scroll the actual main scroller, do not click any controls.
      if(typeof window.scrollBy==='function')window.scrollBy({top:step,behavior:'instant'});
      else if(scroller)scroller.scrollTop=before+step;
      await sleep(350);
      const secondCheck=guardHumanVerification();if(!secondCheck.ok)return secondCheck;
      const after=Number(scroller?.scrollTop)||0;
      const heightAfter=Number(scroller?.scrollHeight)||0;
      const moved=after>before+1 || heightAfter>heightBefore+2;
      state.scrolls++;
      state.idleScrolls=moved?0:state.idleScrolls+1;
      save(true);
      return {ok:true,moved,count:eligible(),state:snapshot()};
    } finally {scrolling=false;}
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.scope !== 'VKLC') return;
    const command = message.cmd;
    if (command === 'checkVerification') {sendResponse(guardHumanVerification());return;}
    if (command === 'ping' || command === 'scan') {
      sendResponse({ ok: true, state: snapshot() });
      return;
    }
    if (command === 'batchSettings') {
      const humanCheck=guardHumanVerification();if(!humanCheck.ok){sendResponse(humanCheck);return;}
      if (!inReactions() || !currentCategory() || ![2000,3000,5000].includes(message.delayMs) ||
          ['preparing','running'].includes(state.mode)) {
        sendResponse({ok:false,error:'Нельзя изменить паузу во время нажатия или вне реакций.'});return;
      }
      state.delay=message.delayMs;state.allowContinuous=message.continuous===true;save(true);
      sendResponse({ok:true,state:snapshot()});return;
    }
    if (command === 'eligible') { const humanCheck=guardHumanVerification();sendResponse(humanCheck.ok?{ok:true,count:eligible(),state:snapshot()}:humanCheck);return; }
    if (command === 'advanceFeed') {advanceFeed().then(sendResponse).catch(e=>sendResponse({ok:false,error:String(e?.message||e)}));return true;}
    if (command === 'diagnose') {
      if (!inReactions()) {
        sendResponse({ok:false,error:'Диагностика работает в разделе реакций ВК.'});
        return;
      }
      sendResponse({ok:true,state:snapshot(),diagnostic:diagnostics()});
      return;
    }
    if (command === 'observeStart') {
      if (!inReactions() || !currentCategory()) { sendResponse({ok:false,error:'Откройте раздел реакций ВК.'}); return; }
      if (!startObservation()) { sendResponse({ok:false,error:'Нельзя начать наблюдение во время очистки или повторного наблюдения.'}); return; }
      sendResponse({ok:true,state:snapshot(),report:observationReport()}); return;
    }
    if (command === 'observeStop') {
      stopObservation();
      sendResponse({ok:true,state:snapshot(),report:observationReport()}); return;
    }
    if (command === 'observeReport') {
      sendResponse({ok:true,state:snapshot(),report:observationReport()}); return;
    }
    if (command === 'nativePrepare') {
      nativePrepare().then(sendResponse).catch(error=>{nativeAbort('Ошибка подготовки: '+String(error?.message||error),false);sendResponse({ok:false,error:state.reason});});
      return true;
    }
    if (command === 'nativePreflight') { sendResponse(nativePreflight()); return; }
    if (command === 'nativeArmed') { sendResponse(nativeArmed()); return; }
    if (command === 'nativeComplete') {
      if(state.lastAttempt) state.lastAttempt.cursorParked=message.cursorParked===true;
      nativeComplete(Boolean(message.pressed)).then(sendResponse).catch(error=>{
        nativeAbort('Ошибка проверки: '+String(error?.message||error),Boolean(message.pressed));
        sendResponse({ok:false,error:state.reason});
      });return true;
    }
    if (command === 'nativeAbort') {
      nativeAbort(String(message.reason||'Отладчик остановлен.'),Boolean(message.pressed));
      sendResponse({ok:true,state:snapshot()});return;
    }
    if (['start','stop','pause','nativeFocus','nativePressed'].includes(command)) {
      sendResponse({ok:false,error:'Старые методы отключены. Используйте безопасную порцию через панель.'}); return;
    }
    if (command === 'batchFinish') {
      if(native.phase==='preparing' || native.phase==='pressing' || native.phase==='checking') {
        sendResponse({ok:false,error:'Подождите завершения текущего клика.'});return;
      }
      state.allowContinuous=false;
      if(!['blocked','verification'].includes(state.mode)) {
        state.mode='stopped';
        state.reason=String(message.reason||'Порция завершена. Проверьте снятые реакции вручную.').slice(0,250);
        addLog(state.reason,'info');
      }
      sendResponse({ok:true,state:snapshot()});return;
    }
    if (command === 'reset') {
      if (['running','preparing','paused'].includes(state.mode) || workerBusy) {
        sendResponse({ ok: false, error: 'Сначала остановите выполнение и дождитесь завершения текущего шага.' });
        return;
      }
      attemptedTargets = new WeakSet();
      Object.assign(state, {
        mode: 'idle', removed: 0, suspected: 0, attempts: 0, disappeared: 0, failed: 0,
        scrolls: 0, idleScrolls: 0, startedAt: null, lastAttempt: null,
        reason: '', log: [], batchStart: 0, runCategory: null, allowContinuous:false
      });
      save(true);
      sendResponse({ ok: true, state: snapshot() });
      return;
    }
    sendResponse({ ok: false, error: 'Неизвестная команда.' });
  });
  save(true);
})();
