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
const TRUST_PROXY = process.env.TRUST_PROXY === '1';           // зад хостинг/прокси: IP адресът идва от X-Forwarded-For
const MAX_STREAMS_PER_IP = Number(process.env.MAX_STREAMS_PER_IP || 30);
const SEARCHES_PER_DAY = Number(process.env.SEARCHES_PER_DAY || 95); // безплатният лимит на YouTube е около 100

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
// На хостинг (например Railway) базата и качените песни трябва да са на постоянен диск (volume),
// иначе се губят при всяко ново качване на кода. STORAGE_DIR = пътят, на който е закачен дискът.
const STORAGE_DIR = process.env.STORAGE_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || '';
const DATA_DIR = STORAGE_DIR ? path.join(STORAGE_DIR, 'data') : path.join(ROOT, 'data');
const UPLOAD_DIR = STORAGE_DIR ? path.join(STORAGE_DIR, 'uploads') : path.join(ROOT, 'uploads');
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
  users: {},      // {uid: {id, provider, name, avatar, createdAt, lastLoginAt}}
  claims: {},     // {стар идентификатор на браузъра: uid}, за да се прехвърли само веднъж
  nextDuelAt: 0,
});

function loadDb() {
  try { return { ...emptyDb(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }; }
  catch { return emptyDb(); }
}
let db = loadDb();

// Записът на диска става на заден план, най-много веднъж в секунда, вместо при всеки глас.
// При спиране на сървъра (Ctrl+C) всичко се записва веднага.
let saveTimer = null;
let saving = false;
let saveAgain = false;
function save() {
  if (!saveTimer) saveTimer = setTimeout(flushSave, 1000);
}
async function flushSave() {
  saveTimer = null;
  if (saving) { saveAgain = true; return; }
  saving = true;
  try {
    const tmp = DB_FILE + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(db));
    await fs.promises.rename(tmp, DB_FILE);
  } catch (e) {
    console.error('Записът на базата не мина:', e.message);
  } finally {
    saving = false;
    if (saveAgain) { saveAgain = false; save(); }
  }
}
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db));
    fs.renameSync(DB_FILE + '.tmp', DB_FILE);
  } catch (e) { console.error('Записът на базата не мина:', e.message); }
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { saveNow(); process.exit(0); });
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

// fanVersion се увеличава при всяка промяна на точките или имената, за да знаем кога да преизчислим класациите
let fanVersion = 0;
function rememberFan(voterId, name) {
  if (!voterId) return;
  const n = clean(name, 30);
  let fan = db.fans[voterId];
  if (!fan) { fan = db.fans[voterId] = { name: ANON }; fanVersion++; }
  if (n && n !== ANON && fan.name !== n) { fan.name = n; fanVersion++; }
}
const fanName = (voterId) => (db.fans[voterId] && db.fans[voterId].name) || ANON;

function bumpFan(artist, voterId, field, amount) {
  if (!voterId) return;
  const key = artistKey(artist);
  const board = db.fanStats[key] || (db.fanStats[key] = {});
  const st = board[voterId] || (board[voterId] = { votes: 0, tips: 0 });
  st[field] += amount;
  fanVersion++;
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

// Най-големият фен се пази в кеш, докато точките не се променят
const bigFanCache = new Map();
function biggestFanOf(artist) {
  const key = artistKey(artist);
  const hit = bigFanCache.get(key);
  if (hit && hit.v === fanVersion) return hit.top;
  const first = fanBoard(artist)[0];
  const top = first ? { voterId: first.voterId, name: first.name, score: first.score } : null;
  bigFanCache.set(key, { v: fanVersion, top });
  return top;
}

// ---------- Акаунти: вход с Google и Discord ----------
// Стандартен OAuth вход без външни пакети. Сесията е подписана бисквитка (HttpOnly), валидна 60 дни.
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const PROVIDERS = {
  google: {
    label: 'Google',
    clientId: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid profile',
    extra: { prompt: 'select_account' },
    profile: (u) => ({ id: u.sub, name: u.name || u.given_name, avatar: u.picture || null }),
  },
  discord: {
    label: 'Discord',
    clientId: process.env.DISCORD_CLIENT_ID, secret: process.env.DISCORD_CLIENT_SECRET,
    authUrl: 'https://discord.com/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    userUrl: 'https://discord.com/api/users/@me',
    scope: 'identify',
    extra: {},
    profile: (u) => ({
      id: u.id, name: u.global_name || u.username,
      avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64` : null,
    }),
  },
};
// Само за автоматични тестове: фалшив Google/Discord на друг адрес
if (process.env.OAUTH_MOCK_BASE) {
  for (const [k, prov] of Object.entries(PROVIDERS)) {
    prov.authUrl = `${process.env.OAUTH_MOCK_BASE}/${k}/auth`;
    prov.tokenUrl = `${process.env.OAUTH_MOCK_BASE}/${k}/token`;
    prov.userUrl = `${process.env.OAUTH_MOCK_BASE}/${k}/user`;
  }
}
const ENABLED_PROVIDERS = Object.keys(PROVIDERS).filter((k) => PROVIDERS[k].clientId && PROVIDERS[k].secret);
const DEV_LOGIN = process.env.DEV_LOGIN === '1';
const SESSION_DAYS = 60;

// Ключът за подписване на сесиите: от SESSION_SECRET или създаден веднъж и пазен на диска
function loadSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, 'session-secret');
  try { const s = fs.readFileSync(file, 'utf8').trim(); if (s.length >= 32) return s; } catch { /* няма */ }
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}
const SESSION_SECRET = loadSessionSecret();

function sign(obj) {
  const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}
function unsign(token) {
  if (!token) return null;
  const [body, mac] = String(token).split('.');
  if (!body || !mac) return null;
  const good = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (good.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(mac))) return null;
  try {
    const o = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return o.exp && o.exp < Date.now() ? null : o;
  } catch { return null; }
}
function readCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore */ } }
  }
  return out;
}
function isHttps(req) {
  return PUBLIC_URL.startsWith('https://') ||
    (TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
}
function setCookie(res, req, name, value, maxAgeSec) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (isHttps(req)) parts.push('Secure');
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(prev ? [].concat(prev) : []), parts.join('; ')]);
}
function baseUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const host = (TRUST_PROXY && req.headers['x-forwarded-host']) || req.headers.host;
  return `${isHttps(req) ? 'https' : 'http'}://${host}`;
}
const devLoginAllowed = (req) => DEV_LOGIN || (!ENABLED_PROVIDERS.length && isLocal(req.socket.remoteAddress || ''));

function currentUser(req) {
  const s = unsign(readCookies(req).dt_session);
  return s && s.uid ? db.users[s.uid] || null : null;
}
function requireUser(req) {
  const u = currentUser(req);
  if (!u) throw new HttpError(401, 'Влез с Google или Discord, за да направиш това.');
  return u;
}
function userView(u) {
  return u ? { id: u.id, name: u.name, avatar: u.avatar || null, provider: u.provider } : null;
}

function loginUser(res, req, provider, providerId, name, avatar) {
  const uid = 'u_' + crypto.createHash('sha256').update(`${provider}:${providerId}`).digest('hex').slice(0, 16);
  let u = db.users[uid];
  if (!u) u = db.users[uid] = { id: uid, provider, name: clean(name, 30) || 'Слушател', avatar: avatar || null, createdAt: Date.now() };
  else if (avatar) u.avatar = avatar;  // името не се презаписва: потребителят може да го е сменил
  u.lastLoginAt = Date.now();
  rememberFan(uid, u.name);
  save();
  setCookie(res, req, 'dt_session', sign({ uid, exp: Date.now() + SESSION_DAYS * 864e5 }), SESSION_DAYS * 86400);
  return u;
}

// Прехвърля точките, песните и гласа от стария идентификатор на браузъра към акаунта (веднъж)
function claimBrowserData(oldId, uid) {
  if (!oldId || oldId === uid || db.claims[oldId] || oldId.startsWith('u_')) return { moved: false };
  let moved = 0;
  for (const board of Object.values(db.fanStats)) {
    const st = board[oldId];
    if (!st) continue;
    const mine = board[uid] || (board[uid] = { votes: 0, tips: 0 });
    mine.votes += st.votes;
    mine.tips += st.tips;
    delete board[oldId];
    moved++;
  }
  for (const s of db.songs) if (s.addedById === oldId) { s.addedById = uid; moved++; }
  for (const t of db.tips) if (t.voterId === oldId) t.voterId = uid;
  if (db.duel && db.duel.votes[oldId]) {
    if (!db.duel.votes[uid]) db.duel.votes[uid] = db.duel.votes[oldId];
    delete db.duel.votes[oldId];
  }
  delete db.fans[oldId];
  db.claims[oldId] = uid;
  fanVersion++;
  return { moved: moved > 0 };
}

async function oauthExchange(provider, code, redirectUri) {
  const p = PROVIDERS[provider];
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const tr = await fetch(p.tokenUrl, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: p.clientId, client_secret: p.secret, code, grant_type: 'authorization_code', redirect_uri: redirectUri,
      }),
    });
    const tok = await tr.json().catch(() => ({}));
    if (!tr.ok || !tok.access_token) throw new Error('token ' + tr.status + ' ' + (tok.error || ''));
    const ur = await fetch(p.userUrl, { signal: ctrl.signal, headers: { Authorization: `Bearer ${tok.access_token}` } });
    const raw = await ur.json().catch(() => ({}));
    if (!ur.ok) throw new Error('user ' + ur.status);
    const prof = p.profile(raw);
    if (!prof.id) throw new Error('no id');
    return prof;
  } finally { clearTimeout(t); }
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

async function handleAuth(req, res, url) {
  const p = url.pathname;
  // /auth/google, /auth/discord → към страницата за вход
  let m = p.match(/^\/auth\/(google|discord)$/);
  if (m && req.method === 'GET') {
    const provider = m[1];
    if (!ENABLED_PROVIDERS.includes(provider)) return redirect(res, '/?login=unavailable');
    const state = crypto.randomBytes(16).toString('hex');
    setCookie(res, req, 'dt_oauth', sign({ state, provider, exp: Date.now() + 10 * 60e3 }), 600);
    const prov = PROVIDERS[provider];
    const q = new URLSearchParams({
      client_id: prov.clientId, redirect_uri: `${baseUrl(req)}/auth/${provider}/callback`,
      response_type: 'code', scope: prov.scope, state, ...prov.extra,
    });
    return redirect(res, `${prov.authUrl}?${q}`);
  }
  // Връщане от Google/Discord
  m = p.match(/^\/auth\/(google|discord)\/callback$/);
  if (m && req.method === 'GET') {
    const provider = m[1];
    const saved = unsign(readCookies(req).dt_oauth);
    setCookie(res, req, 'dt_oauth', '', 0);
    const code = url.searchParams.get('code');
    if (!ENABLED_PROVIDERS.includes(provider) || !code || !saved ||
        saved.provider !== provider || saved.state !== url.searchParams.get('state')) {
      return redirect(res, '/?login=error');
    }
    try {
      const prof = await oauthExchange(provider, code, `${baseUrl(req)}/auth/${provider}/callback`);
      loginUser(res, req, provider, prof.id, prof.name, prof.avatar);
      return redirect(res, '/?login=ok');
    } catch (e) {
      console.error(`Входът с ${provider} не мина:`, e.message);
      return redirect(res, '/?login=error');
    }
  }
  // Тестов вход: само локално без настроени Google/Discord, или с DEV_LOGIN=1
  if (p === '/auth/dev' && req.method === 'POST') {
    if (!devLoginAllowed(req)) throw new HttpError(404, 'Няма такъв адрес.');
    const body = await readJson(req);
    const name = clean(body.name, 30);
    if (!name) throw new HttpError(400, 'Напиши име.');
    const u = loginUser(res, req, 'dev', name.toLowerCase(), name, null);
    return sendJson(res, 200, { user: userView(u) });
  }
  if (p === '/auth/logout' && req.method === 'POST') {
    setCookie(res, req, 'dt_session', '', 0);
    return sendJson(res, 200, { ok: true });
  }
  throw new HttpError(404, 'Няма такъв адрес.');
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
// Промените се събират и се пращат най-много 4 пъти в секунда, директно с данните,
// така че браузърите не питат сървъра наново. Гласовете се пращат като малко отделно
// съобщение само с броя, а цялото състояние само когато се промени нещо друго.
const clients = new Set();
const streamsPerIp = new Map();
const pendingKinds = { state: false, votes: false, library: false };
let flushTimer = null;
const FLUSH_MS = 250;

function broadcast(kind = 'state') {
  pendingKinds[kind] = true;
  if (!flushTimer) flushTimer = setTimeout(flushBroadcast, FLUSH_MS);
}
function sendAll(message) {
  for (const c of clients) {
    // Браузър, който не смогва да приема (много бавна връзка), се изключва; ще се свърже наново сам
    if (c.writableLength > 1024 * 1024) { c.destroy(); clients.delete(c); continue; }
    c.write(message);
  }
}
function flushBroadcast() {
  flushTimer = null;
  if (pendingKinds.state) {
    pendingKinds.state = false;
    pendingKinds.votes = false;
    const payload = JSON.stringify(withViewer(null, () => publicState(null)));
    sendAll(`event: state\ndata: ${payload}\n\n`);
  } else if (pendingKinds.votes) {
    pendingKinds.votes = false;
    if (db.duel) sendAll(`event: votes\ndata: ${JSON.stringify({ duelId: db.duel.id, counts: voteCounts(db.duel) })}\n\n`);
  }
  if (pendingKinds.library) {
    pendingKinds.library = false;
    sendAll(`event: library\ndata: ${Date.now()}\n\n`);
  }
}
setInterval(() => sendAll('event: ping\ndata: 1\n\n'), 20000);

// ---------- Ограничения на заявките ----------
// Пазят от тролове и случайно претоварване. Адресите на самия компютър (localhost) не се ограничават.
const buckets = new Map();
function allow(key, max, perMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start > perMs) { b = { start: now, n: 0 }; buckets.set(key, b); }
  b.n++;
  return b.n <= max;
}
function limit(key, max, perMs, message) {
  if (!allow(key, max, perMs)) throw new HttpError(429, message || 'Твърде много заявки. Изчакай малко и опитай пак.');
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now - b.start > 24 * 3600e3) buckets.delete(k);
}, 600e3);
function clientIp(req) {
  if (TRUST_PROXY) {
    const f = req.headers['x-forwarded-for'];
    if (f) return String(f).split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}
const isLocal = (ip) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
function limitIp(req, name, max, perMs, message) {
  const ip = clientIp(req);
  if (!isLocal(ip)) limit(`${name}:${ip}`, max, perMs, message);
}

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
    const ip = clientIp(req);
    const open = streamsPerIp.get(ip) || 0;
    if (!isLocal(ip) && open >= MAX_STREAMS_PER_IP) throw new HttpError(429, 'Твърде много отворени прозорци от един адрес.');
    streamsPerIp.set(ip, open + 1);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',  // за да не задържа nginx съобщенията
    });
    // Ако много браузъри се свържат наново наведнъж (рестарт), се разпределят в рамките на няколко секунди
    res.write(`retry: ${2000 + Math.floor(Math.random() * 4000)}\n\n`);
    clients.add(res);
    req.on('close', () => {
      clients.delete(res);
      const n = (streamsPerIp.get(ip) || 1) - 1;
      if (n <= 0) streamsPerIp.delete(ip); else streamsPerIp.set(ip, n);
    });
    return;
  }

  // Кой е влязъл и какви начини за вход има
  if (m === 'GET' && p === '/api/session') {
    return sendJson(res, 200, {
      user: userView(currentUser(req)),
      providers: ENABLED_PROVIDERS.map((k) => ({ id: k, label: PROVIDERS[k].label })),
      devLogin: devLoginAllowed(req),
    });
  }
  if (m === 'POST' && p === '/api/session/name') {
    const u = requireUser(req);
    limit(`rename:${u.id}`, 10, 3600e3, 'Смени името твърде много пъти. Опитай пак след малко.');
    const body = await readJson(req);
    const name = clean(body.name, 30);
    if (name.length < 2) throw new HttpError(400, 'Името трябва да е поне 2 знака.');
    u.name = name;
    rememberFan(u.id, name);
    save(); broadcast('state');
    return sendJson(res, 200, { user: userView(u) });
  }
  // Прехвърляне на точките от браузъра (отпреди входа) към акаунта
  if (m === 'POST' && p === '/api/session/claim') {
    const u = requireUser(req);
    const body = await readJson(req);
    const r = claimBrowserData(clean(body.voterId, 64), u.id);
    if (r.moved) { save(); broadcast('state'); broadcast('library'); }
    return sendJson(res, 200, r);
  }

  if (m === 'GET' && p === '/api/health') {
    return sendJson(res, 200, { ok: true, listeners: clients.size, uptime: Math.round(process.uptime()) });
  }

  if (m === 'GET' && p === '/api/state') {
    const v = currentUser(req)?.id || null;
    return sendJson(res, 200, withViewer(v, () => publicState(v)));
  }

  if (m === 'GET' && p === '/api/songs') {
    const v = currentUser(req)?.id || null;
    return sendJson(res, 200, withViewer(v, () => ({ songs: [...db.songs].reverse().map(songView) })));
  }

  // Търсене на песни в YouTube
  if (m === 'GET' && p === '/api/yt-search') {
    requireUser(req);
    const q = clean(url.searchParams.get('q'), 100);
    if (q.length < 2) throw new HttpError(400, 'Напиши поне две букви.');
    if (!YOUTUBE_API_KEY) {
      return sendJson(res, 501, {
        error: 'Търсенето не е включено. Добави YOUTUBE_API_KEY във файла .env и рестартирай сървъра.',
        needsKey: true,
      });
    }
    // Лимитът се брои само за нови търсения; повторените идват от кеша и са безплатни
    const cached = searchCache.get(q.toLowerCase());
    if (!cached || Date.now() - cached.at >= SEARCH_TTL) {
      limitIp(req, 'search', 15, 10 * 60e3, 'Твърде много търсения за кратко време. Изчакай няколко минути.');
      limit('search:all-day', SEARCHES_PER_DAY, 24 * 3600e3,
        'Търсенето за днес е изчерпано (безплатният лимит на YouTube). Дотогава можеш да поставиш линк.');
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
    limitIp(req, 'trim', 30, 10 * 60e3);
    const body = await readJson(req);
    const song = songById(trimMatch[1]);
    const voterId = requireUser(req).id;
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
    limitIp(req, 'add', 15, 10 * 60e3, 'Добави твърде много песни за кратко време. Изчакай няколко минути.');
    const body = await readJson(req);
    const videoId = youtubeId(body.url);
    if (!videoId) throw new HttpError(400, 'Невалиден YouTube линк.');
    const existing = db.songs.find((s) => s.videoId === videoId);
    const me = requireUser(req);
    const adderId = me.id;
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
      addedBy: me.name, addedById: adderId, createdAt: Date.now(),
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
    const me = requireUser(req);
    limitIp(req, 'upload', 6, 3600e3, 'Можеш да качиш до 6 песни на час.');
    const file = await receiveUpload(req, ext);
    const adderId = me.id;
    const song = {
      id: newId(), type: 'audio', audioUrl: '/uploads/' + file.name,
      title, artist, addedBy: me.name, addedById: adderId, createdAt: Date.now(),
      duelWins: 0, defenses: 0, tipsTotal: 0, startAt: 0, endAt: null,
    };
    db.songs.push(song);
    save();
    broadcast('library');
    return sendJson(res, 200, withViewer(adderId, () => ({ song: songView(song) })));
  }

  // Предизвикване на трона
  if (m === 'POST' && p === '/api/challenge') {
    const me = requireUser(req);
    limitIp(req, 'challenge', 10, 10 * 60e3, 'Предизвика трона твърде много пъти за кратко време. Изчакай малко.');
    limit(`challenge:${me.id}`, 10, 10 * 60e3, 'Предизвика трона твърде много пъти за кратко време. Изчакай малко.');
    const body = await readJson(req);
    const song = songById(body.songId);
    if (!song) throw new HttpError(404, 'Няма такава песен.');
    const by = me.name;
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
    const me = requireUser(req);
    const body = await readJson(req);
    const voterId = me.id;
    if (!db.duel) throw new HttpError(400, 'В момента няма дуел.');
    if (voterId.length < 8) throw new HttpError(400, 'Невалиден гласоподавател.');
    if (body.side !== 'champion' && body.side !== 'challenger') throw new HttpError(400, 'Невалиден избор.');
    if (body.duelId && body.duelId !== db.duel.id) throw new HttpError(400, 'Дуелът вече приключи.');
    limit(`vote:${voterId}`, 10, 10e3, 'Сменяш гласа твърде често. Изчакай няколко секунди.');
    limitIp(req, 'vote', 120, 60e3);
    const changed = db.duel.votes[voterId] !== body.side;
    db.duel.votes[voterId] = body.side;
    rememberFan(voterId, me.name);
    if (changed) { save(); broadcast('votes'); }
    return sendJson(res, 200, { ok: true, duelId: db.duel.id, side: body.side });
  }

  // Бакшиш (ТЕСТОВ РЕЖИМ: не се теглят реални пари)
  if (m === 'POST' && p === '/api/tip') {
    limitIp(req, 'tip', 20, 10 * 60e3);
    const body = await readJson(req);
    const song = songById(body.songId);
    const amount = Math.round(Number(body.amount));
    const me = requireUser(req);
    const voterId = me.id;
    if (!song) throw new HttpError(404, 'Няма такава песен.');
    if (song.type !== 'audio') throw new HttpError(400, 'Бакшиши има само за нови артисти с оригинална музика.');
    if (!Number.isFinite(amount) || amount < MIN_TIP || amount > MAX_TIP) throw new HttpError(400, `Сумата трябва да е между ${MIN_TIP} и ${MAX_TIP} €.`);
    if (voterId.length < 8) throw new HttpError(400, 'Невалиден потребител.');
    rememberFan(voterId, me.name);
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
    const me = currentUser(req)?.id || '';
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
    const me = currentUser(req)?.id || '';
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
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin) {
      // Защита от заявки от чужди сайтове: промени се приемат само от страниците на Dethrone
      let originHost = '';
      try { originHost = new URL(req.headers.origin).host; } catch { /* ignore */ }
      const hosts = [req.headers.host, TRUST_PROXY ? req.headers['x-forwarded-host'] : null, PUBLIC_URL ? new URL(PUBLIC_URL).host : null];
      if (!hosts.includes(originHost)) throw new HttpError(403, 'Заявката не идва от сайта.');
    }
    if (url.pathname.startsWith('/auth/')) return await handleAuth(req, res, url);
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
  console.log(`   Данни: ${DATA_DIR}`);
  console.log(ENABLED_PROVIDERS.length
    ? `   Вход: ${ENABLED_PROVIDERS.map((k) => PROVIDERS[k].label).join(', ')}`
    : '   Вход: няма настроен Google/Discord' + (DEV_LOGIN ? ' (тестов вход включен)' : ', тестов вход само от този компютър'));
  if (!STORAGE_DIR && (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID)) {
    console.warn('   ВНИМАНИЕ: няма закачен постоянен диск (volume). Базата и качените песни ще се изтрият при следващото качване на кода.');
  }
  console.log(YOUTUBE_API_KEY
    ? '   Търсене в YouTube: включено'
    : '   Търсене в YouTube: изключено (добави YOUTUBE_API_KEY във файла .env)');
});
