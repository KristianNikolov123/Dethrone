(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
  const ANON = 'Анонимен';

  // ---------- Икони ----------
  const ICON = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>',
    note: '<svg viewBox="0 0 24 24"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/></svg>',
    crown: '<svg viewBox="0 0 24 24"><path d="M4 17l-1-9 5 3.5L12 5l4 6.5L21 8l-1 9z"/></svg>',
    medal: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="12" r="5"/><path d="M7 7.5L5 2h3l2 4 2-4h3l-2 5.5"/></svg>',
    trim: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v12M16 4v12M4 10h12M7 7l-3 3 3 3M13 7l3 3-3 3"/></svg>',
    coin: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="10" cy="10" r="7"/><path d="M12.5 7.5a3 3 0 100 5M6.5 9.2h4M6.5 11h4"/></svg>',
  };

  // ---------- Потребител ----------
  // Идентификаторът на браузъра от времето преди акаунтите: при първия вход точките от него се прехвърлят към акаунта
  const legacyVoterId = lsGet('bc_voter');
  let account = null;          // влезлият потребител или null
  let loginOptions = { providers: [], devLogin: false };
  const nick = () => account?.name || ANON;

  // ---------- Състояние ----------
  let state = null;
  let skew = 0;
  let library = [];
  let libFilter = 'all';
  const songIndex = new Map();
  const serverNow = () => Date.now() + skew;
  const indexSongs = (list) => {
    for (const s of list) {
      if (!s) continue;
      if (s.canEdit) myEditable.add(s.id);
      songIndex.set(s.id, s);
    }
  };

  function fmt(ms) {
    let s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400); s %= 86400;
    const h = Math.floor(s / 3600); s %= 3600;
    const m = Math.floor(s / 60); s %= 60;
    const p = (n) => String(n).padStart(2, '0');
    if (d) return `${d} д ${h} ч`;
    if (h) return `${h}:${p(m)}:${p(s)}`;
    return `${m}:${p(s)}`;
  }
  const eur = (n) => `${n} €`;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function toast(msg, bad) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.className = ''; }, 3200);
  }

  async function api(path, opts = {}) {
    const r = await fetch(path, opts);
    let j = {};
    try { j = await r.json(); } catch { /* ignore */ }
    if (!r.ok) throw new Error(j.error || 'Заявката не мина. Опитай пак.');
    return j;
  }
  const post = (p, body) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const ytThumb = (id, q = 'mqdefault') => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/${q}.jpg`;
  const thumb = (s) => (s.type === 'youtube'
    ? `<img class="thumb" src="${ytThumb(s.videoId)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'thumb'}))">`
    : `<div class="thumb">${ICON.note}</div>`);
  const artistLink = (name) => `<button class="link" data-artist="${esc(name)}">${esc(name)}</button>`;

  // ---------- Данни ----------
  // Сървърът праща цялото състояние с всяко обновление, общо за всички. Личните неща
  // (за коя песен си гласувал, кои песни можеш да редактираш) браузърът ги помни сам.
  const myVotes = {};            // дуел → страна, за която си гласувал
  const myEditable = new Set();  // песни, които си добавил ти

  function markMine(song) {
    if (song && !song.canEdit && myEditable.has(song.id)) song.canEdit = true;
    return song;
  }

  function applyState(s) {
    skew = s.now - Date.now();
    if (s.duel) {
      if (s.duel.myVote) myVotes[s.duel.id] = s.duel.myVote;
      s.duel.myVote = myVotes[s.duel.id] || null;
    }
    [s.throne?.song, s.duel?.champion, s.duel?.challenger, ...s.queue.map((q) => q.song)].forEach(markMine);
    state = s;
    indexSongs([s.throne?.song, s.duel?.champion, s.duel?.challenger, ...s.queue.map((q) => q.song)]);
    render();
    syncPlayer();
    const lastDuelAt = s.recentDuels[0]?.at || 0;
    if (lastDuelAt !== applyState.lastDuelAt) { applyState.lastDuelAt = lastDuelAt; loadBadges(); }
  }

  // Пълното състояние заедно с личните данни: при отваряне на страницата и след собствени действия
  async function refresh() {
    try { applyState(await api('/api/state')); }
    catch (e) { console.error(e); }
  }

  async function loadLibrary() {
    try {
      library = (await api('/api/songs')).songs;
      for (const s of library) if (s.canEdit) myEditable.add(s.id);
      indexSongs(library);
      renderLibrary();
      if (state) updateTransport();
    } catch (e) { console.error(e); }
  }

  // Само броят на гласовете се промени: обновяваме само дуела
  function applyVotes(v) {
    if (!state?.duel || state.duel.id !== v.duelId) return;
    state.duel.counts = v.counts;
    renderDuel();
    updateTimers();
  }

  let lastEventAt = Date.now();
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => {
    lastEventAt = Date.now();
    try { applyState(JSON.parse(e.data)); } catch { refresh(); }
  });
  es.addEventListener('votes', (e) => {
    lastEventAt = Date.now();
    try { applyVotes(JSON.parse(e.data)); } catch { /* ignore */ }
  });
  // Списъкът с песни се тегли наново с малко случайно забавяне, за да не питат всички едновременно
  let libraryTimer = null;
  es.addEventListener('library', () => {
    lastEventAt = Date.now();
    if (!libraryTimer) libraryTimer = setTimeout(() => { libraryTimer = null; loadLibrary(); }, Math.random() * 1500);
  });
  es.addEventListener('ping', () => { lastEventAt = Date.now(); });
  es.addEventListener('open', () => { lastEventAt = Date.now(); refresh(); loadLibrary(); });
  // Резервно: ако връзката е мълчала дълго, питаме сами
  setInterval(() => { if (Date.now() - lastEventAt > 45000) refresh(); }, 15000);

  // ---------- Рендериране ----------
  function render() {
    renderThrone();
    renderDuel();
    renderQueue();
    renderHall();
    renderScouts();
    renderRecent();
    renderTips();
    renderLibrary();
    updateTimers();
  }

  function renderThrone() {
    const el = $('#throne-info');
    const t = state.throne;
    if (!t || !t.song) {
      el.innerHTML = `<h1 class="song-title">Тронът е свободен</h1>
        <p class="song-artist">Добави песен и тя сяда направо на трона.</p>`;
      $('#reign-timer').textContent = '0:00';
      return;
    }
    const s = t.song;
    const chips = [
      s.original ? '<span class="chip gold">Нов артист</span>' : '<span class="chip">YouTube</span>',
      state.duel ? '<span class="chip live"><span class="dot"></span>Защитава трона</span>' : '',
    ].join('');
    const meta = [
      `<span>Предложена от ${esc(s.addedBy)}</span>`,
      `<span>${plural(s.duelWins, 'победа', 'победи')}, ${plural(s.defenses, 'защита', 'защити')}</span>`,
      s.original ? `<span>${eur(s.tipsTotal)} бакшиши</span>` : '',
      s.biggestFan ? `<span class="fan">${ICON.medal}Най-голям фен: ${esc(s.biggestFan)}</span>` : '',
      s.original ? `<button class="btn small" data-tip="${s.id}">${ICON.coin.replace('<svg', '<svg class="ic"')}Бакшиш</button>` : '',
    ].join('');
    el.innerHTML = `<div class="chips">${chips}</div>
      <h1 class="song-title" title="${esc(s.title)}">${esc(s.title)}</h1>
      <p class="song-artist">${artistLink(s.artist)}</p>
      <div class="song-meta">${meta}</div>`;
  }

  // По време на дуел той заема центъра, а лявата колона показва само опашката
  function renderDuel() {
    const el = $('#duel');
    const status = $('#duel-status');
    const d = state.duel;
    const inner = $('#stage-inner');
    inner.classList.toggle('dueling', !!d);
    $('#duel-stage').classList.toggle('hidden', !d);
    $('#duel-side-block').classList.toggle('hidden', !!d);
    $('#queue-head').classList.toggle('sub', !d);
    renderDuelStage();
    if (!d) {
      status.className = 'status';
      status.textContent = '';
      if (state.queue.length && state.throne) {
        el.innerHTML = `<div class="idle"><strong>Следващият дуел започва след</strong>
          <span class="clock" data-countdown="${state.nextDuelAt}">0:00</span>
          Претендент: ${esc(state.queue[0].song.title)}</div>`;
      } else if (state.throne) {
        el.innerHTML = `<div class="idle"><strong>Няма дуел в момента</strong>
          Предизвикай трона с песен от списъка или добави нова.
          <button class="btn small" data-open-add>Добави песен</button></div>`;
      } else {
        el.innerHTML = `<div class="idle"><strong>Още няма песен на трона</strong>
          Първата добавена песен го заема. След това започват дуелите.
          <button class="btn small" data-open-add>Добави песен</button></div>`;
      }
      return;
    }
    status.className = 'status live';
    status.innerHTML = '<span class="dot"></span>На живо';
    el.innerHTML = '';
  }

  // Центърът по време на дуел: „Песен А vs Песен Б“ с гласовете
  function renderDuelStage() {
    const el = $('#duel-stage');
    const d = state.duel;
    if (!d) { el.innerHTML = ''; el.dataset.duel = ''; return; }
    const total = d.counts.champion + d.counts.challenger;
    const pctC = total ? Math.round((d.counts.champion * 100) / total) : 50;
    const pct = { champion: pctC, challenger: 100 - pctC };
    const media = (s, k) => (s.type === 'youtube'
      ? `<div class="media" data-slot="${k}" style="background-image:url(${ytThumb(s.videoId, 'hqdefault')})"></div>`
      : `<div class="media" data-slot="${k}">${ICON.note}</div>`);
    const side = (k) => {
      const s = d[k];
      if (!s) return '<div class="side"><p class="empty">Песента е премахната.</p></div>';
      const mine = d.myVote === k;
      const role = k === 'champion'
        ? `На трона от <span data-since="${state.throne?.since || d.startedAt}">0:00</span>`
        : `Претендент<span class="by-who">, предложен от ${esc(d.challengedBy)}</span>`;
      return `<div class="side ${k} ${mine ? 'voted' : ''}">
        ${media(s, k)}
        <div class="role">${role}</div>
        <div class="title" title="${esc(s.title)}">${esc(s.title)}</div>
        <div class="artist">${artistLink(s.artist)}</div>
        <div class="fan">${s.biggestFan ? `Най-голям фен: ${esc(s.biggestFan)}` : ''}</div>
        <div class="tally"><b>${d.counts[k]}</b><span>${d.counts[k] === 1 ? 'глас' : 'гласа'}</span><span class="pct">${total ? pct[k] + '%' : ''}</span></div>
        <div class="actions">
          <button class="btn" data-listen="${k}">Чуй</button>
          <button class="btn vote ${mine ? 'mine' : ''}" data-vote="${k}">${mine ? 'Твоят глас' : 'Гласувай'}</button>
        </div>
      </div>`;
    };
    el.innerHTML = `
      <div class="duel-top">
        <span class="chip live"><span class="dot"></span>Дуел за трона</span>
        <div class="duel-timer"><b data-countdown="${d.endsAt}">0:00</b>до края</div>
      </div>
      <div class="versus">${side('champion')}<div class="vs">vs</div>${side('challenger')}</div>
      <div class="split big"><span class="a" style="width:${pct.champion}%"></span><span class="b" style="width:${pct.challenger}%"></span></div>
      <p class="duel-foot">Гласувай за песента, която искаш на трона. При равен резултат сегашната остава.</p>`;
    el.dataset.duel = d.id;
    requestAnimationFrame(positionVideo);
  }

  // Слага плейъра върху картинката на песента, която звучи в момента
  function positionVideo() {
    const inner = $('#stage-inner');
    const video = $('.video');
    if (!inner.classList.contains('dueling')) {
      video.removeAttribute('style');
      video.classList.remove('parked');
      return;
    }
    const d = state?.duel;
    const playingId = player.listening ? player.currentId : null;
    const k = d && playingId === d.challenger?.id ? 'challenger' : 'champion';
    const slot = inner.querySelector(`[data-slot="${k}"]`);
    const show = !!(player.listening && slot && d && (playingId === d.champion?.id || playingId === d.challenger?.id));
    video.classList.toggle('parked', !show);
    if (!slot) return;
    const a = slot.getBoundingClientRect();
    const b = inner.getBoundingClientRect();
    Object.assign(video.style, {
      top: `${a.top - b.top}px`, left: `${a.left - b.left}px`, width: `${a.width}px`, height: `${a.height}px`,
    });
  }
  new ResizeObserver(() => positionVideo()).observe($('#stage-inner'));

  function renderQueue() {
    const el = $('#queue');
    $('#queue-count').textContent = state.queue.length ? String(state.queue.length) : '';
    if (!state.queue.length) { el.innerHTML = '<p class="empty">Никой не чака за дуел.</p>'; return; }
    el.innerHTML = state.queue.map((q) => `<div class="row">
      ${thumb(q.song)}
      <div style="min-width:0"><div class="t">${esc(q.song.title)}</div><div class="s">от ${esc(q.challengedBy)}</div></div>
      <span></span>
    </div>`).join('');
  }

  function renderHall() {
    const el = $('#hall');
    if (!state.hallOfFame.length) { el.innerHTML = '<li class="empty">Още няма царувания.</li>'; return; }
    el.innerHTML = state.hallOfFame.map((r) => `<li>
      <div style="min-width:0"><div class="t">${esc(r.song.title)}</div>
        <div class="s">${artistLink(r.song.artist)}${r.current ? ' <span class="tag-text gold">на трона</span>' : ''}</div></div>
      <span class="num strong" ${r.current ? `data-since="${r.start}"` : ''}>${fmt(r.duration)}</span>
    </li>`).join('');
  }

  function renderScouts() {
    const el = $('#scouts');
    if (!state.scouts.length) { el.innerHTML = '<li class="empty">Предложи песен, която свали трона, и името ти ще е тук.</li>'; return; }
    el.innerHTML = state.scouts.map((s) => `<li><div class="t">${esc(s.name)}</div>
      <span class="num">${plural(s.wins, 'сваляне', 'сваляния')}</span></li>`).join('');
  }

  function renderRecent() {
    const el = $('#recent');
    if (!state.recentDuels.length) { el.innerHTML = '<p class="empty">Още няма завършени дуели.</p>'; return; }
    el.innerHTML = state.recentDuels.map((d) => {
      const champ = esc(d.champion?.title ?? '—');
      const chall = esc(d.challenger?.title ?? '—');
      const line = d.winner === 'challenger'
        ? `<span class="won">${chall}</span> свали ${champ}`
        : `<span class="won">${champ}</span> удържа срещу ${chall}`;
      return `<div class="feed-item"><div class="line">${line}</div>
        <div class="s">${d.counts.champion} на ${d.counts.challenger} гласа${d.challengedBy ? `, предложено от ${esc(d.challengedBy)}` : ''}</div></div>`;
    }).join('');
  }

  function renderTips() {
    const el = $('#tips-feed');
    const tips = state.recentTips || [];
    if (!tips.length) { el.innerHTML = '<p class="empty">Още няма бакшиши. Новите артисти ги получават директно.</p>'; return; }
    el.innerHTML = tips.map((t) => `<div class="feed-item">
      <div class="line"><span class="amt">${eur(t.amount)}</span> от ${esc(t.by)}${t.byBiggestFan ? ' <span class="tag-text gold">най-голям фен</span>' : ''} за ${artistLink(t.artist)}</div>
      <div class="s">${esc(t.songTitle)}</div>
      ${t.message ? `<div class="msg">${esc(t.message)}</div>` : ''}
    </div>`).join('');
  }

  function renderLibrary() {
    const el = $('#library');
    const q = $('#search').value.trim().toLowerCase();
    const throneId = state?.throne?.song?.id;
    const busy = new Set([state?.duel?.challenger?.id, ...(state?.queue || []).map((x) => x.song.id)]);
    const list = library.filter((s) =>
      (libFilter === 'all' || (libFilter === 'original' ? s.original : !s.original)) &&
      (!q || s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q)));
    if (!library.length) {
      el.innerHTML = '<div class="idle" style="margin-top:6px"><strong>Списъкът е празен</strong>Добави първата песен.<button class="btn small" data-open-add>Добави песен</button></div>';
      return;
    }
    const ytHint = q ? `<div class="yt-hint"><span>Не е в списъка?</span><button class="btn small" data-yt-search="${esc($('#search').value.trim())}">Търси в YouTube</button></div>` : '';
    if (!list.length) { el.innerHTML = `<p class="empty">Няма такава песен в списъка.</p>${ytHint}`; return; }
    el.innerHTML = list.map((s) => {
      const onThrone = s.id === throneId;
      const waiting = busy.has(s.id);
      const action = onThrone || waiting ? ''
        : `<button class="btn small" data-challenge="${s.id}">${throneId ? 'Предизвикай' : 'На трона'}</button>`;
      const status = onThrone ? '<span class="tag-text gold">на трона</span>' : waiting ? '<span class="tag-text">чака дуел</span>' : '';
      const sub = [artistLink(s.artist), status, s.duelWins ? plural(s.duelWins, 'победа', 'победи') : '']
        .filter(Boolean).join(', ');
      return `<div class="row ${onThrone ? 'on-throne' : ''}">
        ${thumb(s)}
        <div style="min-width:0"><div class="t" title="${esc(s.title)}">${esc(s.title)}</div><div class="s">${sub}</div></div>
        <div class="end">
          <button class="ibtn" data-preview="${s.id}" title="Чуй" aria-label="Чуй ${esc(s.title)}">${ICON.play}</button>
          ${s.original ? `<button class="ibtn stroke" data-tip="${s.id}" title="Бакшиш" aria-label="Бакшиш">${ICON.coin}</button>` : ''}
          ${action}
        </div>
      </div>`;
    }).join('') + ytHint;
  }

  function updateTimers() {
    if (!state) return;
    const now = serverNow();
    if (state.throne) $('#reign-timer').textContent = fmt(now - state.throne.since);
    $$('[data-countdown]').forEach((el) => {
      const left = Number(el.dataset.countdown) - now;
      el.textContent = left > 0 ? fmt(left + 999) : '0:00';
    });
    $$('[data-since]').forEach((el) => { el.textContent = fmt(now - Number(el.dataset.since)); });
  }
  setInterval(updateTimers, 500);

  // ---------- Табове ----------
  function showTab(name) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === name));
  }
  $$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

  // На телефон дуелът се мести в табовете отдолу
  const duelPanel = $('#panel-duel');
  const mobileDuel = document.createElement('section');
  mobileDuel.className = 'tab-panel';
  mobileDuel.dataset.panel = 'duel';
  $('#tab-panels').prepend(mobileDuel);
  const mq = window.matchMedia('(max-width: 1023px)');
  function placeDuel() {
    if (mq.matches) {
      mobileDuel.appendChild(duelPanel);
      if (!$('.tab.active') || $('.tab.active').dataset.tab === 'songs') showTab(state?.duel ? 'duel' : 'songs');
    } else {
      $('#col-left').appendChild(duelPanel);
      if ($('.tab.active')?.dataset.tab === 'duel') showTab('songs');
    }
  }
  mq.addEventListener('change', placeDuel);
  placeDuel();

  // ---------- Плейър ----------
  // Музиката тръгва сама. Ако браузърът не позволява звук, преди човек да е кликнал,
  // тя върви без звук и звукът се включва при първото кликване където и да е.
  // Всеки слушател чува песента от нейното начало (startAt) до края ѝ (endAt), после отначало.
  const audio = $('#audio-player');
  const cover = $('#cover');
  const listenBtn = $('#listen-btn');
  const volume = $('#volume');
  const player = { listening: true, mode: 'throne', previewSong: null, key: null, yt: null, current: null, currentId: null };
  const sound = { unlocked: false };

  volume.value = lsGet('bc_volume') || '80';
  function applyVolume() {
    const v = Number(volume.value);
    audio.volume = v / 100;
    try { if (player.yt && player.yt.setVolume) player.yt.setVolume(v); } catch { /* ignore */ }
    lsSet('bc_volume', String(v));
  }
  volume.addEventListener('input', applyVolume);
  applyVolume();

  // Проверка дали браузърът позволява звук без кликване (с кратък беззвучен файл)
  function silentWavUrl() {
    const n = 800, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, n * 2, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }
  async function probeSound() {
    try {
      const a = new Audio(silentWavUrl());
      a.volume = 0;
      await a.play();
      a.pause();
      return true;
    } catch { return false; }
  }

  function applyMute() {
    const muted = !sound.unlocked;
    audio.muted = muted;
    try {
      if (player.yt && player.yt.mute) { if (muted) player.yt.mute(); else player.yt.unMute(); }
    } catch { /* ignore */ }
    updateTransport();
  }

  function unlockSound() {
    if (sound.unlocked) return;
    sound.unlocked = true;
    // Кликът, който е включил звука, не трябва едновременно да спре музиката
    sound.justUnlocked = true;
    setTimeout(() => { sound.justUnlocked = false; }, 600);
    removeUnlockListeners();
    applyMute();
    applyVolume();
    // Ако браузърът е спрял файла, пусни го отново, вече със звук
    if (player.listening && player.current && player.current.type === 'audio' && audio.paused) audio.play().catch(() => {});
    try { if (player.listening && player.yt && player.yt.playVideo && player.current?.type === 'youtube') player.yt.playVideo(); } catch { /* ignore */ }
  }
  const UNLOCK_EVENTS = ['pointerdown', 'keydown', 'touchend'];
  const onFirstGesture = () => unlockSound();
  function addUnlockListeners() { UNLOCK_EVENTS.forEach((ev) => window.addEventListener(ev, onFirstGesture, { capture: true })); }
  function removeUnlockListeners() { UNLOCK_EVENTS.forEach((ev) => window.removeEventListener(ev, onFirstGesture, { capture: true })); }
  addUnlockListeners();
  probeSound().then((ok) => { if (ok) unlockSound(); });

  function desired() {
    if (player.mode === 'preview' && player.previewSong) return player.previewSong;
    return state?.throne?.song || null;
  }

  function setCover(song, playing) {
    const inner = cover.querySelector('.cover-inner');
    if (song && song.type === 'youtube') {
      cover.style.backgroundImage = `url(${ytThumb(song.videoId, 'hqdefault')})`;
      cover.classList.add('has-img');
    } else {
      cover.style.backgroundImage = '';
      cover.classList.remove('has-img');
      inner.innerHTML = song
        ? (playing ? '<div class="eq"><i></i><i></i><i></i><i></i></div>' : ICON.note) + `<span>${esc(song.title)}</span>`
        : `${ICON.crown}<span>Тронът е свободен</span>`;
    }
    cover.classList.toggle('playing', !!playing);
  }

  function showYt(on) {
    $('#yt-holder').classList.toggle('hidden', !on);
    cover.classList.toggle('hidden', on);
  }

  function updateTransport() {
    const song = desired();
    const line = $('#now-line');
    const sub = $('#now-sub');
    const preview = player.mode === 'preview' && player.previewSong && player.listening;
    const mutedNow = player.listening && !sound.unlocked;
    listenBtn.classList.toggle('on', player.listening);
    listenBtn.setAttribute('aria-label', player.listening ? 'Спри' : 'Пусни');
    $('#back-btn').classList.toggle('hidden', !preview);
    $('#unmute-btn').classList.toggle('hidden', !mutedNow || !song);
    $('#trim-btn').classList.toggle('hidden', !(song && song.canEdit));
    sub.classList.toggle('preview', !!preview);
    sub.classList.toggle('muted-hint', mutedNow);
    if (!song) { line.textContent = 'Тронът е свободен'; sub.textContent = 'Добави песен и тя започва веднага.'; return; }
    line.textContent = `${song.title}, ${song.artist}`;
    if (!player.listening) sub.textContent = 'Спряно. Натисни, за да продължиш.';
    else if (mutedNow) sub.innerHTML = '<span class="dot"></span>Без звук. Кликни където и да е.';
    else if (preview) sub.innerHTML = '<span class="dot"></span>Преглед на песен, която не е на трона';
    else sub.innerHTML = '<span class="dot"></span>Слушаш заедно с всички';
  }

  function syncPlayer() {
    const song = desired();
    updateTransport();
    if (!player.listening) { setCover(song, false); showYt(false); positionVideo(); return; }
    if (!song) { stopAll(); setCover(null, false); showYt(false); positionVideo(); return; }
    // Пускаме наново, ако се смени песента, режимът, царуването или началото/краят ѝ
    const since = player.mode === 'throne' ? state?.throne?.since : 'preview';
    const key = [song.id, player.mode, since, song.startAt || 0, song.endAt || '', JSON.stringify(song.skips || [])].join('|');
    if (key !== player.key) {
      player.key = key;
      play(song);
    } else {
      player.current = song;
    }
    positionVideo();
  }

  // ---------- Времева линия на музиката ----------
  // Песента се състои от частите с музика: от началото до края, без частите за прескачане.
  // Всички слушатели са на едно и също място в тази линия, броено от момента, в който песента е седнала на трона.
  const startOf = (s) => Math.max(0, Number(s?.startAt) || 0);
  const endOf = (s) => (s && s.endAt ? Number(s.endAt) : null);
  function musicRanges(song, duration) {
    const start = startOf(song);
    const end = Math.min(endOf(song) || duration || Infinity, duration || Infinity);
    if (!Number.isFinite(end) || end <= start) return [];
    let ranges = [[start, end]];
    for (const [a, b] of song.skips || []) {
      ranges = ranges.flatMap(([x, y]) => (b <= x || a >= y ? [[x, y]] : [
        ...(a > x ? [[x, a]] : []),
        ...(b < y ? [[b, y]] : []),
      ]));
    }
    return ranges.filter(([x, y]) => y - x > 1);
  }
  // Къде трябва да е песента точно сега
  function targetTime(song, duration) {
    const ranges = musicRanges(song, duration);
    if (!ranges.length) return startOf(song);
    if (player.mode !== 'throne' || !state?.throne?.since) return ranges[0][0];
    const total = ranges.reduce((sum, [x, y]) => sum + (y - x), 0);
    let p = (((serverNow() - state.throne.since) / 1000) % total + total) % total;
    for (const [x, y] of ranges) {
      if (p < y - x) return x + p;
      p -= y - x;
    }
    return ranges[0][0];
  }
  const durationOf = (s) => {
    try { return s.type === 'youtube' ? player.yt?.getDuration?.() || null : (Number.isFinite(audio.duration) ? audio.duration : null); } catch { return null; }
  };

  function play(song) {
    player.current = song;
    player.currentId = song.id;
    player.needsSync = true;
    if (song.type === 'youtube') {
      audio.pause();
      showYt(true);
      loadYt(song);
    } else {
      stopYt();
      showYt(false);
      setCover(song, true);
      audio.muted = !sound.unlocked;
      audio.onloadedmetadata = () => {
        try { audio.currentTime = targetTime(song, audio.duration); } catch { /* ignore */ }
        player.needsSync = false;
        audio.play().catch(() => {
          // Браузърът не позволява звук без кликване: пускаме без звук, звукът се включва при първия клик
          sound.unlocked = false;
          addUnlockListeners();
          audio.muted = true;
          audio.play().catch(() => {});
          updateTransport();
        });
      };
      audio.src = song.audioUrl;
      audio.load();
    }
  }

  function ensureYtApi(cb) {
    if (window.YT && window.YT.Player) return cb();
    (ensureYtApi.queue ||= []).push(cb);
    if (ensureYtApi.loading) return;
    ensureYtApi.loading = true;
    window.onYouTubeIframeAPIReady = () => { ensureYtApi.queue.forEach((f) => f()); ensureYtApi.queue = []; };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => toast('YouTube не се зарежда. Провери връзката с интернет.', true);
    document.head.appendChild(s);
  }

  function loadYt(song) {
    ensureYtApi(() => {
      if (!player.listening || player.current !== song) return;
      // Продължителността още не се знае, затова тръгваме от приблизителното място и уточняваме при пускане
      const first = Math.floor(targetTime(song, song.endAt || null));
      if (!player.yt) {
        player.yt = new YT.Player('yt-player', {
          videoId: song.videoId,
          playerVars: { autoplay: 1, playsinline: 1, rel: 0, mute: sound.unlocked ? 0 : 1, start: first },
          events: {
            onReady: (e) => { player.ytReady = true; applyVolume(); applyMute(); e.target.playVideo(); },
            onStateChange: onYtState,
            onError: () => toast('Авторът на това видео е забранил вграждането. Избери друга песен.', true),
          },
        });
      } else if (player.ytReady) {
        applyMute();
        player.yt.loadVideoById({ videoId: song.videoId, startSeconds: first });
      }
    });
  }

  // Слага песента на правилното място (за всички еднакво, когато е на трона)
  function seekToTarget() {
    const s = player.current;
    if (!s) return;
    const t = targetTime(s, durationOf(s));
    if (s.type === 'youtube') { try { player.yt.seekTo(t, true); player.yt.playVideo(); } catch { /* ignore */ } }
    else { try { audio.currentTime = t; audio.play().catch(() => {}); } catch { /* ignore */ } }
  }

  function onYtState(e) {
    const S = YT.PlayerState;
    if (e.data === S.PLAYING && player.needsSync) {
      const d = player.yt.getDuration();
      if (d > 0) {
        player.needsSync = false;
        const want = targetTime(player.current, d);
        if (Math.abs(player.yt.getCurrentTime() - want) > 1.5) player.yt.seekTo(want, true);
      }
    }
    if (e.data === S.ENDED) {
      if (player.mode === 'preview') { backToThrone(); return; }
      seekToTarget();
    }
  }

  // Прескача частите без музика и връща песента в началото след края ѝ
  setInterval(() => {
    const s = player.current;
    if (!player.listening || !s || player.needsSync) return;
    let t = null;
    try { t = s.type === 'youtube' ? player.yt?.getCurrentTime?.() : audio.currentTime; } catch { /* ignore */ }
    if (t == null) return;
    const ranges = musicRanges(s, durationOf(s));
    if (!ranges.length) return;
    const last = ranges[ranges.length - 1][1];
    if (t >= last - 0.2) {
      if (player.mode === 'preview') backToThrone();
      else seekToTarget();
      return;
    }
    const inside = ranges.some(([x, y]) => t >= x - 0.5 && t < y);
    if (!inside) {
      // В част без музика: скачаме до следващата част с музика
      const next = ranges.find(([x]) => x > t);
      const to = next ? next[0] : ranges[0][0];
      if (s.type === 'youtube') { try { player.yt.seekTo(to, true); } catch { /* ignore */ } }
      else { try { audio.currentTime = to; } catch { /* ignore */ } }
    }
  }, 400);

  const currentTime = () => {
    try { return player.current?.type === 'youtube' ? player.yt?.getCurrentTime?.() ?? null : audio.currentTime; } catch { return null; }
  };

  function stopYt() { try { if (player.yt && player.yt.pauseVideo) player.yt.pauseVideo(); } catch { /* ignore */ } }
  function stopAll() { stopYt(); audio.pause(); player.key = null; player.currentId = null; player.current = null; }

  function setListening(on) {
    player.listening = on;
    if (!on) { stopAll(); player.mode = 'throne'; player.previewSong = null; }
    player.key = null;
    syncPlayer();
  }

  function preview(song) {
    player.mode = 'preview';
    player.previewSong = song;
    player.listening = true;
    player.key = null;
    syncPlayer();
  }

  function backToThrone() {
    player.mode = 'throne';
    player.previewSong = null;
    player.key = null;
    syncPlayer();
  }

  audio.addEventListener('ended', () => {
    if (player.mode === 'preview') backToThrone();
    else seekToTarget();
  });
  audio.addEventListener('error', () => { if (player.listening && audio.src) toast('Файлът не може да се пусне.', true); });
  listenBtn.addEventListener('click', () => {
    if (sound.justUnlocked && player.listening) return;
    setListening(!player.listening);
  });
  $('#back-btn').addEventListener('click', backToThrone);
  $('#unmute-btn').addEventListener('click', unlockSound);

  // ---------- Начало и край на песента ----------
  const trimDialog = $('#trim-dialog');
  let trimSong = null;
  const fmtTime = (sec) => {
    if (sec == null || sec === '' || !Number.isFinite(Number(sec))) return '';
    const s = Math.max(0, Number(sec));
    const m = Math.floor(s / 60);
    const r = s - m * 60;
    const whole = Math.floor(r);
    const tenth = Math.round((r - whole) * 10);
    return `${m}:${String(whole).padStart(2, '0')}${tenth ? '.' + tenth : ''}`;
  };
  function openTrim(songId) {
    const s = songIndex.get(songId) || (player.current && player.current.id === songId ? player.current : null);
    if (!s) return;
    trimSong = s;
    $('#trim-song').textContent = `${s.title}, ${s.artist}`;
    $('#trim-start').value = s.startAt ? fmtTime(s.startAt) : '';
    $('#trim-end').value = s.endAt ? fmtTime(s.endAt) : '';
    const skips = (s.skips || []).map(([a, b]) => `${fmtTime(a)}–${fmtTime(b)}`).join(', ');
    const skipNote = skips ? ` Прескачат се и частите ${skips}.` : '';
    let source;
    if (s.trimSource === 'auto') source = `Открито автоматично: музиката почва на ${fmtTime(s.startAt)}${s.endAt ? ` и свършва на ${fmtTime(s.endAt)}` : ''}.${skipNote}`;
    else if (s.trimSource === 'manual') source = `Зададено ръчно.${skipNote}${s.autoAvailable ? ' Има и автоматично открито начало, можеш да се върнеш към него.' : ''}`;
    else if (s.type === 'youtube') source = 'За този клип няма данни къде почва музиката, затова върви от самото начало. Можеш да го зададеш ръчно.';
    else source = 'Задай откъде да почва и къде да свършва песента, ако има тишина в началото или края.';
    $('#trim-source').textContent = source;
    $('#trim-auto').classList.toggle('hidden', s.type !== 'youtube');
    updateTrimNow();
    trimDialog.showModal();
  }
  $('#trim-auto').addEventListener('click', async () => {
    if (!trimSong) return;
    const btn = $('#trim-auto');
    btn.disabled = true;
    try {
      const r = await post(`/api/songs/${trimSong.id}/trim`, { auto: true });
      indexSongs([r.song]);
      trimDialog.close();
      toast(r.found ? `Открито: музиката почва на ${fmtTime(r.song.startAt)}.` : 'За този клип няма данни. Върви от самото начало.');
      refresh();
      loadLibrary();
    } catch (err) { toast(err.message, true); }
    btn.disabled = false;
  });
  function updateTrimNow() {
    const playingThis = trimSong && player.current && player.current.id === trimSong.id && player.listening;
    $$('[data-now]').forEach((b) => { b.disabled = !playingThis; });
    const t = playingThis ? currentTime() : null;
    $('#trim-now').textContent = playingThis
      ? `Песента е на ${fmtTime(t)}. „Сега“ взима това време.`
      : 'Пусни песента, за да можеш да вземеш времето с „Сега“.';
  }
  setInterval(() => { if (trimDialog.open) updateTrimNow(); }, 500);
  $$('[data-now]').forEach((b) => b.addEventListener('click', () => {
    const t = currentTime();
    if (t == null) return;
    $(b.dataset.now === 'start' ? '#trim-start' : '#trim-end').value = fmtTime(Math.round(t * 10) / 10);
  }));
  $('#trim-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!trimSong) return;
    try {
      const r = await post(`/api/songs/${trimSong.id}/trim`, {
        startAt: $('#trim-start').value.trim(), endAt: $('#trim-end').value.trim(),
      });
      indexSongs([r.song]);
      trimDialog.close();
      toast('Запазено. Песента вече почва от ' + fmtTime(r.song.startAt || 0) + '.');
      refresh();
      loadLibrary();
    } catch (err) { toast(err.message, true); }
  });
  $('#trim-btn').addEventListener('click', () => { const s = desired(); if (s) openTrim(s.id); });

  // ---------- Действия ----------
  async function challenge(songId) {
    if (needLogin('Влез, за да предизвикаш трона.')) return;
    try {
      const r = await post('/api/challenge', { songId });
      if (r.crowned) toast('Песента зае трона.');
      else if (r.startedNow) toast('Дуелът започна. Гласувай.');
      else toast(`Добавена в опашката, на ${r.position}. място.`);
      refresh();
    } catch (e) { toast(e.message, true); }
  }

  async function vote(side) {
    if (needLogin('Влез, за да гласуваш.')) return;
    try {
      const r = await post('/api/vote', { side, duelId: state?.duel?.id });
      // Гласът се отбелязва веднага; новият брой гласове идва с живото обновление
      myVotes[r.duelId] = r.side;
      if (state?.duel && state.duel.id === r.duelId) {
        state.duel.myVote = r.side;
        renderDuel();
        updateTimers();
      }
    } catch (e) { toast(e.message, true); }
  }

  // ---------- Добавяне на песен ----------
  const addDialog = $('#add-dialog');
  function showAddTab(name) {
    $$('[data-addtab]').forEach((b) => b.classList.toggle('active', b.dataset.addtab === name));
    $$('[data-addpanel]').forEach((p) => p.classList.toggle('hidden', p.dataset.addpanel !== name));
  }
  $$('[data-addtab]').forEach((b) => b.addEventListener('click', () => showAddTab(b.dataset.addtab)));
  function openAdd(query) {
    if (needLogin('Влез, за да добавяш песни.')) return;
    showAddTab('search');
    if (!addDialog.open) addDialog.showModal();
    const input = $('#yt-q');
    if (query) { input.value = query; runSearch(query); }
    else if (!searchResults.length) renderResults();
    input.focus();
    input.select();
  }
  $('#add-btn').addEventListener('click', () => openAdd());

  // ---------- Търсене в YouTube ----------
  let searchResults = [];
  let searchState = 'idle';   // idle | loading | done | error | nokey
  let searchError = '';
  let searchSeq = 0;
  const pending = new Set();  // клипове, които се добавят в момента

  function resultSong(r) {
    // Временна песен, за да може да се чуе, преди да е добавена
    return { id: 'yt:' + r.videoId, type: 'youtube', videoId: r.videoId, title: r.title, artist: r.artist, startAt: 0, endAt: null, skips: [] };
  }

  function renderResults() {
    const el = $('#yt-results');
    if (searchState === 'loading') { el.innerHTML = '<div class="state">Търся…</div>'; return; }
    if (searchState === 'nokey') {
      el.innerHTML = `<div class="state"><strong>Търсенето още не е включено</strong>
        Трябва ключ за YouTube във файла <code>.env</code> (стъпките са в README). Дотогава можеш да поставиш линк.
        <div style="margin-top:10px"><button class="btn small" data-addtab-go="yt">Постави линк</button></div></div>`;
      return;
    }
    if (searchState === 'error') { el.innerHTML = `<div class="state"><strong>Търсенето не мина</strong>${esc(searchError)}</div>`; return; }
    if (searchState === 'idle') { el.innerHTML = '<div class="state">Напиши име на песен или изпълнител. Показват се само клипове, които могат да се пускат в сайта.</div>'; return; }
    if (!searchResults.length) { el.innerHTML = '<div class="state">Нищо не излезе. Пробвай с име на изпълнител и песен.</div>'; return; }
    const throneId = state?.throne?.song?.id;
    el.innerHTML = searchResults.map((r, i) => {
      let action;
      if (pending.has(r.videoId)) action = '<button class="btn small" disabled>Добавя се…</button>';
      else if (r.songId && r.songId === throneId) action = '<span class="tag-text gold">На трона</span>';
      else if (r.songId) action = `<button class="btn small" data-challenge="${r.songId}">${throneId ? 'Предизвикай' : 'На трона'}</button>`;
      else action = `<button class="btn small primary" data-add-result="${i}">Добави</button>`;
      return `<div class="result">
        ${r.thumb ? `<img src="${esc(r.thumb)}" alt="" loading="lazy">` : '<div class="ph"></div>'}
        <div style="min-width:0"><div class="t" title="${esc(r.rawTitle)}">${esc(r.title)}</div>
          <div class="s">${esc(r.artist)}${r.songId ? ', вече е в списъка' : ''}</div></div>
        <div class="end">
          <button class="ibtn" data-preview-result="${i}" title="Чуй" aria-label="Чуй ${esc(r.title)}">${ICON.play}</button>
          ${action}
        </div>
      </div>`;
    }).join('');
  }

  async function runSearch(q) {
    q = String(q || '').trim();
    if (q.length < 2) return;
    const seq = ++searchSeq;
    searchState = 'loading';
    renderResults();
    try {
      const r = await fetch('/api/yt-search?q=' + encodeURIComponent(q));
      const j = await r.json().catch(() => ({}));
      if (seq !== searchSeq) return;
      if (r.status === 501 && j.needsKey) { searchState = 'nokey'; }
      else if (!r.ok) { searchState = 'error'; searchError = j.error || 'Опитай пак.'; }
      else { searchState = 'done'; searchResults = j.results || []; }
    } catch {
      if (seq !== searchSeq) return;
      searchState = 'error'; searchError = 'Няма връзка със сървъра.';
    }
    renderResults();
  }

  $('#yt-search-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch($('#yt-q').value); });

  async function addResult(i) {
    const r = searchResults[i];
    if (!r || pending.has(r.videoId)) return;
    pending.add(r.videoId);
    renderResults();
    try {
      const res = await post('/api/songs', {
        url: 'https://www.youtube.com/watch?v=' + r.videoId, title: r.title, artist: r.artist,
      });
      indexSongs([res.song]);
      r.songId = res.song.id;
      if ($('#search-challenge').checked) await challenge(res.song.id);
      else toast(`Добавена: ${res.song.title}`);
      loadLibrary();
    } catch (err) { toast(err.message, true); }
    pending.delete(r.videoId);
    renderResults();
  }

  $('#yt-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const r = await post('/api/songs', {
        url: f.url.value, title: f.title.value, artist: f.artist.value, startAt: f.startAt.value.trim(),
      });
      indexSongs([r.song]);
      if (f.challenge.checked) await challenge(r.song.id);
      else toast(r.existing ? 'Тази песен вече е в списъка.' : `Добавена: ${r.song.title}`);
      f.url.value = ''; f.title.value = ''; f.artist.value = ''; f.startAt.value = '';
      addDialog.close();
      loadLibrary();
    } catch (err) { toast(err.message, true); }
    btn.disabled = false;
  });

  const fileInput = $('#upload-form input[type=file]');
  const fileLabel = $('#upload-form .file-label');
  const FILE_HINT = fileLabel.textContent;
  fileInput.addEventListener('change', () => {
    const name = fileInput.files[0]?.name;
    fileLabel.textContent = name || FILE_HINT;
    const titleInput = $('#upload-form').title;
    if (name && !titleInput.value) titleInput.value = name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
  });

  $('#upload-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button[type=submit]');
    const file = fileInput.files[0];
    if (!file) { toast('Избери аудио файл.', true); return; }
    const ext = (file.name.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
    const params = new URLSearchParams({
      title: f.title.value, artist: f.artist.value,
      original: f.original.checked ? 'true' : 'false', ext,
    });
    btn.disabled = true;
    btn.textContent = 'Качване…';
    try {
      const r = await api('/api/upload?' + params, {
        method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file,
      });
      indexSongs([r.song]);
      if (f.challenge.checked) await challenge(r.song.id);
      else toast(`Качена: ${r.song.title}`);
      f.reset();
      f.challenge.checked = true;
      fileLabel.textContent = FILE_HINT;
      addDialog.close();
      loadLibrary();
    } catch (err) { toast(err.message, true); }
    btn.disabled = false;
    btn.textContent = 'Качи песента';
  });

  // ---------- Бакшиши ----------
  const tipDialog = $('#tip-dialog');
  const tipCustom = $('#tip-custom');
  let tipSongId = null;
  let tipAmount = 2;
  const tipValue = () => (tipCustom.value ? Math.round(Number(tipCustom.value)) : tipAmount);

  function updateTipButton() {
    const v = tipValue();
    const ok = Number.isFinite(v) && v >= 1 && v <= 50;
    $('#tip-submit').textContent = ok ? `Изпрати ${eur(v)}` : 'Сумата е от 1 до 50 €';
    $('#tip-submit').disabled = !ok;
  }

  async function openTip(songId) {
    if (needLogin('Влез, за да пращаш бакшиши.')) return;
    const s = songIndex.get(songId);
    if (!s) return;
    tipSongId = songId;
    $('#tip-artist').textContent = s.artist;
    $('#tip-song').textContent = `За песента „${s.title}“`;
    $('#tip-message').value = '';
    tipCustom.value = '';
    tipAmount = 2;
    $$('.amount').forEach((x) => x.classList.toggle('active', Number(x.dataset.amount) === tipAmount));
    updateTipButton();
    const note = $('#tip-fan-note');
    note.textContent = '';
    tipDialog.showModal();
    try {
      const a = await api(`/api/artist?name=${encodeURIComponent(s.artist)}`);
      if (!account) note.textContent = 'Влез, за да можеш да станеш най-голям фен на артиста.';
      else if (a.fans.some((f) => f.isMe && f.isBiggestFan)) note.textContent = `Ти си най-големият фен на ${a.artist}. Всяко евро ти носи ${a.points.euro} точки.`;
      else if (a.biggestFan) {
        const mine = a.me ? a.me.score : 0;
        const need = Math.max(1, Math.ceil((a.biggestFan.score - mine + 1) / a.points.euro));
        note.textContent = `Най-голям фен е ${a.biggestFan.name} с ${a.biggestFan.score} точки. С ${eur(need)} заемаш първото място.`;
      } else note.textContent = `${a.artist} още няма най-голям фен. С този бакшиш ставаш ти.`;
    } catch { /* без бележка */ }
  }

  $$('.amount').forEach((b) => b.addEventListener('click', () => {
    tipAmount = Number(b.dataset.amount);
    tipCustom.value = '';
    $$('.amount').forEach((x) => x.classList.toggle('active', x === b));
    updateTipButton();
  }));
  tipCustom.addEventListener('input', () => {
    $$('.amount').forEach((x) => x.classList.toggle('active', !tipCustom.value && Number(x.dataset.amount) === tipAmount));
    updateTipButton();
  });

  $('#tip-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const amount = tipValue();
    if (!tipSongId) return;
    const btn = $('#tip-submit');
    btn.disabled = true;
    try {
      const r = await post('/api/tip', { songId: tipSongId, amount, message: $('#tip-message').value });
      tipDialog.close();
      toast(r.becameBiggestFan ? 'Изпратено. Вече си най-големият фен на артиста.' : `Изпратено: ${eur(amount)}. Тестов режим.`);
      loadBadges();
    } catch (err) { toast(err.message, true); }
    btn.disabled = false;
  });

  // ---------- Артист ----------
  const artistDialog = $('#artist-dialog');
  async function openArtist(name) {
    const head = $('#artist-head');
    const body = $('#artist-body');
    head.innerHTML = `<div class="artist-name">${esc(name)}</div>`;
    body.innerHTML = '<p class="muted">Зарежда се…</p>';
    if (!artistDialog.open) artistDialog.showModal();
    try {
      const a = await api(`/api/artist?name=${encodeURIComponent(name)}`);
      indexSongs(a.songs);
      const tipSong = a.songs.find((s) => s.original);
      head.innerHTML = `<div class="artist-name">${esc(a.artist)}</div>
        <p class="note" style="margin:2px 0 0">${a.original ? 'Нов артист с оригинална музика' : 'Песни от YouTube'}</p>`;
      body.innerHTML = `
        <div class="stats">
          <div class="stat"><b>${a.totals.wins}</b><span>${a.totals.wins === 1 ? 'победа' : 'победи'}</span></div>
          <div class="stat"><b>${a.totals.defenses}</b><span>${a.totals.defenses === 1 ? 'защита' : 'защити'}</span></div>
          <div class="stat"><b>${a.original ? eur(a.totals.tips) : '—'}</b><span>бакшиши</span></div>
        </div>
        <div class="fan-hero">${ICON.medal}
          ${a.biggestFan
            ? `<div><div class="s">Най-голям фен</div><div class="who">${esc(a.biggestFan.name)}</div><div class="s">${a.biggestFan.score} точки</div></div>`
            : '<div><div class="who">Още няма най-голям фен</div><div class="s">Гласувай за песните на артиста или изпрати бакшиш.</div></div>'}
        </div>
        ${a.fans.length ? `<div>
          <div class="section-title">Фенове</div>
          <table class="table">
            <thead><tr><th></th><th>Име</th><th class="r">Гласове</th><th class="r">Бакшиши</th><th class="r">Точки</th></tr></thead>
            <tbody>${a.fans.map((f, i) => `<tr class="${f.isMe ? 'me' : ''}">
              <td class="${i === 0 ? 'gold' : 'muted'}">${i + 1}</td>
              <td>${esc(f.name)}${f.isMe ? ' <span class="muted">(ти)</span>' : ''}</td>
              <td class="r">${f.votes}</td><td class="r">${eur(f.tips)}</td><td class="r pts ${f.isBiggestFan ? 'gold' : ''}">${f.score}</td></tr>`).join('')}</tbody>
          </table></div>` : ''}
        <p class="note" style="margin:0">${a.me ? (a.me.rank ? `Ти си на ${a.me.rank}. място с ${a.me.score} точки.` : `Имаш ${a.me.score} точки. Напиши името си горе, за да се появиш в класацията.`) : 'Още нямаш точки за този артист.'}
          Всеки глас носи ${a.points.vote} точка, всяко евро бакшиш носи ${a.points.euro}. Гласовете се броят след края на дуела.</p>
        ${a.recentTips.length ? `<div><div class="section-title">Бакшиши</div>${a.recentTips.map((t) => `
          <div class="feed-item"><div class="line"><span class="amt">${eur(t.amount)}</span> от ${esc(t.by)}</div>
            <div class="s">${esc(t.songTitle)}</div>${t.message ? `<div class="msg">${esc(t.message)}</div>` : ''}</div>`).join('')}</div>` : ''}
        <div><div class="section-title">Песни</div>${a.songs.map((s) => `
          <div class="row">${thumb(s)}<div style="min-width:0"><div class="t">${esc(s.title)}</div>
            <div class="s">${plural(s.duelWins, 'победа', 'победи')}, ${plural(s.defenses, 'защита', 'защити')}</div></div>
            <button class="ibtn" data-preview="${s.id}" title="Чуй" aria-label="Чуй">${ICON.play}</button></div>`).join('')}</div>
        ${tipSong ? `<button class="btn primary wide" data-tip="${tipSong.id}">Изпрати бакшиш на ${esc(a.artist)}</button>` : ''}`;
    } catch (err) {
      body.innerHTML = `<p class="empty">${esc(err.message)}</p>`;
    }
  }

  // ---------- Значки ----------
  const badgesDialog = $('#badges-dialog');
  let me = null;
  async function loadBadges() {
    try {
      me = await api('/api/me');
      $('#badge-count').textContent = me.badges.length;
      $('#badges-btn').classList.toggle('has', me.badges.length > 0);
      if (badgesDialog.open) renderBadges();
    } catch { /* ignore */ }
  }
  function renderBadges() {
    const body = $('#badges-body');
    if (!me) { body.innerHTML = '<p class="muted">Зарежда се…</p>'; return; }
    body.innerHTML = `
      ${account ? '' : '<p class="callout">Влез, за да трупаш точки и да печелиш значки.</p>'}
      <p class="note" style="margin:0">Ставаш най-голям фен на артист, когато имаш най-много точки за него. Всеки глас носи ${me.points.vote} точка, всяко евро бакшиш носи ${me.points.euro}.</p>
      ${me.supported.length ? `<div>${me.supported.map((s) => `
        <div class="row">
          <div class="thumb" style="width:32px;color:${s.isBiggestFan ? 'var(--gold)' : 'var(--faint)'}">${ICON.medal}</div>
          <div style="min-width:0"><div class="t">${artistLink(s.artist)}</div>
            <div class="s">${s.isBiggestFan ? 'Най-голям фен, ' : ''}${plural(s.votes, 'глас', 'гласа')}, ${eur(s.tips)} бакшиши</div></div>
          <span class="num strong">${s.score} т.</span>
        </div>`).join('')}</div>`
      : '<p class="empty">Още не си подкрепял артисти. Гласувай в дуел или изпрати бакшиш.</p>'}`;
  }
  $('#badges-btn').addEventListener('click', async () => {
    renderBadges();
    badgesDialog.showModal();
    await loadBadges();
    renderBadges();
  });

  // ---------- Общи кликове ----------
  $$('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-close')) { b.closest('dialog').close(); return; }
    if (b.hasAttribute('data-open-add')) { openAdd(); return; }
    if (b.dataset.ytSearch !== undefined) { openAdd(b.dataset.ytSearch); return; }
    if (b.dataset.addtabGo) { showAddTab(b.dataset.addtabGo); return; }
    if (b.dataset.addResult !== undefined) { addResult(Number(b.dataset.addResult)); return; }
    if (b.dataset.previewResult !== undefined) {
      const r = searchResults[Number(b.dataset.previewResult)];
      if (r) { preview(resultSong(r)); toast(`Пускам „${r.title}“`); }
      return;
    }
    if (b.dataset.challenge && b.closest('#add-dialog')) { challenge(b.dataset.challenge); addDialog.close(); return; }
    if (b.dataset.artist) { openArtist(b.dataset.artist); return; }
    if (b.dataset.tip && artistDialog.open) artistDialog.close();
    if (b.dataset.preview && b.closest('dialog')) b.closest('dialog').close();
    if (b.dataset.listen) {
      // „Чуй“ в дуела: песента на трона звучи на живо, претендентът се пуска като преглед
      const d = state?.duel;
      if (!d) return;
      if (b.dataset.listen === 'champion') {
        if (player.mode === 'preview') backToThrone();
        if (!player.listening) setListening(true);
      } else if (d.challenger) preview(d.challenger);
      return;
    }
    if (b.dataset.trim) { openTrim(b.dataset.trim); return; }
    if (b.dataset.preview) { const s = songIndex.get(b.dataset.preview); if (s) preview(s); }
    else if (b.dataset.vote) vote(b.dataset.vote);
    else if (b.dataset.challenge) challenge(b.dataset.challenge);
    else if (b.dataset.tip) openTip(b.dataset.tip);
    else if (b.dataset.filter) {
      libFilter = b.dataset.filter;
      $$('[data-filter]').forEach((x) => x.classList.toggle('active', x === b));
      renderLibrary();
    }
  });
  $('#search').addEventListener('input', renderLibrary);

  // ---------- Вход и профил ----------
  const loginDialog = $('#login-dialog');
  const accountDialog = $('#account-dialog');
  const PROVIDER_NAMES = { google: 'Google', discord: 'Discord', dev: 'тестов вход' };

  function needLogin(reason) {
    if (account) return false;
    openLogin(reason);
    return true;
  }
  function openLogin(reason) {
    $('#login-reason').textContent = reason || 'Влез, за да гласуваш, добавяш песни и трупаш точки.';
    const box = $('#login-providers');
    box.innerHTML = loginOptions.providers.map((p) =>
      `<a class="btn wide" href="/auth/${esc(p.id)}"><span class="mark">${esc(p.label.charAt(0))}</span>Продължи с ${esc(p.label)}</a>`).join('');
    if (!loginOptions.providers.length && !loginOptions.devLogin) {
      box.innerHTML = '<p class="callout">Входът още не е настроен на този сървър.</p>';
    }
    $('#dev-login').classList.toggle('hidden', !loginOptions.devLogin);
    if (!loginDialog.open) loginDialog.showModal();
  }
  function renderAccount() {
    $('#login-btn').classList.toggle('hidden', !!account);
    $('#account-btn').classList.toggle('hidden', !account);
    if (!account) return;
    $('#account-name').textContent = account.name;
    const av = $('#account-avatar');
    if (account.avatar && /^https:\/\//.test(account.avatar)) {
      av.style.backgroundImage = `url("${account.avatar.replace(/"/g, '')}")`;
      av.textContent = '';
    } else {
      av.style.backgroundImage = '';
      av.textContent = account.name.trim().charAt(0).toUpperCase();
    }
  }
  async function loadSession() {
    try {
      const s = await api('/api/session');
      account = s.user;
      loginOptions = { providers: s.providers || [], devLogin: !!s.devLogin };
    } catch { account = null; }
    renderAccount();
    // Точките, натрупани в този браузър преди акаунтите, се прехвърлят веднъж
    if (account && legacyVoterId && !lsGet('bc_claimed')) {
      try {
        const r = await post('/api/session/claim', { voterId: legacyVoterId });
        lsSet('bc_claimed', '1');
        if (r.moved) toast('Точките ти от този браузър са прехвърлени към профила.');
      } catch { /* ще опитаме при следващото отваряне */ }
    }
  }
  async function afterLoginChange() {
    await loadSession();
    refresh();
    loadLibrary();
    loadBadges();
  }
  function handleLoginResult() {
    const r = new URLSearchParams(location.search).get('login');
    if (!r) return;
    history.replaceState(null, '', location.pathname);
    if (r === 'ok') toast(account ? `Здравей, ${account.name}!` : 'Влезе успешно.');
    else if (r === 'unavailable') toast('Този начин за вход не е настроен.', true);
    else toast('Входът не мина. Опитай пак.', true);
  }

  $('#login-btn').addEventListener('click', () => openLogin());
  $('#dev-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await post('/auth/dev', { name: e.target.displayName.value.trim() });
      loginDialog.close();
      await afterLoginChange();
      toast(`Здравей, ${account?.name}!`);
    } catch (err) { toast(err.message, true); }
  });
  $('#account-btn').addEventListener('click', () => {
    if (!account) return;
    $('#account-name-input').value = account.name;
    $('#account-via').textContent = `Влязъл си с ${PROVIDER_NAMES[account.provider] || account.provider}.`;
    accountDialog.showModal();
  });
  $('#account-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await post('/api/session/name', { name: $('#account-name-input').value.trim() });
      account = r.user;
      renderAccount();
      accountDialog.close();
      toast('Името е сменено.');
    } catch (err) { toast(err.message, true); }
  });
  $('#logout-btn').addEventListener('click', async () => {
    try { await post('/auth/logout', {}); } catch { /* ignore */ }
    accountDialog.close();
    await afterLoginChange();
    toast('Излезе от профила.');
  });

  loadSession().then(handleLoginResult);
  refresh();
  loadLibrary();
})();
