'use strict';

(() => {
  const CATEGORY_NAMES = { 1: 'Animation', 2: 'Game', 3: 'MD/Figure', 4: 'Publishing', 5: 'OTHERS', 6: 'Sponsor', 7: 'Virtual' };
  const CATEGORY_ORDER = [6, 1, 2, 3, 4, 7, 5];
  const WIDGETS_URL = 'https://platform.twitter.com/widgets.js';
  const TIMELINE_TIMEOUT_MS = 8000;
  const DEFAULT_DATA = 'data/booths.json';

  const $ = sel => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  const grid = $('#grid');
  const search = $('#search');
  const countEl = $('#count');
  const emptyEl = $('#empty');
  const panel = $('#panel');
  const sheet = panel.querySelector('.sheet');
  const page = $('#page');

  const state = {
    companies: [],
    byId: new Map(),
    category: 'all',
    query: '',
    openId: null,
    boothIndex: 0,
    openedByPush: false,
    timelineSeq: 0, // 부스를 바꾸거나 닫을 때 늘어남(그 부스의 퍼가기 결과를 버림)
    timelineTry: 0, // 최신 글 시도마다 늘어남
    timelineTimer: 0,
    timelinePoll: 0,
    timelineHandle: null,
  };

  // ---------- 공통 ----------
  const safeUrl = value => {
    if (typeof value !== 'string' || !value) return null;
    try {
      const u = new URL(value, location.href);
      return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
    } catch { return null; }
  };

  const isLocalHost = host => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');

  // ?data=… 는 시험용. 이 PC(localhost)에서 열었을 때만, 같은 PC의 주소만 받는다.
  const dataUrl = () => {
    const param = new URLSearchParams(location.search).get('data');
    if (!param || !isLocalHost(location.hostname)) return DEFAULT_DATA;
    try {
      const u = new URL(param, location.href);
      if (isLocalHost(u.hostname) && (u.protocol === 'http:' || u.protocol === 'https:')) return u.href;
    } catch { /* 무시 */ }
    return DEFAULT_DATA;
  };

  const hue = text => {
    let h = 0;
    for (const ch of String(text)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return h % 360;
  };

  const letterTile = (name, id) => {
    const tile = el('div', 'tile', Array.from(String(name || '?').trim())[0] || '?');
    tile.style.background = `hsl(${hue(id || name)} 45% 42%)`;
    tile.setAttribute('aria-hidden', 'true');
    return tile;
  };

  // 격자 그림은 화면 가까이(위아래 300px) 온 것만 싣는다. 브라우저 기본 지연 로딩은 1~2화면 앞까지 미리 받아 첫 화면이 무겁다.
  const nearView = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      nearView.unobserve(e.target);
      e.target.src = e.target.dataset.src;
    }
  }, { rootMargin: '300px 0px' }) : null;

  const imageOrTile = (src, name, id, lazy) => {
    const url = safeUrl(src);
    if (!url) return letterTile(name, id);
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    if (lazy) img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => img.replaceWith(letterTile(name, id)), { once: true });
    if (lazy && nearView) { img.dataset.src = url; nearView.observe(img); }
    else img.src = url;
    return img;
  };

  const normalize = text => String(text || '').toLocaleLowerCase('ko').normalize('NFKC');

  const xHandles = company => [...new Set(company.booths.map(b => b.x && b.x.handle).filter(Boolean))];
  // 카드의 「X 글 N」: 고른 글 + 방문·참여 특전 글(글을 특전으로 옮겨도 수가 줄지 않게)
  const xPostCount = x => (x && Array.isArray(x.picks) ? x.picks.length : 0) + (x && Array.isArray(x.gifts) ? x.gifts.length : 0);
  const pickCount = company => company.booths.reduce((n, b) => n + xPostCount(b.x), 0);

  const formatDate = iso => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '-';
    return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric' }).format(d);
  };

  const codeText = codes => {
    if (!codes.length) return '';
    return codes.length > 3 ? `${codes.slice(0, 3).join(', ')} 외 ${codes.length - 3}` : codes.join(', ');
  };

  const sortedCategories = cats => CATEGORY_ORDER.filter(c => cats.includes(c));

  const catChips = cats => {
    const wrap = el('div', 'cat-list');
    for (const c of sortedCategories(cats)) wrap.append(el('span', 'cat', CATEGORY_NAMES[c] || String(c)));
    return wrap;
  };

  // ---------- 격자 ----------
  const buildCard = company => {
    const li = el('li');
    const a = el('a', 'card');
    a.href = `#c=${encodeURIComponent(company.id)}`;
    a.dataset.companyId = company.id;

    const thumb = el('div', 'thumb');
    thumb.append(imageOrTile(company.logo, company.name, company.id, true));

    const body = el('div', 'card-body');
    body.append(el('h2', 'card-name', company.name));
    body.append(catChips(company.categories));

    const meta = el('div', 'card-meta');
    if (company.booths.length > 1) meta.append(el('span', null, `부스 ${company.booths.length}`));
    if (company.codes.length) meta.append(el('span', 'meta-code', codeText(company.codes)));
    const picks = pickCount(company);
    if (picks > 0) meta.append(el('span', 'meta-x', `X 글 ${picks}`));
    else if (xHandles(company).length) meta.append(el('span', 'meta-x', 'X'));
    if (meta.childNodes.length) body.append(meta);

    a.append(thumb, body);
    li.append(a);
    company._card = li;
    return li;
  };

  const prepare = data => {
    const companies = Array.isArray(data.companies) ? data.companies : [];
    for (const c of companies) {
      c.booths = Array.isArray(c.booths) ? c.booths : [];
      c.codes = Array.isArray(c.codes) ? c.codes.filter(Boolean) : [];
      const cats = Array.isArray(c.categories) && c.categories.length ? c.categories : c.booths.map(b => b.category);
      c.categories = [...new Set(cats.map(Number).filter(Boolean))];
      c._text = normalize([
        c.name,
        ...c.booths.flatMap(b => [b.name, b.copy, b.x && b.x.handle, b.x && b.x.handle && '@' + b.x.handle]),
      ].filter(Boolean).join('\n'));
    }
    return companies;
  };

  const matchesQuery = (company, terms) => terms.every(t => company._text.includes(t));
  const matchesCategory = (company, cat) => cat === 'all' || company.categories.includes(Number(cat));

  const applyFilter = () => {
    const terms = normalize(state.query).split(/\s+/).filter(Boolean);
    const byQuery = state.companies.filter(c => matchesQuery(c, terms));

    // 칩 숫자: 지금 검색어 안에서 분류별 회사 수
    for (const chip of document.querySelectorAll('button[data-category]')) {
      const cat = chip.dataset.category;
      const n = byQuery.filter(c => matchesCategory(c, cat)).length;
      chip.querySelector('.chip-n').textContent = String(n);
      chip.setAttribute('aria-pressed', String(cat === state.category));
    }

    let shown = 0;
    for (const c of state.companies) {
      const visible = byQuery.includes(c) && matchesCategory(c, state.category);
      c._card.hidden = !visible;
      if (visible) shown += 1;
    }
    const total = state.companies.length;
    countEl.textContent = shown === total ? `참가사 ${total}곳` : `참가사 ${total}곳 중 ${shown}곳`;
    emptyEl.hidden = shown !== 0;
  };

  const visibleCards = () => [...grid.querySelectorAll('li:not([hidden]) > .card')];

  const gridColumns = () => {
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
    return Math.max(1, cols);
  };

  grid.addEventListener('keydown', event => {
    const keys = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 'down', ArrowUp: 'up', Home: 'home', End: 'end' };
    if (!(event.key in keys) || !event.target.classList.contains('card')) return;
    const cards = visibleCards();
    const i = cards.indexOf(event.target);
    if (i < 0) return;
    const cols = gridColumns();
    const step = keys[event.key];
    let next = i;
    if (step === 'down') next = i + cols;
    else if (step === 'up') next = i - cols;
    else if (step === 'home') next = 0;
    else if (step === 'end') next = cards.length - 1;
    else next = i + step;
    if (next < 0 || next >= cards.length) return;
    event.preventDefault();
    cards[next].focus();
  });

  // ---------- X 퍼가기 ----------
  let widgetsPromise = null;
  const loadWidgets = () => {
    if (widgetsPromise) return widgetsPromise;
    widgetsPromise = new Promise((resolve, reject) => {
      if (window.twttr && window.twttr.widgets) { resolve(window.twttr); return; }
      const s = document.createElement('script');
      s.src = WIDGETS_URL;
      s.async = true;
      s.charset = 'utf-8';
      // 실패하면 기억을 지워 "다시 시도"가 widgets.js 를 다시 받을 수 있게 한다(성공하면 한 번만 싣는다).
      const failed = message => { widgetsPromise = null; s.remove(); reject(new Error(message)); };
      s.onload = () => (window.twttr && window.twttr.widgets ? resolve(window.twttr) : failed('twttr 없음'));
      s.onerror = () => failed('widgets.js 를 불러오지 못함');
      document.head.append(s);
    });
    return widgetsPromise;
  };

  const darkMode = () => window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;

  // 저장된 퍼가기 HTML 을 넣는다(embeds 만 HTML 로 넣는다). 딸린 <script> 는 빼고 widgets.js 를 따로 부른다.
  // X 퍼가기 HTML 은 blockquote·p·a·br 뿐이다. 그 밖의 요소와 on…·style 같은 속성, http(s) 아닌 주소는 버린다.
  const EMBED_TAGS = new Set(['BLOCKQUOTE', 'P', 'A', 'BR']);
  const EMBED_ATTRS = new Set(['class', 'lang', 'dir', 'href']);
  const embedFragment = html => {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html || '');
    for (const node of [...tpl.content.querySelectorAll('*')]) {
      if (!EMBED_TAGS.has(node.tagName)) { node.remove(); continue; }
      for (const { name, value } of [...node.attributes]) {
        const keep = name.startsWith('data-') || (EMBED_ATTRS.has(name) && (name !== 'href' || safeUrl(value)));
        if (!keep) node.removeAttribute(name);
      }
    }
    tpl.content.querySelectorAll('blockquote.twitter-tweet').forEach(bq => {
      bq.setAttribute('data-dnt', 'true');
      bq.setAttribute('data-lang', 'ko');
      if (darkMode()) bq.setAttribute('data-theme', 'dark');
    });
    return tpl.content;
  };

  const renderPicks = (booth, seq) => {
    const picksEl = $('#picks');
    const wrap = $('#picks-wrap');
    picksEl.replaceChildren();
    const embeds = Array.isArray(booth.x.embeds) ? booth.x.embeds.filter(Boolean) : [];
    const picks = Array.isArray(booth.x.picks) ? booth.x.picks.filter(Boolean) : [];
    if (embeds.length) {
      for (const html of embeds) picksEl.append(embedFragment(html));
    } else {
      for (const p of picks) {
        const url = safeUrl(p);
        if (!url) continue;
        const a = el('a', 'pick-link', url);
        a.href = url; a.target = '_blank'; a.rel = 'noopener';
        picksEl.append(a);
      }
    }
    wrap.hidden = !picksEl.childNodes.length;
    if (!embeds.length) return;
    loadWidgets()
      .then(twttr => { if (seq === state.timelineSeq) return twttr.widgets.load(picksEl); })
      .catch(() => { /* 스크립트가 막혀도 blockquote 본문과 링크는 그대로 읽힌다 */ });
  };

  // ---------- 방문·참여 특전(패널 X 구역 맨 위 고정 자리) ----------
  const GIFT_KINDS = { visit: '부스 방문', game: '미니게임·체험', stamp: '스탬프 랠리', sns: 'SNS 이벤트', purchase: '구매 특전', etc: '현장 이벤트' };

  const renderGifts = (booth, seq) => {
    const giftsEl = $('#gifts');
    const wrap = $('#gifts-wrap');
    giftsEl.replaceChildren();
    const gifts = Array.isArray(booth.x.gifts) ? booth.x.gifts : [];
    let hasEmbed = false;
    for (const g of gifts) {
      if (!g || typeof g !== 'object') continue;
      const url = safeUrl(g.url);
      const embed = typeof g.embed === 'string' && g.embed ? g.embed : null;
      if (!url && !embed) continue;
      const item = el('div', 'gift');
      // 종류·요약은 글자로만 넣는다. 약속에 없는 종류 값은 무시한다.
      const kinds = Array.isArray(g.kinds) ? [...new Set(g.kinds)].filter(k => typeof k === 'string' && Object.hasOwn(GIFT_KINDS, k)) : [];
      if (kinds.length) {
        const row = el('div', 'gift-kinds');
        for (const k of kinds) {
          const tag = el('span', 'gift-kind', GIFT_KINDS[k]);
          tag.dataset.kind = k;
          row.append(tag);
        }
        item.append(row);
      }
      const summary = typeof g.summary === 'string' ? g.summary.trim() : '';
      if (summary) item.append(el('p', 'gift-summary', summary));
      if (embed) {
        item.append(embedFragment(embed));
        hasEmbed = true;
      } else {
        const a = el('a', 'pick-link', 'X에서 이 글 보기');
        a.href = url; a.target = '_blank'; a.rel = 'noopener';
        item.append(a);
      }
      giftsEl.append(item);
    }
    wrap.hidden = !giftsEl.childNodes.length;
    if (!hasEmbed) return;
    loadWidgets()
      .then(twttr => { if (seq === state.timelineSeq) return twttr.widgets.load(giftsEl); })
      .catch(() => { /* 스크립트가 막혀도 blockquote 본문과 링크는 그대로 읽힌다 */ });
  };

  // ---------- 계정 최신 글: 단추를 누를 때만 시도 ----------
  const LOAD_LABEL = { idle: '최신 글 불러오기', loading: '불러오는 중…', retry: '다시 시도' };

  // mode: idle(처음) · loading(시도 중, 누를 수 없음) · retry(실패 뒤) · done(그려짐, 단추 숨김)
  const setLoadButton = mode => {
    const btn = $('#timeline-load');
    const hadFocus = document.activeElement === btn;
    btn.hidden = mode === 'done';
    btn.setAttribute('aria-disabled', String(mode === 'loading'));
    if (mode !== 'done') btn.textContent = LOAD_LABEL[mode];
    if (mode === 'done' && hadFocus) $('#timeline-x-link').focus();
  };

  const timelineDrawn = tl => [...tl.querySelectorAll('iframe')].some(f => f.offsetHeight > 60);

  // 다른 부스로 바꾸거나 패널을 닫으면 진행 중이던 시도의 타이머를 지운다.
  const stopTimeline = () => {
    clearTimeout(state.timelineTimer);
    clearInterval(state.timelinePoll);
    $('#timeline').setAttribute('aria-busy', 'false');
  };

  // 새 부스: 단추 상태에서 시작한다. "X에서 @계정 보기" 링크는 늘 보인다.
  const resetTimeline = handle => {
    stopTimeline();
    state.timelineHandle = handle;
    state.timelineTry += 1; // 이전 시도의 뒤늦은 결과 버림
    $('#timeline').replaceChildren();
    $('#timeline-fallback').hidden = true;
    const link = $('#timeline-x-link');
    link.href = `https://x.com/${encodeURIComponent(handle)}`;
    link.textContent = `X에서 @${handle} 보기`;
    setLoadButton('idle');
  };

  const loadTimeline = () => {
    const handle = state.timelineHandle;
    if (!handle || panel.hidden || $('#timeline-load').getAttribute('aria-disabled') === 'true') return;
    const seq = state.timelineSeq;
    const myTry = ++state.timelineTry;
    let finished = false;
    const live = () => !finished && seq === state.timelineSeq && myTry === state.timelineTry;
    const tl = $('#timeline');
    const fallback = $('#timeline-fallback');

    stopTimeline();
    fallback.hidden = true;
    tl.replaceChildren();
    tl.setAttribute('aria-busy', 'true');
    setLoadButton('loading');

    const succeed = () => { finished = true; stopTimeline(); setLoadButton('done'); };
    const fail = () => {
      if (!live()) return;
      finished = true;
      stopTimeline();
      tl.replaceChildren();
      fallback.hidden = false;
      setLoadButton('retry');
    };

    state.timelineTimer = setTimeout(() => {
      if (!live()) return;
      if (timelineDrawn(tl)) succeed(); else fail();
    }, TIMELINE_TIMEOUT_MS);

    loadWidgets()
      .then(twttr => {
        if (!live()) return null;
        const host = el('div');
        tl.replaceChildren(host);
        return twttr.widgets.createTimeline(
          { sourceType: 'profile', screenName: handle },
          host,
          { tweetLimit: 5, dnt: true, lang: 'ko', theme: darkMode() ? 'dark' : 'light', chrome: 'noheader nofooter' },
        ).then(node => {
          if (!live()) return;
          if (!node) { fail(); return; }
          // 빈 응답이어도 node 는 돌아오므로, 실제로 그려졌는지는 iframe 높이로 본다(8초까지).
          clearInterval(state.timelinePoll);
          state.timelinePoll = setInterval(() => { if (!live()) clearInterval(state.timelinePoll); else if (timelineDrawn(tl)) succeed(); }, 250);
        });
      })
      .catch(fail);
  };

  $('#timeline-load').addEventListener('click', loadTimeline);

  // ---------- 패널 ----------
  const setFact = (list, key, valueNode) => {
    const li = el('li');
    li.append(el('span', 'k', key));
    const v = el('span', 'v');
    v.append(valueNode);
    li.append(v);
    list.append(li);
  };

  const extLink = (href, text) => {
    const a = el('a', null, text);
    a.href = href; a.target = '_blank'; a.rel = 'noopener';
    return a;
  };

  const renderBooth = () => {
    const company = state.byId.get(state.openId);
    if (!company) return;
    const booth = company.booths[state.boothIndex] || company.booths[0];
    state.timelineSeq += 1;
    const seq = state.timelineSeq;

    for (const tab of document.querySelectorAll('#booth-tabs [data-booth-id]')) {
      const selected = tab.dataset.boothId === (booth && booth.id);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }

    const media = $('#booth-media');
    media.replaceChildren();
    const facts = $('#booth-facts');
    facts.replaceChildren();
    const copy = $('#booth-copy');
    const nameEl = $('#booth-name');
    const xArea = $('#x-area');

    if (!booth) {
      copy.textContent = '';
      xArea.hidden = true;
      nameEl.hidden = true;
      return;
    }

    media.append(imageOrTile(booth.logo || company.logo, booth.name || company.name, booth.id, false));
    const showName = company.booths.length > 1 || (booth.name && booth.name !== company.name);
    nameEl.textContent = booth.name || '';
    nameEl.hidden = !showName || !booth.name;

    setFact(facts, '분류', document.createTextNode(CATEGORY_NAMES[booth.category] || '-'));
    setFact(facts, '부스 번호', document.createTextNode(booth.code || '공식 배치도에 표기 없음'));
    const home = safeUrl(booth.homepage);
    if (home) setFact(facts, '홈페이지', extLink(home, home.replace(/^https?:\/\//, '').replace(/\/$/, '')));
    const handle = booth.x && typeof booth.x.handle === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(booth.x.handle) ? booth.x.handle : null;
    if (handle) setFact(facts, 'X 계정', extLink(`https://x.com/${handle}`, `@${handle}`));

    copy.textContent = booth.copy || '';

    if (!handle) {
      stopTimeline();
      state.timelineHandle = null;
      xArea.hidden = true;
      $('#gifts').replaceChildren();
      $('#gifts-wrap').hidden = true;
      $('#picks').replaceChildren();
      $('#timeline').replaceChildren();
      return;
    }
    xArea.hidden = false;
    renderGifts(booth, seq);
    renderPicks(booth, seq);
    resetTimeline(handle);
  };

  const renderPanel = company => {
    $('#panel-title').textContent = company.name;
    $('#panel-cats').replaceWith(Object.assign(catChips(company.categories), { id: 'panel-cats' }));

    const tabs = $('#booth-tabs');
    tabs.replaceChildren();
    if (company.booths.length > 1) {
      company.booths.forEach((b, i) => {
        const t = el('button', 'booth-tab', b.code ? `${b.name} · ${b.code}` : b.name);
        t.type = 'button';
        t.setAttribute('role', 'tab');
        t.dataset.boothId = b.id;
        t.dataset.index = String(i);
        t.title = b.name;
        tabs.append(t);
      });
      tabs.hidden = false;
    } else {
      tabs.hidden = true;
    }
    state.boothIndex = 0;
    renderBooth();
  };

  $('#booth-tabs').addEventListener('click', event => {
    const tab = event.target.closest('[data-booth-id]');
    if (!tab) return;
    const i = Number(tab.dataset.index);
    if (i === state.boothIndex) return;
    state.boothIndex = i;
    renderBooth();
  });

  $('#booth-tabs').addEventListener('keydown', event => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...event.currentTarget.querySelectorAll('[data-booth-id]')];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let next = i;
    if (event.key === 'ArrowRight') next = (i + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    event.preventDefault();
    tabs[next].focus();
    tabs[next].click();
  });

  const openPanel = id => {
    const company = state.byId.get(id);
    if (!company) { closePanelView(); return; }
    const wasOpen = !panel.hidden;
    state.openId = id;
    renderPanel(company);
    panel.hidden = false;
    document.body.classList.add('panel-open');
    page.inert = true;
    sheet.scrollTop = 0;
    if (!wasOpen) $('#panel-close').focus();
  };

  const closePanelView = () => {
    if (panel.hidden) return;
    const id = state.openId;
    state.timelineSeq += 1; // 진행 중인 타임라인 결과 버림
    stopTimeline();
    panel.hidden = true;
    document.body.classList.remove('panel-open');
    page.inert = false;
    $('#gifts').replaceChildren();
    $('#picks').replaceChildren();
    $('#timeline').replaceChildren();
    state.openId = null;
    const company = state.byId.get(id);
    const card = company && company._card && company._card.querySelector('.card');
    if (card) {
      if (company._card.hidden) { search.focus(); } else { card.focus(); }
    }
  };

  // 닫기: 카드를 눌러 연 경우 뒤로 가기, 주소로 바로 연 경우 주소만 지운다.
  const requestClose = () => {
    if (panel.hidden) return;
    if (state.openedByPush) {
      history.back();
    } else {
      history.replaceState(null, '', location.pathname + location.search);
      closePanelView();
    }
  };

  const idFromHash = () => {
    const m = /^#c=(.+)$/.exec(location.hash);
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch { return null; }
  };

  grid.addEventListener('click', event => {
    const card = event.target.closest('.card');
    if (!card || event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    const id = card.dataset.companyId;
    if (idFromHash() === id && !panel.hidden) return;
    history.pushState({ panel: id }, '', `#c=${encodeURIComponent(id)}`);
    state.openedByPush = true;
    openPanel(id);
  });

  window.addEventListener('popstate', () => syncFromHash());
  window.addEventListener('hashchange', () => syncFromHash());

  // 이 기록 칸을 카드 누름(pushState)으로 만들었는지. 앞으로 가기·새로 고침 뒤에도 history.state 로 알 수 있다.
  const pushedEntry = id => !!(history.state && history.state.panel === id);

  const syncFromHash = () => {
    const id = idFromHash();
    if (id && state.byId.has(id)) {
      if (id !== state.openId) { state.openedByPush = pushedEntry(id); openPanel(id); }
    } else {
      state.openedByPush = false;
      closePanelView();
    }
  };

  $('#panel-close').addEventListener('click', requestClose);
  panel.addEventListener('click', event => { if (event.target === panel) requestClose(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); requestClose(); }
  });

  // ---------- 찾기 ----------
  search.addEventListener('input', () => { state.query = search.value; applyFilter(); });
  $('#chips').addEventListener('click', event => {
    const chip = event.target.closest('button[data-category]');
    if (!chip) return;
    state.category = chip.dataset.category;
    applyFilter();
  });

  // ---------- 시작 ----------
  const start = async () => {
    let data;
    try {
      const res = await fetch(dataUrl(), { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      countEl.textContent = '';
      $('#load-error').hidden = false;
      return;
    }
    state.companies = prepare(data);
    for (const c of state.companies) state.byId.set(c.id, c);

    const mapUrl = safeUrl(data.mapUrl);
    if (mapUrl) $('#map-link').href = mapUrl;
    const source = safeUrl(data.source);
    if (source) $('#source-link').href = source;
    $('#generated-at').textContent = formatDate(data.generatedAt);

    const frag = document.createDocumentFragment();
    for (const c of state.companies) frag.append(buildCard(c));
    grid.replaceChildren(frag);
    applyFilter();

    const id = idFromHash();
    if (id && state.byId.has(id)) {
      state.openedByPush = pushedEntry(id);
      openPanel(id);
    }
  };

  start();
})();
