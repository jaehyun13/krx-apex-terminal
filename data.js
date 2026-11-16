// 데이터 계층: 네이버페이 증권(국내 시세·뉴스·수급) + Yahoo Finance(해외 지수·원자재)
// 모든 함수는 화면에서 바로 쓸 수 있는 정규화된 JSON을 돌려준다.

const HEADERS = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://m.stock.naver.com/' };
const M = 'https://m.stock.naver.com';
const API = 'https://api.stock.naver.com';
const POLL = 'https://polling.finance.naver.com/api/realtime/domestic';

const INDEX_CODES = { KOSPI: '코스피', KOSDAQ: '코스닥', KPI200: '코스피 200' };
const FX = [
  ['FX_USDKRW', '달러/원'],
  ['FX_JPYKRW', '엔/원(100엔)'],
  ['FX_EURKRW', '유로/원'],
  ['FX_CNYKRW', '위안/원'],
];
const WORLD = [
  ['^GSPC', 'S&P 500'],
  ['^IXIC', '나스닥'],
  ['^N225', '닛케이 225'],
  ['^TNX', '미 국채 10년(%)'],
  ['CL=F', 'WTI'],
  ['GC=F', '금'],
  ['BTC-KRW', '비트코인(원)'],
];

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

const isIndex = (code) => Object.hasOwn(INDEX_CODES, code);

function num(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/[,%+]/g, ''));
  return Number.isNaN(n) ? null : n;
}

// 네이버는 전일 대비 값의 부호를 빼고 주는 경우가 있어 방향 코드로 부호를 다시 붙인다.
function direction(o) {
  const n = o && o.name;
  if (n === 'RISING' || n === 'UPPER_LIMIT') return 1;
  if (n === 'FALLING' || n === 'LOWER_LIMIT') return -1;
  return 0;
}

function priceFields(d) {
  const s = direction(d.compareToPreviousPrice);
  return {
    price: num(d.closePrice),
    chg: Math.abs(num(d.compareToPreviousClosePrice) || 0) * s,
    pct: Math.abs(num(d.fluctuationsRatio) || 0) * s,
  };
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/<[^>]+>/g, '');
}

const settled = async (promises) =>
  (await Promise.allSettled(promises)).map((r) => (r.status === 'fulfilled' ? r.value : null));

function ymd(date) {
  // KST 기준 yyyymmdd
  return new Date(date.getTime() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
}

// ── 시장 개요: 국내 지수, 환율, 해외·원자재, 투자자별 순매수, 등락 종목 수
async function overview() {
  const [idx, fx, world, kospi, kosdaq] = await settled([
    getJson(`${POLL}/index/${Object.keys(INDEX_CODES).join(',')}`),
    settled(FX.map(([code]) =>
      getJson(`${M}/front-api/marketIndex/productDetail?category=exchange&reutersCode=${code}`))),
    settled(WORLD.map(([sym]) =>
      getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`))),
    getJson(`${M}/api/index/KOSPI/integration`),
    getJson(`${M}/api/index/KOSDAQ/integration`),
  ]);

  // 지수 카드용: 시·고·저, 거래대금(원), 당일 분봉 스파크라인
  const sparks = await settled(Object.keys(INDEX_CODES).map((c) => chart(c, '1D')));
  const indices = ((idx && idx.datas) || []).map((d) => {
    const sp = sparks[Object.keys(INDEX_CODES).indexOf(d.itemCode)];
    return {
      code: d.itemCode, name: d.stockName, ...priceFields(d),
      open: num(d.openPrice), high: num(d.highPrice), low: num(d.lowPrice),
      value: num(d.accumulatedTradingValueRaw),
      tradedAt: d.localTradedAt || null,
      prevClose: sp ? sp.prevClose : null,
      spark: sp ? sp.bars.filter((_, i, a) => i % 5 === 0 || i === a.length - 1).map((b) => b[1]) : [],
    };
  });

  const fxRows = (fx || []).map((r, i) => {
    const d = r && r.result;
    if (!d) return null;
    const chg = num(d.fluctuations) || 0;
    return {
      code: FX[i][0], name: FX[i][1], price: num(d.closePrice), chg,
      pct: Math.abs(num(d.fluctuationsRatio) || 0) * Math.sign(chg),
    };
  }).filter(Boolean);

  const worldRows = (world || []).map((r, i) => {
    const m = r && r.chart && r.chart.result && r.chart.result[0] && r.chart.result[0].meta;
    if (!m || m.regularMarketPrice == null) return null;
    const prev = m.chartPreviousClose ?? m.previousClose;
    const chg = prev ? m.regularMarketPrice - prev : 0;
    return {
      code: WORLD[i][0], name: WORLD[i][1], price: m.regularMarketPrice, chg,
      pct: prev ? (chg / prev) * 100 : 0,
    };
  }).filter(Boolean);

  const market = (code, d) => {
    if (!d) return null;
    const f = d.dealTrendInfo || {};
    const u = d.upDownStockInfo || {};
    const g = d.programTrendInfo || {};
    return {
      // 프로그램 매매(억원): 차익 / 비차익 / 합계
      program: { arb: num(g.indexDifferenceReal), nonArb: num(g.indexBiDifferenceReal), total: num(g.indexTotalReal) },
      code, name: INDEX_CODES[code], date: f.bizdate || null,
      // 단위: 억원
      flow: { personal: num(f.personalValue), foreign: num(f.foreignValue), inst: num(f.institutionalValue) },
      breadth: {
        upper: num(u.upperCount), rise: num(u.riseCount), steady: num(u.steadyCount),
        fall: num(u.fallCount), lower: num(u.lowerCount),
      },
    };
  };

  return {
    ts: Date.now(),
    status: (idx && idx.datas && idx.datas[0] && idx.datas[0].marketStatus) || null,
    indices, fx: fxRows, world: worldRows,
    markets: [market('KOSPI', kospi), market('KOSDAQ', kosdaq)].filter(Boolean),
  };
}

// ── 순위: type = marketValue | up | down | quantTop(거래량), market = KOSPI | KOSDAQ
const RANK_TYPES = ['marketValue', 'up', 'down', 'quantTop'];
async function rank(type = 'marketValue', market = 'KOSPI', size = 30) {
  if (!RANK_TYPES.includes(type)) throw new Error('bad type');
  if (market !== 'KOSPI' && market !== 'KOSDAQ') throw new Error('bad market');
  const d = await getJson(`${M}/api/stocks/${type}/${market}?page=1&pageSize=${size}`);
  return (d.stocks || []).map((s) => ({
    code: s.itemCode, name: s.stockName, ...priceFields(s),
    volume: num(s.accumulatedTradingVolume),
    value: s.accumulatedTradingValueKrwHangeul || null,
    mcap: s.marketValueHangeul || null,
  }));
}

// ── 종목/지수 상세
async function quote(code) {
  const base = isIndex(code) ? `${M}/api/index/${code}` : `${M}/api/stock/${encodeURIComponent(code)}`;
  const [b, g] = await Promise.all([getJson(`${base}/basic`), getJson(`${base}/integration`)]);
  return {
    code, name: b.stockName, isIndex: isIndex(code),
    market: (b.stockExchangeType && b.stockExchangeType.nameKor) || null,
    ...priceFields(b),
    status: b.marketStatus || null,
    tradedAt: b.localTradedAt || null,
    infos: (g.totalInfos || []).map((i) => ({ code: i.code, key: i.key, value: i.value, desc: i.valueDesc || null })),
    // 일자별 투자자 순매수(주)
    flows: (g.dealTrendInfos || []).map((f) => ({
      date: f.bizdate, close: num(f.closePrice),
      foreign: num(f.foreignerPureBuyQuant), inst: num(f.organPureBuyQuant),
      indiv: num(f.individualPureBuyQuant), holdRatio: f.foreignerHoldRatio || null,
    })),
  };
}

// ── 차트
// range=D  → 3년치 일봉 [[yyyymmdd, 시, 고, 저, 종, 거래량], ...]
// range=1D → 최근 거래일 분봉 [[hhmm, 종, 거래량], ...] + prevClose
async function chart(code, range = 'D') {
  const kind = isIndex(code) ? 'index' : 'item';
  const base = `${API}/chart/domestic/${kind}/${encodeURIComponent(code)}`;
  if (range === '1D') {
    const b = await getJson(`${isIndex(code) ? `${M}/api/index/${code}` : `${M}/api/stock/${encodeURIComponent(code)}`}/basic`);
    const day = String(b.localTradedAt || '').slice(0, 10).replace(/-/g, '') || ymd(new Date());
    const rows = await getJson(`${base}/minute?startDateTime=${day}0900&endDateTime=${day}1530`);
    const p = priceFields(b);
    return {
      range, date: day, prevClose: p.price != null ? p.price - p.chg : null,
      bars: rows.map((r) => [r.localDateTime.slice(8, 12), r.currentPrice, r.accumulatedTradingVolume]),
    };
  }
  const end = new Date();
  const start = new Date(end.getTime() - 3 * 366 * 86400e3);
  const rows = await getJson(`${base}/day?startDateTime=${ymd(start)}&endDateTime=${ymd(end)}`);
  return {
    range: 'D',
    bars: rows.map((r) => [Number(r.localDate), r.openPrice, r.highPrice, r.lowPrice, r.closePrice, r.accumulatedTradingVolume]),
  };
}

// ── 뉴스: 종목 코드가 있으면 종목 뉴스, 없거나 지수면 주요 뉴스
async function news(code) {
  if (code && !isIndex(code)) {
    const d = await getJson(`${M}/api/news/stock/${encodeURIComponent(code)}?pageSize=15&page=1`);
    return d.flatMap((g) => g.items || []).map((n) => ({
      title: decodeEntities(n.title), office: n.officeName, dt: n.datetime,
      url: n.mobileNewsUrl || `https://n.news.naver.com/mnews/article/${n.officeId}/${n.articleId}`,
    }));
  }
  const d = await getJson(`${M}/api/news/list?category=mainnews&pageSize=15&page=1`);
  return d.map((n) => ({
    title: decodeEntities(n.tit), office: n.ohnm, dt: String(n.dt).slice(0, 12),
    url: `https://n.news.naver.com/mnews/article/${n.oid}/${n.aid}`,
  }));
}

// ── 종목 검색(자동완성)
async function search(q) {
  q = String(q || '').trim();
  if (!q) return [];
  const d = await getJson(`https://ac.stock.naver.com/ac?q=${encodeURIComponent(q)}&target=stock`);
  return (d.items || []).filter((i) => i.nationCode === 'KOR').slice(0, 10)
    .map((i) => ({ code: i.code, name: i.name, market: i.typeName }));
}

// ── 업종별 등락률
async function sectors() {
  const d = await getJson(`${M}/api/stocks/industry?page=1&pageSize=100`);
  return (d.groups || []).map((g) => ({
    no: g.no, name: g.name, pct: num(g.changeRate), count: g.totalCount,
    rise: g.riseCount, fall: g.fallCount, steady: g.steadyCount,
  })).sort((a, b) => b.pct - a.pct);
}

// ── 호가 (5단계). 지수는 호가가 없으므로 null
async function orderbook(code) {
  if (isIndex(code)) return null;
  const d = await getJson(`${M}/api/stock/${encodeURIComponent(code)}/askingPrice`);
  const lv = (x) => ({ price: num(x.price), count: num(x.count), rate: num(x.rate) || 0 });
  return {
    prevClose: num(d.lastClosePrice),
    totalSell: num(d.totalSell), totalBuy: num(d.totalBuy),
    sell: (d.sellInfo || d.sellInfos || []).map(lv), // 높은 호가 → 낮은 호가
    buy: (d.buyInfos || d.buyInfo || []).map(lv),    // 높은 호가 → 낮은 호가
  };
}

// ── 공시
async function disclosures(code) {
  if (isIndex(code)) return [];
  const d = await getJson(`${M}/api/stock/${encodeURIComponent(code)}/disclosure?page=1&pageSize=20`);
  return d.map((x) => ({
    title: decodeEntities(x.title), office: x.author || '공시',
    dt: String(x.datetime || '').replace(/[-T:]/g, '').slice(0, 12),
    url: `https://m.stock.naver.com/domestic/stock/${code}/disclosure/${x.disclosureId}`,
  }));
}

// ── 연간 재무 요약 (매출·이익은 억원)
const FIN_ROWS = ['매출액', '영업이익', '당기순이익', '영업이익률', '순이익률', 'ROE', '부채비율', 'EPS', 'PER', 'BPS', 'PBR', '주당배당금'];
async function financials(code) {
  if (isIndex(code)) return null;
  const d = await getJson(`${M}/api/stock/${encodeURIComponent(code)}/finance/annual`);
  const f = d.financeInfo;
  if (!f || !f.trTitleList) return null;
  const periods = f.trTitleList.map((t) => ({ key: t.key, title: t.title.replace(/\.$/, ''), estimate: t.isConsensus === 'Y' }));
  const rows = (f.rowList || []).filter((r) => FIN_ROWS.includes(r.title)).map((r) => ({
    title: r.title, values: periods.map((p) => (r.columns[p.key] ? r.columns[p.key].value : '-')),
  }));
  return { periods, rows };
}

// ── 여러 종목 현재가 (포트폴리오용)
async function quotes(codes) {
  if (!codes.length) return [];
  const d = await getJson(`${POLL}/stock/${codes.map(encodeURIComponent).join(',')}`);
  return (d.datas || []).map((x) => ({ code: x.itemCode, name: x.stockName, ...priceFields(x) }));
}

// ── 거시: 환율·금리·원자재·운임 + 해외 지수
const MACRO_GROUPS = ['exchange', 'exchangeWorld', 'bond', 'domesticInterest', 'standardInterest', 'energy', 'metals', 'transport'];
const WORLD_INDEX = { USA: ['.DJI', '.INX', '.IXIC', '.SOX', '.VIX'], JPN: ['.N225'], CHN: ['.SSEC'], HKG: ['.HSI'] };

function macroItem(x, category) {
  const text = String(x.closePrice ?? '');
  const dp = (text.split('.')[1] || '').length;
  const s = direction(x.fluctuationsType);
  const ratio = num(x.fluctuationsRatio);
  return {
    code: x.reutersCode, name: x.name, category: x.categoryType || category,
    price: num(text), priceText: text, dp,
    chg: Math.abs(num(x.fluctuations) || 0) * s,
    pct: ratio == null ? null : Math.abs(ratio) * s,
    unit: x.unit || null, month: x.month || null,
  };
}

async function macro() {
  const [majors, kr3y, ...nations] = await settled([
    getJson(`${M}/front-api/marketIndex/majors`),
    getJson(`${API}/marketindex/bond/KR3YT=RR`),
    ...Object.keys(WORLD_INDEX).map((n) => getJson(`${API}/index/nation/${n}`)),
  ]);
  const r = (majors && majors.result) || {};
  const groups = {};
  for (const g of MACRO_GROUPS) groups[g] = (r[g] || []).map((x) => macroItem(x, g));
  if (kr3y && groups.bond) {
    const item = macroItem(kr3y, 'bond');
    const at = groups.bond.findIndex((b) => b.code === 'KR10YT=RR');
    groups.bond.splice(at < 0 ? 0 : at, 0, item);
  }
  const world = [];
  Object.entries(WORLD_INDEX).forEach(([nation, codes], i) => {
    for (const x of nations[i] || []) {
      if (!codes.includes(x.reutersCode)) continue;
      world.push({ code: x.reutersCode, name: x.indexName, nation, ...priceFields(x) });
    }
  });
  return { ts: Date.now(), groups, world };
}

// 거시 항목 일별 추이: [[yyyymmdd, 종가], ...] 오래된 순
async function macroChart(category, code) {
  if (!MACRO_GROUPS.includes(category)) throw new Error('bad category');
  // 한 번에 60건까지만 허용되어 두 쪽을 이어 붙인다.
  const url = (page) => `${API}/marketindex/${category}/${encodeURIComponent(code)}/prices?page=${page}&pageSize=60`;
  const [p1, p2] = await settled([getJson(url(1)), getJson(url(2))]);
  if (!p1) throw new Error('이 항목은 추이 데이터를 제공하지 않습니다');
  return [...p1, ...(p2 || [])]
    .map((x) => [Number(String(x.localTradedAt).slice(0, 10).replace(/-/g, '')), num(x.closePrice)])
    .filter((x) => x[1] != null).reverse();
}

module.exports = {
  overview, rank, quote, chart, news, search, sectors, orderbook, disclosures, financials, quotes, macro, macroChart, INDEX_CODES,
};
