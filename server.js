// Dethrone: една песен на трона, дуели решени от слушателите.
// Без външни зависимости: нужен е само Node.js 18+.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Настройки от файла .env (например YOUTUBE_API_KEY=...). Променливите на средата имат предимство.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
} catch { /* няма .env */ }

const PORT = Number(process.env.PORT || 3000);
const YOUTUBE_API_KEY = (process.env.YOUTUBE_API_KEY || '').trim();
const DUEL_SECONDS = Number(process.env.DUEL_SECONDS || 120);   // колко трае един дуел
const BREAK_SECONDS = Number(process.env.BREAK_SECONDS || 20);  // пауза между дуелите
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 20);

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- База данни (JSON файл, достатъчно за прототип) ----------
const emptyDb = () => ({
  songs: [],      // {id,title,artist,type:'youtube'|'audio',videoId?,audioUrl?,addedBy,createdAt,duelWins,defenses,tipsTotal}
  throne: null,   // {songId, since}
  duel: null,     // {id,championId,challengerId,challengedBy,startedAt,endsAt,votes:{voterId:side}}
  queue: [],      // {songId, challengedBy, at}
  reigns: [],     // завършили царувания {songId,start,end}
  duels: [],      // история {id,championId,challengerId,challengedBy,counts,winner,at}
  tips: [],       // тестови бакшиши {id,songId,artist,amount,by,voterId,message,at}
  fans: {},       // {voterId: {name}}
  fanStats: {},   // {artistKey: {voterId: {votes, tips}}}
  nextDuelAt: 0,
});

function loadDb() {
  try { return { ...emptyDb(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; }
  catch { return emptyDb(); }
}
let db = loadDb();

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

const newId = () => crypto.randomBytes(6).toString('hex');
const songById = (id) => db.songs.find((s) => s.id === id) || null;
const clean = (v, max = 80) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

// ---------- Фенове и „Най-голям фен“ ----------
// Точки: 1 за всеки глас за песен на артиста, 3 за всяко евро бакшиш.
const POINTS_PER_VOTE = 1;
const POINTS_PER_EURO = 3;
const MIN_TIP = 1;   // €
const MAX_TIP = 50;  // €
const ANON = 'Анонимен';
const artistKey = (name) => String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();

function rememberFan(voterId, name) {
  if (!voterId) return;
  const n = clean(name, 30);
  const fan = db.fans[voterId] || (db.fans[voterId] = { name: ANON });
  if (n && n !== ANON) fan.name = n;
}
const fanName = (voterId) => (db.fans[voterId] && db.fans[voterId].name) || ANON;

function bumpFan(artist, voterId, field, amount) {
  if (!voterId) return;
  const key = artistKey(artist);
  const board = db.fanStats[key] || (db.fanStats[key] = {});
  const st = board[voterId] || (board[voterId] = { votes: 0, tips: 0 });
  st[field] += amount;
}

// Всички фенове с точки, включително анонимните (точките им се пазят, ако по-късно си сложат име)
function fanBoardAll(artist) {
  const board = db.fanStats[artistKey(artist)] || {};
  return Object.entries(board)
    .map(([voterId, st]) => ({ voterId, name: fanName(voterId), votes: st.votes, tips: st.tips, score: st.votes * POINTS_PER_VOTE + st.tips * POINTS_PER_EURO }))
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score || b.tips - a.tips || b.votes - a.votes);
}
// Публичната класация показва само фенове с име
const fanBoard = (artist) => fanBoardAll(artist).filter((f) => f.name !== ANON);

function biggestFanOf(artist) {
  const top = fanBoard(artist)[0];
  return top ? { voterId: top.voterId, name: top.name, score: top.score } : null;
}

// ---------- YouTube ----------
function youtubeId(input) {
  const raw = String(input || '').trim();
  if (/^[\w-]{11}$/.test(raw)) return raw;
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    let id = null;
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      id = u.searchParams.get('v');
      if (!id) {
        const m = u.pathname.match(/^\/(embed|shorts|live|v)\/([\w-]{11})/);
        if (m) id = m[2];
      }
    }
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}

async function youtubeMeta(videoId) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const url = 'https://www.youtube.com/oembed?format=json&url=' +
      encodeURIComponent('https://www.youtube.com/watch?v=' + videoId);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json();
    return { title: j.title, artist: j.author_name };
  } catch { return null; }
}

// ---------- Начало и край на песента ----------
// Много клипове имат въведение или финал без музика, затова всяка песен може да има начало и край (в секунди).
const MAX_SECONDS = 3 * 3600;
function parseSeconds(v) {
  const r = parseSecondsRaw(v);
  return r === null || Number.isNaN(r) || r <= MAX_SECONDS ? r : NaN;
}
function parseSecondsRaw(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 && v <= MAX_SECONDS ? Math.round(v * 10) / 10 : NaN;
  const str = String(v).trim();
  let m = str.match(/^(\d+):([0-5]?\d)(?:\.(\d))?$/);                 // 1:35 или 1:35.5
  if (m) return Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(m[3]) / 10 : 0);
  m = str.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);               // 95, 95s, 1m35s, 1h2m3s (както в YouTube линковете)
  if (m && (m[1] || m[2] || m[3])) return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
  const n = Number(str);
  return Number.isFinite(n) && n >= 0 && n <= MAX_SECONDS ? n : NaN;
}
function youtubeStart(input) {
  try {
    const u = new URL(String(input || '').trim());
    const t = u.searchParams.get('t') || u.searchParams.get('start');
    const s = parseSeconds(t);
    return Number.isFinite(s) && s > 0 ? s : null;
  } catch { return null; }
}

// ---------- Търсене в YouTube ----------
// Официалното търсене на YouTube (YouTube Data API v3). Всяко търсене струва 100 от 10 000-те
// безплатни единици на ден, затова резултатите се пазят 12 часа.
const searchCache = new Map();
const SEARCH_TTL = 12 * 3600 * 1000;

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// „Rammstein - Deutschland (Official Video)“ → изпълнител „Rammstein“, песен „Deutschland“
function splitTitle(rawTitle, channel) {
  let title = decodeEntities(rawTitle)
    .replace(/\s*[([](?:[^)\]]*\b(?:official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|remaster(?:ed)?|clip|videoclip|m\/v|mv)\b[^)\]]*)[)\]]/gi, '')
    .replace(/\s*\|.*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  let artist = decodeEntities(channel).replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').replace(/\s*Official$/i, '').trim();
  const m = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) { artist = m[1].trim(); title = m[2].trim(); }
  title = title.replace(/^["“„']+|["“”']+$/g, '').trim();
  return { title: title || decodeEntities(rawTitle), artist: artist || 'Неизвестен изпълнител' };
}

async function youtubeSearch(q) {
  const key = q.toLowerCase();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.results;
  const url = (process.env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3') + '/search?' + new URLSearchParams({
    part: 'snippet', type: 'video', videoEmbeddable: 'true', videoCategoryId: '10',
    maxResults: '10', safeSearch: 'moderate', q, key: YOUTUBE_API_KEY,
  });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  let r;
  try { r = await fetch(url, { signal: ctrl.signal }); }
  catch { throw new HttpError(502, 'YouTube не отговаря. Провери връзката с интернет.'); }
  finally { clearTimeout(t); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const reason = j?.error?.errors?.[0]?.reason || '';
    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
      throw new HttpError(429, 'Лимитът за търсене в YouTube за днес е изчерпан. Дотогава можеш да поставиш линк.');
    }
    if (r.status === 400 || r.status === 403) throw new HttpError(502, 'YouTube отказа ключа. Провери YOUTUBE_API_KEY във файла .env.');
    throw new HttpError(502, 'Търсенето в YouTube не мина. Опитай пак.');
  }
  const results = (j.items || [])
    .filter((it) => it.id && it.id.videoId)
    .map((it) => {
      const { title, artist } = splitTitle(it.snippet.title, it.snippet.channelTitle);
      const th = it.snippet.thumbnails || {};
      return {
        videoId: it.id.videoId, title, artist,
        rawTitle: decodeEntities(it.snippet.title), channel: decodeEntities(it.snippet.channelTitle),
        thumb: (th.medium || th.default || {}).url || null,
      };
    });
  searchCache.set(key, { at: Date.now(), results });
  if (searchCache.size > 500) searchCache.delete(searchCache.keys().next().value);
  return results;
}

// ---------- Автоматично откриване къде почва музиката ----------
// SponsorBlock е безплатна общностна база, в която хората отбелязват частите без музика
// в музикалните клипове (въведения, истории, финали). Оттам взимаме началото, края и
// частите за прескачане по средата.
const SB_CATEGORIES = ['music_offtopic', 'intro', 'outro'];
async function detectMusic(videoId) {
  const url = 'https://sponsor.ajay.app/api/skipSegments?videoID=' + encodeURIComponent(videoId) +
    '&categories=' + encodeURIComponent(JSON.stringify(SB_CATEGORIES));
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Dethrone/0.1' } });
    if (r.status === 404) return { found: false };               // няма отбелязани части
    if (!r.ok) return null;                                       // временна грешка, ще опитаме пак
    const list = await r.json();
    const duration = Math.max(0, ...list.map((x) => Number(x.videoDuration) || 0)) || null;
    // Слепваме припокриващите се части
    const segs = list
      .filter((x) => x.actionType === 'skip' && Array.isArray(x.segment))
      .map((x) => [Number(x.segment[0]), Number(x.segment[1])])
      .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
      .sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const [a, b] of segs) {
      const last = merged[merged.length - 1];
      if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    let startAt = 0;
    let endAt = null;
    const skips = [];
    for (const [a, b] of merged) {
      if (a <= 3) startAt = Math.round(b * 10) / 10;                              // въведение от самото начало
      else if (duration && b >= duration - 3) endAt = Math.round(a * 10) / 10;     // финал до самия край
      else skips.push([Math.round(a * 10) / 10, Math.round(b * 10) / 10]);         // история по средата
    }
    return { found: merged.length > 0, startAt, endAt, skips, duration };
  } catch { return null; } finally { clearTimeout(t); }
}

// Записва откритото в песента, освен ако някой е задал началото и края ръчно
async function applyDetection(song) {
  if (!song || song.type !== 'youtube') return false;
  const d = await detectMusic(song.videoId);
  if (!d) return false;
  song.detectedAt = Date.now();
  song.detected = d.found ? { startAt: d.startAt, endAt: d.endAt, skips: d.skips } : null;
  if (song.trimSource !== 'manual') {
    song.startAt = d.found ? d.startAt : 0;
    song.endAt = d.found ? d.endAt : null;
    song.trimSource = d.found ? 'auto' : null;
  }
  song.skips = d.found ? d.skips : [];
  return true;
}

// Песните, добавени преди тази функция, се проверяват веднъж на заден план
async function detectMissing() {
  for (const s of db.songs) {
    if (s.type !== 'youtube' || s.detectedAt) continue;
    if (await applyDetection(s)) { save(); broadcast('state'); broadcast('library'); }
  }
}

// ---------- Изгледи за клиента ----------
// viewer е гласоподавателят, за когото се строи отговорът (за да знаем дали може да редактира песента)
let viewer = null;
function withViewer(voterId, fn) {
  viewer = voterId || null;
  try { return fn(); } finally { viewer = null; }
}

function songView(s) {
  if (!s) return null;
  return {
    id: s.id, title: s.title, artist: s.artist, type: s.type,
    videoId: s.videoId || null, audioUrl: s.audioUrl || null,
    original: s.type === 'audio', addedBy: s.addedBy,
    duelWins: s.duelWins || 0, defenses: s.defenses || 0, tipsTotal: s.tipsTotal || 0,
    createdAt: s.createdAt,
    startAt: s.startAt || 0, endAt: s.endAt || null, skips: s.skips || [],
    trimSource: s.trimSource || null, autoAvailable: !!s.detected,
    canEdit: !s.addedById || (!!viewer && s.addedById === viewer),
    biggestFan: (biggestFanOf(s.artist) || {}).name || null,
  };
}

function tipView(t) {
  const song = songById(t.songId);
  const top = biggestFanOf(t.artist || (song && song.artist));
  return {
    id: t.id, amount: t.amount, by: t.by, message: t.message || '', at: t.at,
    songTitle: song ? song.title : '—', artist: t.artist || (song && song.artist) || '—',
    byBiggestFan: !!(top && t.voterId && top.voterId === t.voterId),
  };
}

function voteCounts(d) {
  const c = { champion: 0, challenger: 0 };
  for (const v of Object.values(d.votes)) if (c[v] !== undefined) c[v]++;
  return c;
}

function hallOfFame(now) {
  const all = db.reigns.map((r) => ({ ...r, current: false }));
  if (db.throne) all.push({ songId: db.throne.songId, start: db.throne.since, end: now, current: true });
  return all
    .map((r) => ({ song: songView(songById(r.songId)), duration: r.end - r.start, current: r.current, start: r.start }))
    .filter((r) => r.song)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 10);
}

function scouts() {
  const map = {};
  for (const d of db.duels) {
    if (d.winner === 'challenger' && d.challengedBy) map[d.challengedBy] = (map[d.challengedBy] || 0) + 1;
  }
  return Object.entries(map).map(([name, wins]) => ({ name, wins }))
    .sort((a, b) => b.wins - a.wins).slice(0, 10);
}

function publicState(voterId) {
  const now = Date.now();
  let duel = null;
  if (db.duel) {
    const d = db.duel;
    duel = {
      id: d.id, champion: songView(songById(d.championId)), challenger: songView(songById(d.challengerId)),
      challengedBy: d.challengedBy, startedAt: d.startedAt, endsAt: d.endsAt,
      counts: voteCounts(d), myVote: voterId ? d.votes[voterId] || null : null,
    };
  }
  return {
    now,
    throne: db.throne ? { song: songView(songById(db.throne.songId)), since: db.throne.since } : null,
    duel,
    queue: db.queue.map((q) => ({ song: songView(songById(q.songId)), challengedBy: q.challengedBy })).filter((q) => q.song),
    nextDuelAt: !db.duel && db.queue.length ? Math.max(db.nextDuelAt, now) : null,
    hallOfFame: hallOfFame(now),
    scouts: scouts(),
    recentDuels: db.duels.slice(-8).reverse().map((d) => ({
      champion: songView(songById(d.championId)), challenger: songView(songById(d.challengerId)),
      counts: d.counts, winner: d.winner, challengedBy: d.challengedBy, at: d.at,
    })),
    recentTips: db.tips.slice(-8).reverse().map(tipView),
    config: { duelSeconds: DUEL_SECONDS, breakSeconds: BREAK_SECONDS },
  };
}

// ---------- Живи обновления (Server-Sent Events) ----------
const clients = new Set();
function broadcast(kind = 'state') {
  for (const c of clients) c.write(`event: ${kind}\ndata: ${Date.now()}\n\n`);
}
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000);

// ---------- Логика на дуелите ----------
function startDuel(now) {
  while (db.queue.length) {
    const q = db.queue.shift();
    if (!songById(q.songId) || (db.throne && q.songId === db.throne.songId)) continue;
    db.duel = {
      id: newId(), championId: db.throne.songId, challengerId: q.songId, challengedBy: q.challengedBy,
      startedAt: now, endsAt: now + DUEL_SECONDS * 1000, votes: {},
    };
    return true;
  }
  return false;
}

function resolveDuel(now) {
  const d = db.duel;
  const counts = voteCounts(d);
  const challengerWins = counts.challenger > counts.champion; // равенство: шампионът остава
  const champion = songById(d.championId);
  const challenger = songById(d.challengerId);
  // Всеки глас носи точки на фена към артиста, за когото е гласувал
  for (const [voterId, side] of Object.entries(d.votes)) {
    const song = side === 'champion' ? champion : challenger;
    if (song) bumpFan(song.artist, voterId, 'votes', 1);
  }
  if (challengerWins) {
    db.reigns.push({ songId: d.championId, start: db.throne.since, end: now });
    db.throne = { songId: d.challengerId, since: now };
    if (challenger) challenger.duelWins = (challenger.duelWins || 0) + 1;
  } else if (champion) {
    champion.defenses = (champion.defenses || 0) + 1;
  }
  db.duels.push({
    id: d.id, championId: d.championId, challengerId: d.challengerId, challengedBy: d.challengedBy,
    counts, winner: challengerWins ? 'challenger' : 'champion', at: now,
  });
  if (db.duels.length > 500) db.duels = db.duels.slice(-500);
  db.duel = null;
  db.nextDuelAt = now + BREAK_SECONDS * 1000;
}

function tick() {
  const now = Date.now();
  let changed = false;
  if (db.duel && now >= db.duel.endsAt) { resolveDuel(now); changed = true; }
  if (!db.duel && db.throne && db.queue.length && now >= db.nextDuelAt) {
    if (startDuel(now)) changed = true;
  }
  if (changed) { save(); broadcast('state'); }
}
setInterval(tick, 1000);

// ---------- HTTP помощници ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJson(req, limit = 10 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Твърде голяма заявка.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Невалиден JSON.')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.webm': 'audio/webm',
};
const AUDIO_EXT = ['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.webm'];

// Статични файлове, с поддръжка на Range (нужно за превъртане в аудиото)
function serveStatic(req, res, baseDir, relPath) {
  const filePath = path.normalize(path.join(baseDir, relPath));
  if (!filePath.startsWith(baseDir + path.sep) && filePath !== baseDir) return false;
  let stat;
  try { stat = fs.statSync(filePath); } catch { return false; }
  if (!stat.isFile()) return false;
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': baseDir === UPLOAD_DIR ? 'public, max-age=86400' : 'no-cache' };
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range) {
    let start = range[1] === '' ? NaN : Number(range[1]);
    let end = range[2] === '' ? stat.size - 1 : Number(range[2]);
    if (Number.isNaN(start)) { start = stat.size - end; end = stat.size - 1; }
    if (start >= stat.size || start < 0 || end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return true;
    }
    end = Math.min(end, stat.size - 1);
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end(), true;
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return true;
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(filePath).pipe(res);
  return true;
}

// Качване: тялото на заявката е самият файл, данните са в адреса (?title=…&artist=…)
function receiveUpload(req, ext) {
  return new Promise((resolve, reject) => {
    const max = MAX_UPLOAD_MB * 1024 * 1024;
    if (Number(req.headers['content-length'] || 0) > max) {
      return reject(new HttpError(413, `Файлът е по-голям от ${MAX_UPLOAD_MB} MB.`));
    }
    const name = newId() + ext;
    const filePath = path.join(UPLOAD_DIR, name);
    const out = fs.createWriteStream(filePath);
    let size = 0;
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      out.destroy();
      fs.rm(filePath, { force: true }, () => {});
      reject(err);
    };
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { fail(new HttpError(413, `Файлът е по-голям от ${MAX_UPLOAD_MB} MB.`)); req.destroy(); }
    });
    req.on('error', () => fail(new HttpError(400, 'Качването прекъсна.')));
    req.pipe(out);
    out.on('finish', () => {
      if (failed) return;
      if (size === 0) return fail(new HttpError(400, 'Файлът е празен.'));
      resolve({ name, size, filePath });
    });
    out.on('error', () => fail(new HttpError(500, 'Файлът не може да се запише.')));
  });
}

// ---------- Маршрути ----------
async function handleApi(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (m === 'GET' && p === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (m === 'GET' && p === '/api/state') {
    const v = clean(url.searchParams.get('voterId'), 64);
    return sendJson(res, 200, withViewer(v, () => publicState(v)));
  }

  if (m === 'GET' && p === '/api/songs') {
    const v = clean(url.searchParams.get('voterId'), 64);
    return sendJson(res, 200, withViewer(v, () => ({ songs: [...db.songs].reverse().map(songView) })));
  }

  // Търсене на песни в YouTube
  if (m === 'GET' && p === '/api/yt-search') {
    const q = clean(url.searchParams.get('q'), 100);
    if (q.length < 2) throw new HttpError(400, 'Напиши поне две букви.');
    if (!YOUTUBE_API_KEY) {
      return sendJson(res, 501, {
        error: 'Търсенето не е включено. Добави YOUTUBE_API_KEY във файла .env и рестартирай сървъра.',
        needsKey: true,
      });
    }
    const results = await youtubeSearch(q);
    return sendJson(res, 200, {
      results: results.map((r) => {
        const s = db.songs.find((x) => x.videoId === r.videoId);
        return { ...r, songId: s ? s.id : null };
      }),
    });
  }

  // Начало и край на песента. Може да ги променя този, който е добавил песента.
  const trimMatch = p.match(/^\/api\/songs\/([a-f0-9]{12})\/trim$/);
  if (m === 'POST' && trimMatch) {
    const body = await readJson(req);
    const song = songById(trimMatch[1]);
    const voterId = clean(body.voterId, 64);
    if (!song) throw new HttpError(404, 'Няма такава песен.');
    if (song.addedById && song.addedById !== voterId) throw new HttpError(403, 'Само този, който е добавил песента, може да променя началото и края ѝ.');
    // Връщане към автоматично откритото
    if (body.auto) {
      if (song.type !== 'youtube') throw new HttpError(400, 'Автоматичното откриване е само за песни от YouTube.');
      song.trimSource = null;
      const ok = await applyDetection(song);
      if (!ok) throw new HttpError(502, 'Не успях да проверя песента. Опитай пак след малко.');
      save(); broadcast('state'); broadcast('library');
      return sendJson(res, 200, withViewer(voterId, () => ({ song: songView(song), found: song.trimSource === 'auto' })));
    }
    const start = parseSeconds(body.startAt);
    const end = parseSeconds(body.endAt);
    if (Number.isNaN(start) || Number.isNaN(end)) throw new HttpError(400, 'Въведи време като 1:35 или в секунди.');
    const s0 = start || 0;
    if (end !== null && end <= s0 + 5) throw new HttpError(400, 'Краят трябва да е поне 5 секунди след началото.');
    song.startAt = s0;
    song.endAt = end;
    song.trimSource = 'manual';
    save(); broadcast('state'); broadcast('library');
    return sendJson(res, 200, withViewer(voterId, () => ({ song: songView(song) })));
  }

  // Добавяне на песен от YouTube
  if (m === 'POST' && p === '/api/songs') {
    const body = await readJson(req);
    const videoId = youtubeId(body.url);
    if (!videoId) throw new HttpError(400, 'Невалиден YouTube линк.');
    const existing = db.songs.find((s) => s.videoId === videoId);
    const adderId = clean(body.voterId, 64) || null;
    if (existing) return sendJson(res, 200, withViewer(adderId, () => ({ song: songView(existing), existing: true })));
    let title = clean(body.title, 120);
    let artist = clean(body.artist, 80);
    if (!title || !artist) {
      const meta = await youtubeMeta(videoId);
      if (meta) { title = title || clean(meta.title, 120); artist = artist || clean(meta.artist, 80); }
    }
    // Начало: от полето във формата или от ?t= в линка
    let startAt = parseSeconds(body.startAt);
    if (Number.isNaN(startAt)) throw new HttpError(400, 'Началото трябва да е като 1:35 или в секунди.');
    if (startAt === null) startAt = youtubeStart(body.url);
    const song = {
      id: newId(), type: 'youtube', videoId,
      title: title || 'YouTube видео ' + videoId, artist: artist || 'Неизвестен изпълнител',
      addedBy: clean(body.addedBy, 30) || 'Анонимен', addedById: adderId, createdAt: Date.now(),
      duelWins: 0, defenses: 0, tipsTotal: 0, startAt: startAt || 0, endAt: null, skips: [],
      trimSource: startAt ? 'manual' : null,
    };
    // Откриваме къде почва музиката, преди песента да влезе в списъка
    await applyDetection(song);
    db.songs.push(song);
    save();
    broadcast('library');
    return sendJson(res, 200, withViewer(adderId, () => ({ song: songView(song) })));
  }

  // Качване на оригинална песен от артист
  if (m === 'POST' && p === '/api/upload') {
    const q = url.searchParams;
    const title = clean(q.get('title'), 120);
    const artist = clean(q.get('artist'), 80);
    const ext = '.' + clean(q.get('ext'), 6).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!AUDIO_EXT.includes(ext)) throw new HttpError(400, 'Позволени формати: mp3, m4a, aac, wav, ogg, opus.');
    if (!title || !artist) throw new HttpError(400, 'Въведи име на песента и артист.');
    if (q.get('original') !== 'true') throw new HttpError(400, 'Потвърди, че песента е твоя оригинална музика.');
    const file = await receiveUpload(req, ext);
    const adderId = clean(q.get('voterId'), 64) || null;
    const song = {
      id: newId(), type: 'audio', audioUrl: '/uploads/' + file.name,
      title, artist, addedBy: clean(q.get('addedBy'), 30) || artist, addedById: adderId, createdAt: Date.now(),
      duelWins: 0, defenses: 0, tipsTotal: 0, startAt: 0, endAt: null,
    };
    db.songs.push(song);
    save();
    broadcast('library');
    return sendJson(res, 200, withViewer(adderId, () => ({ song: songView(song) })));
  }

  // Предизвикване на трона
  if (m === 'POST' && p === '/api/challenge') {
    const body = await readJson(req);
    const song = songById(body.songId);
    if (!song) throw new HttpError(404, 'Няма такава песен.');
    const by = clean(body.by, 30) || 'Анонимен';
    if (!db.throne) {
      db.throne = { songId: song.id, since: Date.now() };
      save(); broadcast('state');
      return sendJson(res, 200, { ok: true, crowned: true });
    }
    if (db.throne.songId === song.id) throw new HttpError(400, 'Тази песен вече е на трона.');
    if (db.duel && db.duel.challengerId === song.id) throw new HttpError(400, 'Тази песен е в дуел в момента.');
    if (db.queue.some((x) => x.songId === song.id)) throw new HttpError(400, 'Тази песен вече чака за дуел.');
    if (db.queue.length >= 50) throw new HttpError(400, 'Опашката е пълна, опитай по-късно.');
    db.queue.push({ songId: song.id, challengedBy: by, at: Date.now() });
    save(); broadcast('state');
    tick();
    return sendJson(res, 200, { ok: true, position: db.queue.length, startedNow: !!(db.duel && db.duel.challengerId === song.id) });
  }

  // Гласуване (един глас на човек на дуел, може да се смени)
  if (m === 'POST' && p === '/api/vote') {
    const body = await readJson(req);
    const voterId = clean(body.voterId, 64);
    if (!db.duel) throw new HttpError(400, 'В момента няма дуел.');
    if (voterId.length < 8) throw new HttpError(400, 'Невалиден гласоподавател.');
    if (body.side !== 'champion' && body.side !== 'challenger') throw new HttpError(400, 'Невалиден избор.');
    if (body.duelId && body.duelId !== db.duel.id) throw new HttpError(400, 'Дуелът вече приключи.');
    db.duel.votes[voterId] = body.side;
    rememberFan(voterId, body.name);
    save(); broadcast('state');
    return sendJson(res, 200, { ok: true });
  }

  // Бакшиш (ТЕСТОВ РЕЖИМ: не се теглят реални пари)
  if (m === 'POST' && p === '/api/tip') {
    const body = await readJson(req);
    const song = songById(body.songId);
    const amount = Math.round(Number(body.amount));
    const voterId = clean(body.voterId, 64);
    if (!song) throw new HttpError(404, 'Няма такава песен.');
    if (song.type !== 'audio') throw new HttpError(400, 'Бакшиши има само за нови артисти с оригинална музика.');
    if (!Number.isFinite(amount) || amount < MIN_TIP || amount > MAX_TIP) throw new HttpError(400, `Сумата трябва да е между ${MIN_TIP} и ${MAX_TIP} €.`);
    if (voterId.length < 8) throw new HttpError(400, 'Невалиден потребител.');
    rememberFan(voterId, body.by);
    const before = biggestFanOf(song.artist);
    db.tips.push({
      id: newId(), songId: song.id, artist: song.artist, amount, voterId,
      by: fanName(voterId), message: clean(body.message, 140), at: Date.now(),
    });
    if (db.tips.length > 5000) db.tips = db.tips.slice(-5000);
    song.tipsTotal = (song.tipsTotal || 0) + amount;
    bumpFan(song.artist, voterId, 'tips', amount);
    const after = biggestFanOf(song.artist);
    const becameBiggestFan = !!(after && after.voterId === voterId && (!before || before.voterId !== voterId));
    save(); broadcast('state'); broadcast('library');
    return sendJson(res, 200, { ok: true, total: song.tipsTotal, becameBiggestFan, test: true });
  }

  // Страница на артист: песни, суми и класация на феновете
  if (m === 'GET' && p === '/api/artist') {
    const key = artistKey(url.searchParams.get('name'));
    const songs = db.songs.filter((s) => artistKey(s.artist) === key);
    if (!key || !songs.length) throw new HttpError(404, 'Няма такъв артист.');
    const me = clean(url.searchParams.get('voterId'), 64);
    const board = fanBoard(songs[0].artist);
    const top = biggestFanOf(songs[0].artist);
    const myIndex = board.findIndex((f) => f.voterId === me);
    const myAnon = myIndex < 0 ? fanBoardAll(songs[0].artist).find((f) => f.voterId === me) : null;
    return sendJson(res, 200, {
      artist: songs[0].artist,
      original: songs.some((s) => s.type === 'audio'),
      songs: songs.map(songView),
      totals: {
        tips: songs.reduce((a, s) => a + (s.tipsTotal || 0), 0),
        wins: songs.reduce((a, s) => a + (s.duelWins || 0), 0),
        defenses: songs.reduce((a, s) => a + (s.defenses || 0), 0),
      },
      biggestFan: top ? { name: top.name, score: top.score } : null,
      fans: board.slice(0, 10).map((f) => ({
        name: f.name, votes: f.votes, tips: f.tips, score: f.score,
        isMe: f.voterId === me, isBiggestFan: !!(top && top.voterId === f.voterId),
      })),
      me: myIndex >= 0 ? { rank: myIndex + 1, ...board[myIndex], voterId: undefined }
        : myAnon ? { rank: null, ...myAnon, voterId: undefined } : null,
      recentTips: db.tips.filter((t) => artistKey(t.artist) === key).slice(-10).reverse().map(tipView),
      points: { vote: POINTS_PER_VOTE, euro: POINTS_PER_EURO },
    });
  }

  // Моят профил: значки „Най-голям фен“ и подкрепени артисти
  if (m === 'GET' && p === '/api/me') {
    const me = clean(url.searchParams.get('voterId'), 64);
    const artists = {};
    for (const s of db.songs) artists[artistKey(s.artist)] = s.artist;
    const supported = [];
    for (const [key, board] of Object.entries(db.fanStats)) {
      const st = board[me];
      if (!st) continue;
      const name = artists[key];
      if (!name) continue;
      const top = biggestFanOf(name);
      supported.push({
        artist: name, votes: st.votes, tips: st.tips,
        score: st.votes * POINTS_PER_VOTE + st.tips * POINTS_PER_EURO,
        isBiggestFan: !!(top && top.voterId === me),
      });
    }
    supported.sort((a, b) => Number(b.isBiggestFan) - Number(a.isBiggestFan) || b.score - a.score);
    return sendJson(res, 200, {
      name: fanName(me),
      badges: supported.filter((s) => s.isBiggestFan).map((s) => s.artist),
      supported,
      points: { vote: POINTS_PER_VOTE, euro: POINTS_PER_EURO },
    });
  }

  throw new HttpError(404, 'Няма такъв адрес.');
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Методът не е позволен.');
    const rel = decodeURIComponent(url.pathname);
    if (rel.startsWith('/uploads/')) {
      if (serveStatic(req, res, UPLOAD_DIR, rel.slice('/uploads/'.length))) return;
    } else if (serveStatic(req, res, PUBLIC_DIR, rel === '/' ? 'index.html' : rel.slice(1))) return;
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Няма такава страница.');
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Грешка в сървъра.' : err.message });
    else res.end();
  }
});

setTimeout(detectMissing, 2000);

server.listen(PORT, () => {
  console.log(`👑 Dethrone върви на http://localhost:${PORT}`);
  console.log(`   Дуел: ${DUEL_SECONDS} сек, пауза: ${BREAK_SECONDS} сек`);
  console.log(YOUTUBE_API_KEY
    ? '   Търсене в YouTube: включено'
    : '   Търсене в YouTube: изключено (добави YOUTUBE_API_KEY във файла .env)');
});
