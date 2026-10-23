// Тест за натоварване: симулира много отворени браузъри и гласуване по време на дуел.
// Употреба: node tools/loadtest.js [адрес] [брой браузъри] [гласа в секунда] [секунди]
// Пример:   node tools/loadtest.js http://localhost:3000 300 50 15
// Внимание: тестът добавя песни и гласове в базата. Пускай го на тестов сървър, не на истинския.
const http = require('http');
const https = require('https');

const BASE = process.argv[2] || 'http://localhost:3000';
const CLIENTS = Number(process.argv[3] || 300);
const VOTES_PER_SEC = Number(process.argv[4] || 50);
const SECONDS = Number(process.argv[5] || 15);

const lib = BASE.startsWith('https') ? https : http;
const agent = new lib.Agent({ keepAlive: true, maxSockets: 2000 });

const stats = { requests: 0, errors: 0, bytes: 0, refetches: 0, events: 0, voteMs: [], stateMs: [] };

function request(method, path, body) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = lib.request(BASE + path, {
      method, agent,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, (res) => {
      let n = 0;
      const chunks = [];
      res.on('data', (c) => { n += c.length; chunks.push(c); });
      res.on('end', () => {
        stats.requests++;
        stats.bytes += n;
        if (res.statusCode >= 500) stats.errors++;
        resolve({ ms: performance.now() - t0, status: res.statusCode, body: Buffer.concat(chunks).toString() });
      });
    });
    req.on('error', () => { stats.errors++; resolve({ ms: performance.now() - t0, status: 0, body: '' }); });
    req.setTimeout(15000, () => req.destroy());
    if (data) req.write(data);
    req.end();
  });
}

// Един „браузър“: отваря живите обновления и прави това, което прави страницата.
// Ако съобщението носи само сигнал (без данни), браузърът пита сървъра наново, както в старата версия.
function openClient(i) {
  const voterId = `load-${i}-${Math.random().toString(36).slice(2, 10)}`;
  return new Promise((resolve) => {
    const req = lib.get(BASE + '/api/events', { agent: false }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        stats.bytes += c.length;
        buf += c.toString();
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = (block.match(/^event: (.+)$/m) || [])[1];
          const data = (block.match(/^data: (.*)$/m) || [])[1] || '';
          if (!ev) continue;
          stats.events++;
          if (ev === 'state' && data.length < 20) {
            stats.refetches++;
            request('GET', '/api/state?voterId=' + voterId).then((r) => stats.stateMs.push(r.ms));
          }
        }
      });
      resolve({ voterId, req });
    });
    req.on('error', () => { stats.errors++; resolve({ voterId, req }); });
  });
}

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function setup() {
  // Две песни като качени файлове (без нужда от интернет), едната на трона, другата в дуел
  const wav = Buffer.alloc(44 + 16000);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + 16000, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(16000, 40);
  const ids = [];
  for (const title of ['Тест А', 'Тест Б']) {
    const q = new URLSearchParams({ title: title + ' ' + Date.now(), artist: 'Натоварване', original: 'true', ext: 'wav' });
    const r = await new Promise((resolve) => {
      const req = lib.request(BASE + '/api/upload?' + q, { method: 'POST', headers: { 'Content-Type': 'audio/wav', 'Content-Length': wav.length } }, (res) => {
        let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => resolve(s));
      });
      req.end(wav);
    });
    ids.push(JSON.parse(r).song.id);
  }
  await request('POST', '/api/challenge', { songId: ids[0], by: 'тест' });
  await request('POST', '/api/challenge', { songId: ids[1], by: 'тест' });
  const st = JSON.parse((await request('GET', '/api/state')).body);
  if (!st.duel) throw new Error('Няма активен дуел. Пусни сървъра с дълъг дуел, например DUEL_SECONDS=600.');
}

(async () => {
  console.log(`Адрес ${BASE}, ${CLIENTS} браузъра, ${VOTES_PER_SEC} гласа/сек, ${SECONDS} сек`);
  await setup();
  const clients = [];
  for (let i = 0; i < CLIENTS; i++) clients.push(await openClient(i));
  await new Promise((r) => setTimeout(r, 500));
  Object.assign(stats, { requests: 0, bytes: 0, refetches: 0, events: 0, voteMs: [], stateMs: [], errors: 0 });

  const t0 = Date.now();
  const timer = setInterval(() => {
    for (let k = 0; k < VOTES_PER_SEC / 10; k++) {
      const c = clients[Math.floor(Math.random() * clients.length)];
      const side = Math.random() < 0.5 ? 'champion' : 'challenger';
      request('POST', '/api/vote', { voterId: c.voterId, side, name: 'Тест' }).then((r) => {
        stats.voteMs.push(r.ms);
        if (r.status === 429) stats.limited = (stats.limited || 0) + 1;
      });
    }
  }, 100);
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
  clearInterval(timer);
  await new Promise((r) => setTimeout(r, 1500));
  const secs = (Date.now() - t0) / 1000;

  console.log('');
  console.log(`Гласове:                 ${stats.voteMs.length}${stats.limited ? ` (${stats.limited} спрени от лимита)` : ''}`);
  console.log(`Време за глас:           средно ${pct(stats.voteMs, 50).toFixed(0)} ms, 95% под ${pct(stats.voteMs, 95).toFixed(0)} ms, най-бавно ${pct(stats.voteMs, 100).toFixed(0)} ms`);
  console.log(`Обновления до браузъри:  ${stats.events} (${(stats.events / secs).toFixed(0)}/сек)`);
  console.log(`Повторни питания:        ${stats.refetches}${stats.stateMs.length ? `, 95% под ${pct(stats.stateMs, 95).toFixed(0)} ms` : ''}`);
  console.log(`Заявки към сървъра:      ${stats.requests} (${(stats.requests / secs).toFixed(0)}/сек)`);
  console.log(`Изпратени данни:         ${(stats.bytes / 1024 / 1024).toFixed(1)} MB (${(stats.bytes / 1024 / 1024 / secs).toFixed(2)} MB/сек)`);
  console.log(`Грешки:                  ${stats.errors}`);
  for (const c of clients) c.req.destroy();
  process.exit(0);
})();
