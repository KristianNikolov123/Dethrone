(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } };
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));

  // ---------- Потребител ----------
  let voterId = lsGet('bc_voter');
  if (!voterId) { voterId = uid(); lsSet('bc_voter', voterId); }
  const nickInput = $('#nick');
  nickInput.value = lsGet('bc_nick') || '';
  nickInput.addEventListener('input', () => lsSet('bc_nick', nickInput.value.trim()));
  const nick = () => nickInput.value.trim() || 'Анонимен';

  // ---------- Състояние ----------
  let state = null;
  let skew = 0;
  let library = [];
  let libFilter = 'all';
  const songIndex = new Map();
  const serverNow = () => Date.now() + skew;

  function indexSongs(list) { for (const s of list) if (s) songIndex.set(s.id, s); }

  function fmt(ms) {
    let s = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(s / 86400); s %= 86400;
    const h = Math.floor(s / 3600); s %= 3600;
    const m = Math.floor(s / 60); s %= 60;
    const p = (n) => String(n).padStart(2, '0');
    if (d) return `${d}д ${h}ч ${p(m)}м`;
    if (h) return `${h}:${p(m)}:${p(s)}`;
    return `${m}:${p(s)}`;
  }

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
    if (!r.ok) throw new Error(j.error || 'Нещо се обърка.');
    return j;
  }
  const post = (p, body) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const ytThumb = (id, q = 'mqdefault') => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/${q}.jpg`;
  const thumb = (s) => s.type === 'youtube'
    ? `<img class="thumb" src="${ytThumb(s.videoId)}" alt="" loading="lazy" onerror="this.outerHTML='<div class=&quot;thumb&quot;>▶</div>'">`
    : '<div class="thumb orig">🎵</div>';
  const tag = (s) => (s.original ? '<span class="tag gold">Нов артист</span>' : '<span class="tag">YouTube</span>');

  // ---------- Данни ----------
  async function refresh() {
    try {
      const s = await api('/api/state?voterId=' + encodeURIComponent(voterId));
      skew = s.now - Date.now();
      state = s;
      indexSongs([s.throne?.song, s.duel?.champion, s.duel?.challenger, ...s.queue.map((q) => q.song)]);
      render();
      syncPlayer();
    } catch (e) { console.error(e); }
  }
  async function loadLibrary() {
    try {
      library = (await api('/api/songs')).songs;
      indexSongs(library);
      renderLibrary();
    } catch (e) { console.error(e); }
  }

  const es = new EventSource('/api/events');
  es.addEventListener('state', refresh);
  es.addEventListener('library', loadLibrary);
  es.addEventListener('open', () => { refresh(); loadLibrary(); });
  setInterval(refresh, 15000); // резервно, ако връзката прекъсне

  // ---------- Рендериране ----------
  function render() {
    renderThrone();
    renderDuel();
    renderQueue();
    renderHall();
    renderScouts();
    renderRecent();
    renderLibrary();
    updateTimers();
  }

  function renderThrone() {
    const el = $('#throne-info');
    const t = state.throne;
    if (!t || !t.song) {
      el.innerHTML = `<div class="tags"><span class="tag">Свободно</span></div>
        <h1 class="song-title">Тронът е празен</h1>
        <p class="meta">Добави песен отдолу и я прати на дуел. Първата сяда направо на трона.</p>`;
      $('#reign-timer').textContent = '—';
      return;
    }
    const s = t.song;
    el.innerHTML = `<div class="tags">${tag(s)}${state.duel ? '<span class="tag live">В дуел</span>' : ''}</div>
      <h1 class="song-title">${esc(s.title)}</h1>
      <p class="artist">${esc(s.artist)}</p>
      <p class="meta">Пратена от ${esc(s.addedBy)} · ${s.duelWins} ${s.duelWins === 1 ? 'победа' : 'победи'} · ${s.defenses} ${s.defenses === 1 ? 'защита' : 'защити'}${s.original ? ` · ${s.tipsTotal} лв. бакшиши` : ''}</p>
      ${s.original ? `<div class="row" style="margin-top:10px"><button class="btn gold small" data-tip="${s.id}">💸 Бакшиш</button></div>` : ''}`;
  }

  function renderDuel() {
    const el = $('#duel');
    const d = state.duel;
    if (!d) {
      el.className = 'card slim';
      if (state.queue.length && state.throne) {
        el.innerHTML = `<div class="between">⚔️ Следващ дуел започва след <b data-countdown="${state.nextDuelAt}">…</b></div>`;
      } else if (state.throne) {
        el.innerHTML = '<div class="between muted">Няма активен дуел. Избери песен от библиотеката и предизвикай трона!</div>';
      } else {
        el.innerHTML = '<div class="between muted">Дуелите започват, щом има песен на трона.</div>';
      }
      return;
    }
    const total = d.counts.champion + d.counts.challenger;
    const pct = (k) => (total ? Math.round((d.counts[k] * 100) / total) : 50);
    const leader = d.counts.challenger > d.counts.champion ? 'challenger' : (d.counts.champion > d.counts.challenger ? 'champion' : null);
    const side = (k, label) => {
      const s = d[k];
      if (!s) return '<div class="duel-side"><p class="empty">Песента е премахната.</p></div>';
      const mine = d.myVote === k;
      return `<div class="duel-side ${mine ? 'voted' : ''} ${leader === k ? 'leading' : ''}">
        <div class="duel-label">${label}</div>
        ${thumb(s)}
        <h3>${esc(s.title)}</h3>
        <p class="artist">${esc(s.artist)}</p>
        <div class="bar"><span style="width:${pct(k)}%"></span></div>
        <p class="votes"><b>${d.counts[k]}</b> ${d.counts[k] === 1 ? 'глас' : 'гласа'} · ${total ? pct(k) + '%' : '—'}</p>
        <div class="row">
          <button class="btn small" data-preview="${s.id}">▶ Чуй</button>
          <button class="btn small ${mine ? 'primary' : 'outline'}" data-vote="${k}">${mine ? '✓ Твоят глас' : 'Гласувай'}</button>
        </div>
      </div>`;
    };
    el.className = 'card duel';
    el.innerHTML = `<div class="duel-head">
        <h2><span class="tag live">На живо</span> Дуел за трона</h2>
        <span class="timer big" data-countdown="${d.endsAt}">…</span>
      </div>
      <p class="hint" style="margin:6px 0 0">Предизвикателят е пратен от <b>${esc(d.challengedBy)}</b>. Чуй и двете и гласувай. При равенство шампионът остава.</p>
      <div class="duel-grid">${side('champion', '👑 Шампион')}<div class="vs">VS</div>${side('challenger', '⚔️ Предизвикател')}</div>`;
  }

  function renderQueue() {
    const el = $('#queue');
    if (!state.queue.length) { el.innerHTML = '<p class="empty">Никой не чака. Ти ли ще си първият?</p>'; return; }
    el.innerHTML = state.queue.map((q, i) => `<div class="item">
      <span class="dur">${i + 1}.</span>${thumb(q.song)}
      <div class="grow"><div class="t">${esc(q.song.title)}</div><div class="s">${esc(q.song.artist)} · от ${esc(q.challengedBy)}</div></div>
    </div>`).join('');
  }

  function renderHall() {
    const el = $('#hall');
    if (!state.hallOfFame.length) { el.innerHTML = '<li class="empty">Още няма царувания.</li>'; return; }
    el.innerHTML = state.hallOfFame.map((r) => `<li>
      <div class="grow" style="flex:1;min-width:0"><div class="item"><div class="grow">
        <div class="t">${esc(r.song.title)} ${r.current ? '<span class="tag gold">сега</span>' : ''}</div>
        <div class="s">${esc(r.song.artist)}</div></div></div></div>
      <span class="dur" ${r.current ? `data-since="${r.start}"` : ''}>${fmt(r.duration)}</span>
    </li>`).join('');
  }

  function renderScouts() {
    const el = $('#scouts');
    if (!state.scouts.length) { el.innerHTML = '<li class="empty">Свали трона с песен, която си пратил, и влизаш тук.</li>'; return; }
    el.innerHTML = state.scouts.map((s) => `<li><div class="grow" style="flex:1;min-width:0"><div class="t">${esc(s.name)}</div></div>
      <span class="dur">${s.wins} ${s.wins === 1 ? 'сваляне' : 'сваляния'}</span></li>`).join('');
  }

  function renderRecent() {
    const el = $('#recent');
    if (!state.recentDuels.length) { el.innerHTML = '<p class="empty">Още няма завършени дуели.</p>'; return; }
    el.innerHTML = state.recentDuels.map((d) => {
      const champ = d.champion?.title ?? '—';
      const chall = d.challenger?.title ?? '—';
      const won = d.winner === 'challenger';
      return `<div class="item"><div class="grow">
        <div class="t">${won ? `<span class="win">${esc(chall)}</span> свали <span class="lose">${esc(champ)}</span>` : `<span class="win">${esc(champ)}</span> удържа срещу <span class="lose">${esc(chall)}</span>`}</div>
        <div class="s">${d.counts.champion} : ${d.counts.challenger} гласа${d.challengedBy ? ' · предизвикал ' + esc(d.challengedBy) : ''}</div>
      </div></div>`;
    }).join('');
  }

  function renderLibrary() {
    const el = $('#library');
    const q = $('#search').value.trim().toLowerCase();
    const throneId = state?.throne?.song?.id;
    const busy = new Set([state?.duel?.challenger?.id, ...(state?.queue || []).map((x) => x.song.id)]);
    const list = library.filter((s) =>
      (libFilter === 'all' || (libFilter === 'original' ? s.original : !s.original)) &&
      (!q || s.title.toLowerCase().includes(q) || s.artist.toLowerCase().includes(q)));
    if (!library.length) { el.innerHTML = '<p class="empty">Библиотеката е празна. Добави първата песен отдолу.</p>'; return; }
    if (!list.length) { el.innerHTML = '<p class="empty">Нищо не съвпада.</p>'; return; }
    el.innerHTML = list.map((s) => {
      const onThrone = s.id === throneId;
      let challengeBtn;
      if (onThrone) challengeBtn = '<span class="tag gold">👑 На трона</span>';
      else if (busy.has(s.id)) challengeBtn = '<span class="tag">Чака дуел</span>';
      else challengeBtn = `<button class="btn small primary" data-challenge="${s.id}">${throneId ? '⚔️ На дуел' : '👑 На трона'}</button>`;
      return `<div class="lib-item ${onThrone ? 'on-throne' : ''}">
        ${thumb(s)}
        <div class="grow" style="flex:1;min-width:0">
          <div class="item"><div class="grow"><div class="t">${esc(s.title)}</div>
          <div class="s">${esc(s.artist)} · ${s.duelWins} победи${s.original ? ` · ${s.tipsTotal} лв.` : ''}</div></div></div>
          <div class="actions">
            ${tag(s)}
            <button class="btn small" data-preview="${s.id}">▶ Чуй</button>
            ${challengeBtn}
            ${s.original ? `<button class="btn small gold" data-tip="${s.id}">💸</button>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');
  }

  function updateTimers() {
    if (!state) return;
    const now = serverNow();
    if (state.throne) $('#reign-timer').textContent = fmt(now - state.throne.since);
    document.querySelectorAll('[data-countdown]').forEach((el) => {
      const left = Number(el.dataset.countdown) - now;
      el.textContent = left > 0 ? fmt(left + 999) : '0:00';
    });
    document.querySelectorAll('[data-since]').forEach((el) => { el.textContent = fmt(now - Number(el.dataset.since)); });
  }
  setInterval(updateTimers, 500);

  // ---------- Плейър ----------
  const audio = $('#audio-player');
  const cover = $('#cover');
  const listenBtn = $('#listen-btn');
  const player = { listening: false, mode: 'throne', previewSong: null, key: null, current: null, yt: null, needsSync: false, syncSince: null };

  function desired() {
    if (player.mode === 'preview' && player.previewSong) return { song: player.previewSong, since: null };
    if (state?.throne?.song) return { song: state.throne.song, since: state.throne.since };
    return null;
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
        ? `<span class="big-emoji">🎵</span>${esc(song.title)}`
        : '<span class="big-emoji">👑</span>Тронът чака';
    }
    cover.classList.toggle('playing', !!playing);
  }

  function showYt(on) {
    $('#yt-holder').classList.toggle('hidden', !on);
    cover.classList.toggle('hidden', on);
  }

  const offsetFor = (since, duration) =>
    since == null || !duration || !isFinite(duration) ? 0 : ((serverNow() - since) / 1000) % duration;

  function syncPlayer() {
    const want = desired();
    updatePreviewBanner();
    if (!player.listening) { setCover(want?.song, false); showYt(false); return; }
    if (!want) { stopAll(); setCover(null, false); showYt(false); return; }
    const key = want.song.id + '|' + (want.since ?? 'preview');
    if (key === player.key) return;
    player.key = key;
    play(want.song, want.since);
  }

  function play(song, since) {
    player.current = song;
    if (song.type === 'youtube') {
      audio.pause();
      showYt(true);
      player.syncSince = since;
      player.needsSync = since != null;
      loadYt(song.videoId);
    } else {
      stopYt();
      showYt(false);
      setCover(song, true);
      audio.onloadedmetadata = () => {
        if (since != null) { try { audio.currentTime = offsetFor(since, audio.duration); } catch { /* ignore */ } }
        audio.play().catch(() => toast('Натисни „Слушай“ още веднъж, за да пусне звука.', true));
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
    s.onerror = () => toast('YouTube не се зарежда. Провери интернет връзката.', true);
    document.head.appendChild(s);
  }

  function loadYt(videoId) {
    ensureYtApi(() => {
      if (!player.listening) return;
      if (!player.yt) {
        player.yt = new YT.Player('yt-player', {
          videoId,
          playerVars: { autoplay: 1, playsinline: 1, rel: 0 },
          events: {
            onReady: (e) => e.target.playVideo(),
            onStateChange: onYtState,
            onError: () => toast('Това видео не позволява вграждане извън YouTube. Пробвай друга песен.', true),
          },
        });
      } else {
        player.yt.loadVideoById(videoId);
      }
    });
  }

  function onYtState(e) {
    const S = YT.PlayerState;
    if (e.data === S.PLAYING && player.needsSync) {
      const d = player.yt.getDuration();
      if (d > 0) {
        player.needsSync = false;
        const off = offsetFor(player.syncSince, d);
        if (off > 2) player.yt.seekTo(off, true);
      }
    }
    if (e.data === S.ENDED) {
      if (player.mode === 'preview') { backToThrone(); return; }
      player.yt.seekTo(0, true);
      player.yt.playVideo();
    }
  }

  function stopYt() { try { if (player.yt && player.yt.pauseVideo) player.yt.pauseVideo(); } catch { /* ignore */ } }
  function stopAll() { stopYt(); audio.pause(); player.key = null; }

  function setListening(on) {
    player.listening = on;
    listenBtn.textContent = on ? '⏸ Спри' : '▶ Слушай';
    listenBtn.classList.toggle('primary', !on);
    if (!on) { stopAll(); player.mode = 'throne'; player.previewSong = null; }
    player.key = null;
    syncPlayer();
  }

  function preview(song) {
    player.mode = 'preview';
    player.previewSong = song;
    if (!player.listening) { player.listening = true; listenBtn.textContent = '⏸ Спри'; listenBtn.classList.remove('primary'); }
    player.key = null;
    syncPlayer();
    $('.stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function backToThrone() {
    player.mode = 'throne';
    player.previewSong = null;
    player.key = null;
    syncPlayer();
  }

  function updatePreviewBanner() {
    const on = player.mode === 'preview' && player.previewSong && player.listening;
    $('#preview-banner').classList.toggle('hidden', !on);
    if (on) $('#preview-title').textContent = player.previewSong.title;
  }

  audio.addEventListener('ended', () => { if (player.mode === 'preview') backToThrone(); });
  audio.addEventListener('error', () => { if (player.listening && audio.src) toast('Файлът не може да се пусне.', true); });

  // ---------- Действия ----------
  listenBtn.addEventListener('click', () => setListening(!player.listening));
  $('#back-btn').addEventListener('click', backToThrone);

  async function challenge(songId) {
    try {
      const r = await post('/api/challenge', { songId, by: nick() });
      if (r.crowned) toast('👑 Песента седна направо на трона!');
      else if (r.startedNow) toast('⚔️ Дуелът започна! Гласувай.');
      else toast(`⚔️ В опашката си, номер ${r.position}.`);
      refresh();
    } catch (e) { toast(e.message, true); }
  }

  async function vote(side) {
    try {
      await post('/api/vote', { voterId, side, duelId: state?.duel?.id });
      refresh();
    } catch (e) { toast(e.message, true); }
  }

  const tipDialog = $('#tip-dialog');
  let tipSongId = null;
  function openTip(songId) {
    const s = songIndex.get(songId);
    if (!s) return;
    tipSongId = songId;
    $('#tip-title').textContent = s.title;
    tipDialog.showModal();
  }
  tipDialog.addEventListener('close', async () => {
    const amount = Number(tipDialog.returnValue);
    if (!tipSongId || !amount) return;
    try {
      const r = await post('/api/tip', { songId: tipSongId, amount, by: nick() });
      toast(`💸 Благодарим! Общо ${r.total} лв. (тестов режим)`);
    } catch (e) { toast(e.message, true); }
    tipSongId = null;
  });

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.preview) { const s = songIndex.get(b.dataset.preview); if (s) preview(s); }
    else if (b.dataset.vote) vote(b.dataset.vote);
    else if (b.dataset.challenge) challenge(b.dataset.challenge);
    else if (b.dataset.tip) openTip(b.dataset.tip);
    else if (b.dataset.filter) {
      libFilter = b.dataset.filter;
      document.querySelectorAll('.seg-btn').forEach((x) => x.classList.toggle('active', x === b));
      renderLibrary();
    }
  });
  $('#search').addEventListener('input', renderLibrary);

  // ---------- Форми ----------
  $('#yt-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const r = await post('/api/songs', {
        url: f.url.value, title: f.title.value, artist: f.artist.value, addedBy: nick(),
      });
      toast(r.existing ? 'Тази песен вече е в библиотеката.' : '🎶 Добавена: ' + r.song.title);
      indexSongs([r.song]);
      if (f.challenge.checked) await challenge(r.song.id);
      f.url.value = ''; f.title.value = ''; f.artist.value = '';
      loadLibrary();
    } catch (err) { toast(err.message, true); }
    btn.disabled = false;
  });

  const fileInput = $('#upload-form input[type=file]');
  fileInput.addEventListener('change', () => {
    const name = fileInput.files[0]?.name;
    $('#upload-form .file-label').textContent = name ? '🎵 ' + name : '🎵 Избери аудио файл';
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
      title: f.title.value, artist: f.artist.value, addedBy: nick(),
      original: f.original.checked ? 'true' : 'false', ext,
    });
    btn.disabled = true;
    btn.textContent = 'Качва се…';
    try {
      const r = await api('/api/upload?' + params, {
        method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file,
      });
      toast('🎵 Качена: ' + r.song.title);
      indexSongs([r.song]);
      if (f.challenge.checked) await challenge(r.song.id);
      f.reset();
      f.challenge.checked = true;
      $('#upload-form .file-label').textContent = '🎵 Избери аудио файл';
      loadLibrary();
    } catch (err) { toast(err.message, true); }
    btn.disabled = false;
    btn.textContent = 'Качи';
  });

  refresh();
  loadLibrary();
})();
