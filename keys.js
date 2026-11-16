// API 키가 필요한 연동: DART(공시), 토스증권(호가·체결·계좌 보유 종목), 한국투자증권 KIS(10단계 호가·체결 틱).
// 키가 없으면 각 기능은 꺼진 상태로 남고 기본 소스(네이버)로 동작한다.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { isUS, ticker } = require('./data');

// ── 설정 저장소: 키는 프로그램의 설정 화면에서 입력하고, 사용자 폴더의 settings.json 에 저장한다.
//    (Windows: %APPDATA%\KRX-APEX, 그 외: ~/.config/krx-apex). 환경변수가 있으면 그 값을 기본값으로 쓴다.
const os = require('os');
const DATA_DIR = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'KRX-APEX')
  : path.join(os.homedir(), '.config', 'krx-apex');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const KEY_NAMES = ['DART_API_KEY', 'TOSS_CLIENT_ID', 'TOSS_CLIENT_SECRET', 'KIS_APP_KEY', 'KIS_APP_SECRET', 'KIS_ENV'];

let settings = {};
try { settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {}; } catch { settings = {}; }

const env = (k) => String(settings[k] ?? process.env[k] ?? '').trim();
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const has = {
  dart: () => !!env('DART_API_KEY'),
  kis: () => !!(env('KIS_APP_KEY') && env('KIS_APP_SECRET')),
  toss: () => !!(env('TOSS_CLIENT_ID') && env('TOSS_CLIENT_SECRET')),
};

const mask = (v) => (v ? '•'.repeat(Math.min(12, Math.max(4, v.length - 4))) + v.slice(-4) : '');

// 화면에 내려주는 값: 키 원문은 절대 돌려주지 않고 끝 4자리만 보여준다.
function publicSettings() {
  return {
    dart: { set: has.dart(), masked: mask(env('DART_API_KEY')) },
    toss: { set: has.toss(), idMasked: mask(env('TOSS_CLIENT_ID')), secretSet: !!env('TOSS_CLIENT_SECRET') },
    kis: { set: has.kis(), keyMasked: mask(env('KIS_APP_KEY')), secretSet: !!env('KIS_APP_SECRET'), paper: env('KIS_ENV') === 'paper' },
    file: SETTINGS_FILE,
  };
}

// patch의 각 항목: 문자열이면 저장(빈 문자열은 삭제), 없으면 유지
function saveSettings(patch) {
  for (const k of KEY_NAMES) {
    if (typeof patch[k] !== 'string') continue;
    const v = patch[k].trim();
    if (v.length > 400 || /[\r\n]/.test(v)) throw new Error('키 형식이 올바르지 않습니다');
    if (v) settings[k] = v; else settings[k] = '';
  }
  persist();
  token = null; corpMap = null; tossTok = null; tossAccount = null;
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), { mode: 0o600 });
}

// ── 프로그램 비밀번호: 원문은 저장하지 않고 scrypt 해시만 둔다.
const crypto = require('crypto');
const hasPassword = () => !!(settings.PW_HASH && settings.PW_SALT);
function checkPassword(pw) {
  if (!hasPassword()) return true;
  const got = crypto.scryptSync(String(pw ?? ''), settings.PW_SALT, 32);
  return crypto.timingSafeEqual(got, Buffer.from(settings.PW_HASH, 'hex'));
}
function setPassword(pw) {
  if (!pw) { delete settings.PW_HASH; delete settings.PW_SALT; }
  else {
    settings.PW_SALT = crypto.randomBytes(16).toString('hex');
    settings.PW_HASH = crypto.scryptSync(String(pw), settings.PW_SALT, 32).toString('hex');
  }
  persist();
}

// 저장된 키로 실제 호출을 한 번 해 보고 결과를 알려준다.
async function testKeys() {
  const out = { dart: null, kis: null, toss: null };
  if (has.toss()) {
    try { const a = await tossAccountSeq(); out.toss = { ok: true, message: a == null ? '토큰 정상 (종합매매 계좌 없음)' : '토큰·계좌 조회 정상' }; }
    catch (e) { out.toss = { ok: false, message: e.message }; }
  }
  if (has.dart()) {
    try { await dartList(''); out.dart = { ok: true, message: '정상' }; }
    catch (e) { out.dart = { ok: false, message: e.message }; }
  }
  if (has.kis()) {
    try { await kisToken(); out.kis = { ok: true, message: '토큰 발급 정상' }; }
    catch (e) { out.kis = { ok: false, message: e.message }; }
  }
  return out;
}

function readCache(name) {
  try { return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, name), 'utf8')); } catch { return null; }
}
function writeCache(name, value) {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(path.join(CACHE_DIR, name), JSON.stringify(value)); } catch { /* 캐시 실패는 무시 */ }
}

// ───────────────────────── DART 전자공시 (opendart.fss.or.kr)
const DART = 'https://opendart.fss.or.kr/api';

// 단일 파일 ZIP에서 첫 항목을 꺼낸다 (corpCode.xml 용)
function unzipFirst(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('DART: ZIP 형식이 아닙니다 (키를 확인하세요)');
  const cd = buf.readUInt32LE(eocd + 16);
  const method = buf.readUInt16LE(cd + 10);
  const size = buf.readUInt32LE(cd + 20);
  const local = buf.readUInt32LE(cd + 42);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const body = buf.subarray(start, start + size);
  return method === 0 ? body : zlib.inflateRawSync(body);
}

// 종목코드 → DART 고유번호(corp_code). 하루 한 번 받아 디스크에 캐시한다.
let corpMap = null;
async function corpCode(stockCode) {
  if (!corpMap) {
    const c = readCache('dart-corp.json');
    if (c && Date.now() - c.at < 7 * 86400e3) corpMap = c.map;
  }
  if (!corpMap) {
    const res = await fetch(`${DART}/corpCode.xml?crtfc_key=${env('DART_API_KEY')}`, { signal: AbortSignal.timeout(30000) });
    const xml = unzipFirst(Buffer.from(await res.arrayBuffer())).toString('utf8');
    corpMap = {};
    const re = /<corp_code>(\d{8})<\/corp_code>[\s\S]*?<stock_code>\s*([0-9A-Z]{6})?\s*<\/stock_code>/g;
    for (let m; (m = re.exec(xml));) if (m[2]) corpMap[m[2]] = m[1];
    writeCache('dart-corp.json', { at: Date.now(), map: corpMap });
  }
  return corpMap[stockCode] || null;
}

const ymd = (d) => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');

// 공시 목록. code가 있으면 해당 종목(최근 1년), 없으면 시장 전체(최근 3일)
async function dartList(code) {
  if (!has.dart()) return null;
  const q = new URLSearchParams({ crtfc_key: env('DART_API_KEY'), page_count: '30', end_de: ymd(new Date()) });
  if (code) {
    const corp = await corpCode(code);
    if (!corp) return [];
    q.set('corp_code', corp);
    q.set('bgn_de', ymd(new Date(Date.now() - 365 * 86400e3)));
  } else {
    q.set('bgn_de', ymd(new Date(Date.now() - 3 * 86400e3)));
  }
  const res = await fetch(`${DART}/list.json?${q}`, { signal: AbortSignal.timeout(15000) });
  const d = await res.json();
  if (d.status === '013') return []; // 조회된 데이터 없음
  if (d.status !== '000') throw new Error(`DART ${d.status}: ${d.message}`);
  return d.list.map((x) => ({
    title: (code ? '' : `${x.corp_name} · `) + String(x.report_nm).trim(),
    office: x.flr_nm || 'DART', dt: `${x.rcept_dt}`,
    url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${x.rcept_no}`,
  }));
}

// ───────────────────────── 한국투자증권 KIS Open API (조회 전용)
const kisBase = () => (env('KIS_ENV') === 'paper'
  ? 'https://openapivts.koreainvestment.com:29443'
  : 'https://openapi.koreainvestment.com:9443');

// 접근 토큰은 24시간 유효하고 발급 횟수 제한이 있어 디스크에 캐시한다.
let token = null;
async function kisToken() {
  if (!token) token = readCache('kis-token.json');
  if (token && token.key === env('KIS_APP_KEY') && token.base === kisBase() && token.exp - Date.now() > 600e3) return token.value;
  const res = await fetch(`${kisBase()}/oauth2/tokenP`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: env('KIS_APP_KEY'), appsecret: env('KIS_APP_SECRET') }),
    signal: AbortSignal.timeout(15000),
  });
  const d = await res.json();
  if (!d.access_token) throw new Error(`KIS 토큰 발급 실패: ${d.error_description || d.msg1 || res.status}`);
  token = { value: d.access_token, exp: Date.now() + (Number(d.expires_in) || 86400) * 1000, key: env('KIS_APP_KEY'), base: kisBase() };
  writeCache('kis-token.json', token);
  return token.value;
}

async function kisGet(pathname, trId, code) {
  const q = new URLSearchParams({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code });
  const res = await fetch(`${kisBase()}${pathname}?${q}`, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8', authorization: `Bearer ${await kisToken()}`,
      appkey: env('KIS_APP_KEY'), appsecret: env('KIS_APP_SECRET'), tr_id: trId, custtype: 'P',
    },
    signal: AbortSignal.timeout(10000),
  });
  const d = await res.json();
  if (d.rt_cd !== '0') throw new Error(`KIS ${d.msg_cd || res.status}: ${d.msg1 || '요청 실패'}`);
  return d;
}

const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };

// 10단계 호가 (data.orderbook 과 같은 형태)
async function kisOrderbook(code) {
  if (!has.kis() || isUS(code)) return null; // 국내 종목만
  const d = await kisGet('/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn', 'FHKST01010200', code);
  const o = d.output1 || {};
  const sell = [], buy = [];
  for (let i = 10; i >= 1; i--) sell.push({ price: n(o[`askp${i}`]), count: n(o[`askp_rsqn${i}`]) });
  for (let i = 1; i <= 10; i++) buy.push({ price: n(o[`bidp${i}`]), count: n(o[`bidp_rsqn${i}`]) });
  const rows = [...sell, ...buy].filter((r) => r.price);
  const max = Math.max(1, ...rows.map((r) => r.count || 0));
  rows.forEach((r) => { r.rate = Math.round((r.count || 0) / max * 100); });
  const cur = n(d.output2 && d.output2.stck_prpr), diff = n(d.output2 && d.output2.antc_cntg_vrss);
  return {
    source: 'KIS', prevClose: n(d.output2 && d.output2.stck_sdpr) ?? (cur != null && diff != null ? cur - diff : null),
    totalSell: n(o.total_askp_rsqn), totalBuy: n(o.total_bidp_rsqn),
    sell: sell.filter((r) => r.price), buy: buy.filter((r) => r.price),
  };
}

// 최근 체결 틱 + 체결강도
async function kisTicks(code) {
  if (!has.kis() || isUS(code)) return null;
  const d = await kisGet('/uapi/domestic-stock/v1/quotations/inquire-ccnl', 'FHKST01010300', code);
  return (d.output || []).slice(0, 20).map((x) => ({
    time: String(x.stck_cntg_hour || '').replace(/(\d\d)(\d\d)(\d\d)/, '$1:$2:$3'),
    price: n(x.stck_prpr), chg: n(x.prdy_vrss), pct: n(x.prdy_ctrt),
    volume: n(x.cntg_vol), strength: n(x.tday_rltv),
  }));
}

// ───────────────────────── 토스증권 Open API (조회 전용; 주문 API는 호출하지 않는다)
// 공식 명세: https://openapi.tossinvest.com/openapi-docs/latest/openapi.json
// 주의: 토스증권 앱/WTS의 설정 > Open API 에서 이 PC의 IP를 '허용 IP'로 등록해야 한다(아니면 403).
const TOSS = 'https://openapi.tossinvest.com';

// client 당 유효 토큰이 1개라 재발급하면 이전 토큰이 즉시 무효가 된다 → 만료 전까지 디스크에 캐시해 재사용한다.
let tossTok = null;
async function tossToken(force) {
  if (!tossTok) tossTok = readCache('toss-token.json');
  if (!force && tossTok && tossTok.id === env('TOSS_CLIENT_ID') && tossTok.exp - Date.now() > 120e3) return tossTok.value;
  const res = await fetch(`${TOSS}/oauth2/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env('TOSS_CLIENT_ID'), client_secret: env('TOSS_CLIENT_SECRET') }),
    signal: AbortSignal.timeout(15000),
  });
  const d = await res.json().catch(() => ({}));
  if (!d.access_token) {
    const why = d.error === 'access_denied' ? '허용되지 않은 IP입니다. 토스증권 설정 > Open API > 허용 IP 관리에 이 PC의 IP를 등록하세요'
      : (d.error_description || d.error || res.status);
    throw new Error(`토스증권 토큰 발급 실패: ${why}`);
  }
  tossTok = { value: d.access_token, exp: Date.now() + (Number(d.expires_in) || 3600) * 1000, id: env('TOSS_CLIENT_ID') };
  writeCache('toss-token.json', tossTok);
  return tossTok.value;
}

async function tossGet(pathname, query, account, retried) {
  const headers = { authorization: `Bearer ${await tossToken()}` };
  if (account != null) headers['X-Tossinvest-Account'] = String(account);
  const qs = query ? '?' + new URLSearchParams(query) : '';
  const res = await fetch(`${TOSS}${pathname}${qs}`, { headers, signal: AbortSignal.timeout(10000) });
  if (res.status === 401 && !retried) { await tossToken(true); return tossGet(pathname, query, account, true); }
  const d = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = d.error || d;
    throw new Error(`토스증권 ${res.status}: ${e.message || e.code || e.error_description || '요청 실패'}`);
  }
  return d.result;
}

let tossAccount = null; // { seq, no }
async function tossAccountSeq() {
  if (!tossAccount) {
    const list = await tossGet('/api/v1/accounts');
    const a = (list || [])[0];
    tossAccount = a ? { seq: a.accountSeq, no: String(a.accountNo || '') } : { seq: null, no: '' };
  }
  return tossAccount.seq;
}

// 호가 (data.orderbook 과 같은 형태). 전일 종가는 응답에 없어 화면에서 시세로 보완한다.
async function tossOrderbook(code) {
  if (!has.toss()) return null;
  const r = await tossGet('/api/v1/orderbook', { symbol: isUS(code) ? ticker(code) : code }); // 미국은 티커로 조회
  const lv = (x) => ({ price: n(x.price), count: n(x.volume) });
  const sell = (r.asks || []).map(lv).sort((a, b) => b.price - a.price);
  const buy = (r.bids || []).map(lv).sort((a, b) => b.price - a.price);
  const max = Math.max(1, ...[...sell, ...buy].map((x) => x.count || 0));
  [...sell, ...buy].forEach((x) => { x.rate = Math.round((x.count || 0) / max * 100); });
  const sum = (a) => a.reduce((t, x) => t + (x.count || 0), 0);
  return { source: 'TOSS', prevClose: null, totalSell: sum(sell), totalBuy: sum(buy), sell, buy };
}

// 최근 체결. 직전 체결가 대비 방향을 chg 부호로 준다(체결강도는 제공되지 않음).
async function tossTicks(code) {
  if (!has.toss()) return null;
  const r = await tossGet('/api/v1/trades', { symbol: isUS(code) ? ticker(code) : code, count: '21' });
  const list = (r || []).map((x) => ({ time: String(x.timestamp || '').slice(11, 19), price: n(x.price), volume: n(x.volume) }));
  return list.slice(0, 20).map((x, i) => ({ ...x, chg: list[i + 1] ? x.price - list[i + 1].price : 0, pct: null, strength: null }));
}

// 계좌 보유 종목 (국내·미국)
async function tossHoldings() {
  if (!has.toss()) return null;
  const seq = await tossAccountSeq();
  if (seq == null) return { account: null, summary: null, items: [] };
  const r = await tossGet('/api/v1/holdings', null, seq);
  // 합계는 통화별(krw, usd)로 따로 온다 → 달러 보유분이 있으면 환율을 받아 원화로 합친다.
  const usdOf = (o) => n(o && o.usd) || 0, krwOf = (o) => n(o && o.krw) || 0;
  let fx = 0;
  if ((r.items || []).some((x) => x.currency === 'USD')) {
    try { const e = await tossGet('/api/v1/exchange-rate', { baseCurrency: 'USD', quoteCurrency: 'KRW' }); fx = n(e && (e.rate ?? e.exchangeRate)) || 0; }
    catch (e) { console.error('토스증권 환율 조회 실패:', e.message); }
  }
  const total = (o) => krwOf(o) + usdOf(o) * fx;
  const no = tossAccount.no;
  return {
    account: no ? '•'.repeat(Math.max(0, no.length - 4)) + no.slice(-4) : '',
    fx, // 달러 → 원 환율. 0이면 달러 보유분을 원화 합계에 넣지 못한 것
    summary: {
      purchase: total(r.totalPurchaseAmount), value: total(r.marketValue && r.marketValue.amount),
      pnl: total(r.profitLoss && r.profitLoss.amount), pnlRate: n(r.profitLoss && r.profitLoss.rate),
      day: total(r.dailyProfitLoss && r.dailyProfitLoss.amount), dayRate: n(r.dailyProfitLoss && r.dailyProfitLoss.rate),
    },
    items: (r.items || []).map((x) => ({
      code: x.symbol, name: x.name, country: x.marketCountry, currency: x.currency,
      qty: n(x.quantity), price: n(x.lastPrice), cost: n(x.averagePurchasePrice),
      purchase: n(x.marketValue && x.marketValue.purchaseAmount), value: n(x.marketValue && x.marketValue.amount),
      pnl: n(x.profitLoss && x.profitLoss.amount), pnlRate: n(x.profitLoss && x.profitLoss.rate),
      day: n(x.dailyProfitLoss && x.dailyProfitLoss.amount), dayRate: n(x.dailyProfitLoss && x.dailyProfitLoss.rate),
    })),
  };
}

module.exports = { hasPassword, checkPassword, setPassword, has, dartList, kisOrderbook, kisTicks, tossOrderbook, tossTicks, tossHoldings, publicSettings, saveSettings, testKeys };
