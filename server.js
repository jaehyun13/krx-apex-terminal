// 의존성 없는 Node 서버: 화면 파일 + /api/* (data.js·keys.js를 짧게 캐시해서 중계)
// 단일 실행 파일(exe)로 묶였을 때는 화면 파일을 내장 자산에서 읽고, 시작하면 창을 연다.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const data = require('./data');
const keys = require('./keys');

let sea = null;
try { const s = require('node:sea'); if (s.isSea()) sea = s; } catch { /* 일반 node 실행 */ }

const HOST = '127.0.0.1'; // 키 설정 API가 있으므로 이 PC에서만 접속 가능하게 한다
const PUBLIC = path.join(__dirname, 'public');
const FILES = ['index.html', 'style.css', 'app.js', 'chart.js'];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function readPublic(name) {
  if (!FILES.includes(name)) return null;
  if (sea) return Buffer.from(sea.getAsset(name));
  try { return fs.readFileSync(path.join(PUBLIC, name)); } catch { return null; }
}

// 경로별 핸들러와 캐시 유지 시간(ms)
const ROUTES = {
  overview: { ttl: 10e3, run: () => data.overview() },
  rank: { ttl: 10e3, run: (q) => data.rank(q.get('type') || undefined, q.get('market') || undefined) },
  quote: { ttl: 5e3, run: (q) => data.quote(code(q)) },
  quotes: { ttl: 5e3, run: (q) => data.quotes(codes(q)) },
  chart: { ttl: 20e3, run: (q) => data.chart(code(q), q.get('range') === '1D' ? '1D' : 'D') },
  news: { ttl: 20e3, run: (q) => data.news(q.get('code') ? code(q) : '') },
  search: { ttl: 300e3, run: (q) => data.search(q.get('q')) },
  sectors: { ttl: 30e3, run: () => data.sectors() },
  financials: { ttl: 3600e3, run: (q) => data.financials(code(q)) },
  macro: { ttl: 30e3, run: () => data.macro() },
  macrochart: { ttl: 300e3, run: (q) => data.macroChart(q.get('category') || '', macroCode(q)) },
  // 키가 있으면 공식 소스(토스증권 → KIS, DART)를 쓰고, 없거나 실패하면 기본 소스로 내려간다.
  orderbook: { ttl: 3e3, run: (q) => firstOf([() => keys.tossOrderbook(code(q)), () => keys.kisOrderbook(code(q)), () => data.orderbook(code(q))]) },
  ticks: { ttl: 3e3, run: async (q) => {
    const c = code(q);
    let source = null;
    const sources = [];
    if (keys.has.toss()) sources.push(async () => { const t = await keys.tossTicks(c); source = '토스증권'; return t; });
    if (keys.has.kis()) sources.push(async () => { const t = await keys.kisTicks(c); source = 'KIS'; return t; });
    if (!sources.length) return { enabled: false, ticks: [] };
    return { enabled: true, ticks: (await firstOf(sources)) || [], source };
  } },
  holdings: { ttl: 5e3, run: async () => (keys.has.toss() ? { enabled: true, ...(await keys.tossHoldings()) } : { enabled: false }) },
  disclosures: { ttl: 120e3, run: (q) => firstOf([() => keys.dartList(code(q)), () => data.disclosures(code(q))]) },
  filings: { ttl: 120e3, run: async () => (keys.has.dart() ? { enabled: true, list: await keys.dartList('') } : { enabled: false, list: [] }) },
};

// 앞에서부터 시도해 처음으로 값을 돌려주는 소스를 쓴다. 마지막 소스의 오류는 그대로 올린다.
async function firstOf(sources, swallowLast = false) {
  for (let i = 0; i < sources.length; i++) {
    const last = i === sources.length - 1;
    try {
      const v = await sources[i]();
      if (v != null) return v;
    } catch (e) {
      if (last && !swallowLast) throw e;
      console.error('키 연동 실패, 다음 소스로 대체:', e.message);
    }
  }
  return null;
}

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
function code(q) {
  const c = q.get('code') || '';
  if (!/^[A-Za-z0-9]{1,12}$/.test(c)) throw bad('bad code');
  return c;
}
function codes(q) {
  const list = (q.get('codes') || '').split(',').filter(Boolean);
  if (list.length > 50 || list.some((c) => !/^[A-Za-z0-9]{1,12}$/.test(c))) throw bad('bad codes');
  return list;
}
function macroCode(q) {
  const c = q.get('code') || '';
  if (!/^[A-Za-z0-9_.=]{1,24}$/.test(c)) throw bad('bad code');
  return c;
}

const cache = new Map(); // key → { at, promise }
function cached(key, ttl, run) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const promise = Promise.resolve().then(run);
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return promise;
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 8192) { reject(bad('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(bad('bad json')); } });
    req.on('error', reject);
  });
}

// 다른 웹사이트가 이 PC의 설정 API를 호출하지 못하게, 같은 출처의 JSON 요청만 받는다.
function sameOrigin(req) {
  const local = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
  if (!local.test(req.headers.host || '')) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return local.test(new URL(origin).host); } catch { return false; }
}

async function handleSettings(req, res) {
  if (!sameOrigin(req)) return send(res, 403, '{"error":"forbidden"}');
  if (req.method === 'GET') return send(res, 200, JSON.stringify(keys.publicSettings()));
  if (req.method !== 'POST' || !/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 405, '{"error":"method"}');
  const body = await readBody(req);
  keys.saveSettings(body);
  cache.clear();
  const test = await keys.testKeys();
  send(res, 200, JSON.stringify({ ...keys.publicSettings(), test }));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/settings') return await handleSettings(req, res);
    if (url.pathname.startsWith('/api/')) {
      const route = ROUTES[url.pathname.slice(5)];
      if (!route || req.method !== 'GET') return send(res, 404, '{"error":"not found"}');
      const body = await cached(url.pathname + url.search, route.ttl, () => route.run(url.searchParams));
      return send(res, 200, JSON.stringify(body));
    }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const buf = readPublic(name);
    if (!buf) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, buf, MIME[path.extname(name)]);
  } catch (e) {
    console.error(url.pathname + url.search, e.message);
    if (!res.headersSent) send(res, e.status || 502, JSON.stringify({ error: e.message }));
  }
});

// 프로그램 창 열기: Windows는 Edge 앱 창(주소창 없는 독립 창), 실패하면 기본 브라우저
function openWindow(url) {
  const run = (cmd, args) => new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', () => resolve(false));
      child.on('exit', (c) => resolve(c === 0));
      child.unref();
    } catch { resolve(false); }
  });
  if (process.platform === 'win32') {
    return run('cmd', ['/c', 'start', '', 'msedge', `--app=${url}`, '--window-size=1600,960'])
      .then((ok) => ok || run('cmd', ['/c', 'start', '', url]));
  }
  return run(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
}

// 포트가 이미 쓰이고 있으면 다음 번호로 넘어간다.
function listen(port, triesLeft) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && triesLeft > 0) return listen(port + 1, triesLeft - 1);
    console.error('서버를 시작하지 못했습니다:', e.message);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    const url = `http://localhost:${server.address().port}`;
    console.log(`KRX::APEX 터미널 실행 중  ${url}`);
    console.log('이 창을 닫으면 프로그램이 종료됩니다.');
    if ((sea || process.argv.includes('--open')) && !process.argv.includes('--no-open')) openWindow(url);
  });
}
listen(Number(process.env.PORT) || 3000, 20);
