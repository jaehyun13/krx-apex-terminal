// 화면 로직: 상태 → 렌더. 표시하는 값은 전부 /api 응답에서 온다(하드코딩 수치 없음).
const $ = (id) => document.getElementById(id);
const REFRESH_MS = 20000;
const INDEX_ALIAS = { KOSPI: 'KOSPI', 코스피: 'KOSPI', KOSDAQ: 'KOSDAQ', 코스닥: 'KOSDAQ', KPI200: 'KPI200', 코스피200: 'KPI200' };
const INDEX_TAG = { KOSPI: '001', KOSDAQ: '201', KPI200: '101' };
const RANGES = { '1M': 22, '3M': 66, '1Y': 250, '3Y': Infinity };
const VIEWS = ['market', 'stock', 'macro', 'port'];

const state = {
  code: load('code') || '005930',
  range: load('range') || '3M',
  rankType: 'marketValue',
  rankMarket: 'KOSPI',
  daily: null,      // { code, bars } 일봉 원본(이평 포함)
  intraday: null,   // { code, bars, prevClose }
  quote: null,
};

function load(k) { try { return localStorage.getItem('kt.' + k); } catch { return null; } }
function save(k, v) { try { localStorage.setItem('kt.' + k, v); } catch { /* 저장 불가 환경 무시 */ } }

async function api(path, body) {
  const res = await fetch('api/' + path, body === undefined ? undefined
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 401) { showLock(); throw new Error('잠금 상태'); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
  return res.json();
}

// ── 표기
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'dn' : 'flat');
const arrow = (v) => (v > 0 ? '▲' : v < 0 ? '▼' : '−');
function fmt(v, dp) {
  if (v == null) return '−';
  const d = dp ?? (Number.isInteger(v) ? 0 : 2);
  return v.toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
}
const signed = (v, dp) => (v == null ? '−' : (v > 0 ? '+' : '') + fmt(v, dp));
const pct = (v) => (v == null ? '−' : (v > 0 ? '+' : '') + v.toFixed(2) + '%');
const dateLabel = (n) => { const s = String(n); return `${s.slice(0, 4)}.${s.slice(4, 6)}.${s.slice(6, 8)}`; };
const kstTime = (t) => new Date(t).toLocaleTimeString('en-GB', { timeZone: 'Asia/Seoul', hour12: false });
const chgHtml = (r, dp = 2) => `<span>${arrow(r.chg)} ${signed(r.chg, dp)}</span><span>(${pct(r.pct)})</span>`;
const kv = (label, html, c = '') => `<div><span>${esc(label)}</span><span class="${c}">${html}</span></div>`;

const isUS = (code) => String(code).includes('.'); // 미국 종목·지수는 로이터 코드(AAPL.O, .IXIC)
const US_MARKETS = ['NASDAQ', 'NYSE'];
const US_ALIAS = { NASDAQ: '.IXIC', 나스닥: '.IXIC', DOW: '.DJI', 다우: '.DJI', SPX: '.INX', 'S&P500': '.INX', SP500: '.INX', SOX: '.SOX', VIX: '.VIX' };
const money = (v, cur) => (v == null ? '−' : cur === 'USD' ? '$' + fmt(v, 2) : fmt(Math.round(v)));

function showMsg(text) { $('msg').textContent = text || ''; $('msg').hidden = !text; }

// ── 화면 전환 (#market / #stock)
function currentView() { const v = location.hash.slice(1); return VIEWS.includes(v) ? v : 'market'; }
function applyView() {
  const v = currentView();
  VIEWS.forEach((n) => { $('view-' + n).hidden = n !== v; });
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.view === v));
  if (v === 'stock') chart.redraw();
  if (v === 'macro') macroChart.redraw();
  loadView(v);
}
function go(view) { if (currentView() === view) applyView(); else location.hash = view; }

// ── 지수 카드
let sparkSeq = 0;
function sparkSvg(vals, prev, dir) {
  if (!vals || vals.length < 2) return '<svg class="spark" viewBox="0 0 100 36"></svg>';
  const lo = Math.min(...vals, prev ?? Infinity), hi = Math.max(...vals, prev ?? -Infinity);
  const y = (v) => (hi === lo ? 18 : 3 + (hi - v) / (hi - lo) * 30).toFixed(1);
  const pts = vals.map((v, i) => `${(i / (vals.length - 1) * 100).toFixed(1)},${y(v)}`);
  const stroke = dir >= 0 ? 'var(--primary-c)' : 'var(--secondary)';
  const fill = dir >= 0 ? 'var(--primary-c)' : 'var(--secondary-c)';
  const id = 'sg' + (sparkSeq++);
  return `<svg class="spark" viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true">` +
    `<defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${fill}" stop-opacity=".35"/><stop offset="1" stop-color="${fill}" stop-opacity="0"/></linearGradient></defs>` +
    `<path d="M${pts.join(' L')} L100,36 L0,36 Z" fill="url(#${id})"/>` +
    `<path d="M${pts.join(' L')}" fill="none" stroke="${stroke}" stroke-width="1.75" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
}

function renderCards(o) {
  sparkSeq = 0;
  const idx = Object.fromEntries(o.indices.map((i) => [i.code, i]));
  const mk = Object.fromEntries(o.markets.map((m) => [m.code, m]));
  const time = (i) => (i.tradedAt ? `${i.tradedAt.slice(11, 19)} KST` : '');
  const eok = (v) => `${signed(v)}억`;

  const indexCard = (i, rowsHtml) => `<button type="button" class="card" data-code="${esc(i.code)}">` +
    `<div class="card-h"><span class="card-n">${esc(i.code === 'KPI200' ? 'KOSPI200' : i.code)}<span class="badge ${cls(i.chg)}">${INDEX_TAG[i.code] || ''}</span></span><span class="card-time">${time(i)}</span></div>` +
    `<div class="card-mid"><div><div class="card-px ${cls(i.chg)}">${fmt(i.price, 2)}</div><div class="card-chg ${cls(i.chg)}">${chgHtml(i)}</div></div>${sparkSvg(i.spark, i.prevClose, i.chg)}</div>` +
    `<div class="kv">${rowsHtml}</div></button>`;

  const flowRows = (m) => (m ? kv('외인 순매수', eok(m.flow.foreign), cls(m.flow.foreign)) +
    kv('기관 순매수', eok(m.flow.inst), cls(m.flow.inst)) + kv('개인 순매수', eok(m.flow.personal), cls(m.flow.personal)) : kv('수급', '−'));

  const html = [];
  for (const code of ['KOSPI', 'KOSDAQ']) if (idx[code]) html.push(indexCard(idx[code], flowRows(mk[code])));
  if (idx.KPI200) {
    const i = idx.KPI200;
    html.push(indexCard(i, kv('시가', fmt(i.open, 2)) + kv('고가', fmt(i.high, 2), 'up') + kv('저가', fmt(i.low, 2), 'dn')));
  }

  const usd = o.fx.find((f) => f.code === 'FX_USDKRW');
  if (usd) {
    const rest = o.fx.filter((f) => f !== usd);
    html.push(`<div class="card"><div class="card-h"><span class="card-n">USD / KRW<span class="badge">FX_SEOUL</span></span>` +
      `<span class="card-time ${cls(-usd.chg)} b">${usd.chg < 0 ? '원화 강세' : usd.chg > 0 ? '원화 약세' : '보합'}</span></div>` +
      `<div class="card-mid"><div><div class="card-px ${cls(usd.chg)}">${fmt(usd.price, 2)}</div><div class="card-chg ${cls(usd.chg)}">${chgHtml(usd)}</div></div></div>` +
      `<div class="kv">${rest.map((f) => kv(f.name, `${fmt(f.price, 2)} <span class="${cls(f.chg)}">(${pct(f.pct)})</span>`)).join('')}</div></div>`);
  }

  const breadth = (m) => {
    const b = m.breadth, total = (b.rise || 0) + (b.steady || 0) + (b.fall || 0) || 1;
    return `<div><div class="breadth-row"><span class="up b">${esc(m.name)} 상승 ${fmt(b.rise)}${b.upper ? ` (상 ${b.upper})` : ''}</span>` +
      `<span class="flat">보합 ${fmt(b.steady)}</span><span class="dn b">하락 ${fmt(b.fall)}${b.lower ? ` (하 ${b.lower})` : ''}</span></div>` +
      `<div class="breadth"><span class="r" style="width:${b.rise / total * 100}%"></span><span class="s" style="width:${b.steady / total * 100}%"></span><span class="f" style="width:${b.fall / total * 100}%"></span></div></div>`;
  };
  const turnover = (idx.KOSPI?.value || 0) + (idx.KOSDAQ?.value || 0);
  html.push(`<div class="card"><div class="card-h"><span class="card-n">당일 시장 등락 분포</span><span class="card-time accent">ADV / DEC</span></div>` +
    `<div class="col" style="gap:6px">${o.markets.map(breadth).join('')}</div>` +
    `<div class="kv">${kv('시장 대금 (코스피+코스닥)', turnover ? `${(turnover / 1e12).toFixed(2)}조원` : '−', 'accent')}</div></div>`);

  $('cards').innerHTML = html.join('');
}

function renderHeader(o) {
  const open = o.status === 'OPEN';
  $('status').textContent = `KRX REGULAR: ${open ? 'OPEN' : 'CLOSE'}`;
  $('status').classList.toggle('open', open);
  $('status-dot').className = 'dot ' + (open ? 'open' : '');
  $('feed').textContent = `FEED ${kstTime(o.ts)}`;
}

function renderTape(o) {
  const item = (r) => `<span class="it"><span class="nm">${esc(r.name)}</span><span class="${cls(r.chg)}">${fmt(r.price, 2)}</span>` +
    `<span class="${cls(r.chg)}">${arrow(r.chg)} ${signed(r.chg, 2)} (${pct(r.pct)})</span></span>`;
  $('tape').innerHTML = [...o.indices, ...o.fx, ...o.world].map(item).join('<span class="bar">|</span>');
}

function renderProgram(o) {
  const m = o.markets.find((x) => x.code === 'KOSPI');
  const p = m && m.program;
  $('program').innerHTML = p && p.total != null
    ? `<div class="pg-h"><span>프로그램 매매 동향 (코스피)</span><span class="${cls(p.total)}">${signed(p.total)}억</span></div>` +
      `<div class="pg-grid"><div><span>차익거래</span><span class="${cls(p.arb)}">${signed(p.arb)}억</span></div>` +
      `<div><span>비차익거래</span><span class="${cls(p.nonArb)}">${signed(p.nonArb)}억</span></div></div>`
    : '<div class="pg-h"><span>프로그램 매매 동향</span><span class="flat">−</span></div>';
}

// ── 업종
function renderSectors(list) {
  const tile = (s) => `<div class="tile ${cls(s.pct)}"><div class="tile-h"><span class="tile-n" title="${esc(s.name)}">${esc(s.name)}</span>` +
    `<span class="tile-p ${cls(s.pct)}">${arrow(s.pct)} ${pct(s.pct)}</span></div>` +
    `<div class="tile-s"><span>${s.count}종목</span><span>상승 ${s.rise} · 하락 ${s.fall}</span></div></div>`;
  $('tiles').innerHTML = [...list.slice(0, 3), ...list.slice(-3).reverse()].map(tile).join('');
  const row = (s, i) => `<div class="rank-row"><span><span class="no">${String(i + 1).padStart(2, '0')}</span>${esc(s.name)}</span>` +
    `<span class="${cls(s.pct)}">${pct(s.pct)} ${arrow(s.pct)}</span></div>`;
  const n = list.length;
  $('sector-rank').innerHTML = list.slice(0, 4).map(row).join('') + list.slice(-4).map((s, i) => row(s, n - 4 + i)).join('');
}

// ── 순위 표
function renderRank(list) {
  const badge = { KOSPI: 'KS', KOSDAQ: 'KQ', NASDAQ: 'NQ', NYSE: 'NY' }[state.rankMarket];
  const us = US_MARKETS.includes(state.rankMarket), dp = us ? 2 : 0;
  $('rank').tBodies[0].innerHTML = list.map((r) => {
    const c = cls(r.chg);
    return `<tr data-code="${esc(r.code)}" class="${r.code === state.code ? 'sel' : ''}">` +
      `<td>${esc(r.symbol || r.code)}</td><td class="nm">${esc(r.name)}<span class="badge">${badge}</span></td>` +
      `<td class="${c} b">${us ? '$' : ''}${fmt(r.price, dp)}</td><td class="${c}">${arrow(r.chg)} ${signed(r.chg, dp)}</td><td class="${c} b">${pct(r.pct)}</td>` +
      `<td>${fmt(r.volume)}</td><td class="accent b">${esc((r.value || '−').replace(/원$/, ''))}</td><td>${esc((r.mcap || '−').replace(/원$/, ''))}</td></tr>`;
  }).join('');
}
async function loadRank() {
  try { renderRank(await api(`rank?type=${state.rankType}&market=${state.rankMarket}`)); }
  catch (e) { $('rank').tBodies[0].innerHTML = `<tr><td colspan="8">순위를 불러오지 못했습니다 (${esc(e.message)})</td></tr>`; }
}

// ── 선택 종목 (마켓 화면 하단 바 + 우측 수급, 종목 화면 전체)
function renderQuote(q) {
  const us = isUS(q.code), dp = q.isIndex || us ? 2 : 0, cur = us && !q.isIndex ? '$' : '';
  const c = cls(q.chg);
  const open = q.status === 'OPEN';

  $('sel').innerHTML = `<span class="accent b">선택 종목:</span><span class="nm">${esc(q.symbol || q.code)} ${esc(q.name)}</span>` +
    `<span class="${c} b">${fmt(q.price, dp)} ${arrow(q.chg)} (${pct(q.pct)})</span>`;

  $('quote').innerHTML =
    `<div class="q-h"><span class="q-n">${esc(q.name)}</span><span class="badge ${open ? 'accent' : ''}">${open ? '장중' : '장마감'}</span></div>` +
    `<div class="q-meta">${esc(q.symbol || q.code)}${q.market && !q.isIndex ? ' · ' + esc(q.market) : ''}${us ? ' · USD' : ''}</div>` +
    `<div class="q-px ${c}">${cur}${fmt(q.price, dp)}</div>` +
    `<div class="q-chg ${c}">${chgHtml(q, dp)}</div>` +
    (q.extended ? `<div class="q-meta">${esc(q.extended.session)} <span class="${cls(q.extended.chg)} b">${cur}${fmt(q.extended.price, dp)} ${arrow(q.extended.chg)} ${signed(q.extended.chg, dp)} (${pct(q.extended.pct)})</span></div>` : '') +
    `<div class="q-meta">${q.tradedAt ? esc(q.tradedAt.slice(0, 19).replace('T', ' ')) + (us ? ' 현지시각' : ' KST') : ''}</div>`;

  $('infos').innerHTML = q.infos.map((i) =>
    `<div><dt>${esc(i.key)}</dt><dd title="${esc(i.value)}${i.desc ? ' (' + esc(i.desc) + ')' : ''}">${esc(i.value)}</dd></div>`).join('');

  $('flows').tBodies[0].innerHTML = q.flows.length
    ? q.flows.map((f) => `<tr><td>${dateLabel(f.date).slice(5)}</td><td>${fmt(f.close)}</td>` +
        ['foreign', 'inst', 'indiv'].map((k) => `<td class="${cls(f[k])} b">${signed(f[k])}</td>`).join('') +
        `<td>${esc(f.holdRatio || '−')}</td></tr>`).join('')
    : `<tr><td colspan="6" style="text-align:left">${us ? '미국 주식은 투자자별 수급을 제공하지 않습니다' : '지수는 종목별 수급을 제공하지 않습니다'}</td></tr>`;

  // 마켓 화면 우측: 일별 수급 요약 + 외국인·기관 합산 매수/매도 비중
  $('mini-title').textContent = `${q.name} 일별 수급`;
  if (q.flows.length) {
    const short = (v) => (v == null ? '−' : Math.abs(v) >= 1e4 ? signed(Math.round(v / 1e3) / 10, 1) + '만' : signed(v));
    let buy = 0, sell = 0;
    q.flows.forEach((f) => [f.foreign, f.inst].forEach((v) => { if (v > 0) buy += v; else if (v < 0) sell -= v; }));
    const tot = buy + sell || 1;
    $('mini-flows').innerHTML = '<div class="mini-row h"><span>일자</span><span>외국인</span><span>기관</span><span>개인</span></div>' +
      q.flows.map((f) => `<div class="mini-row ${f.foreign > 0 ? 'buy' : f.foreign < 0 ? 'sell' : ''}"><span>${dateLabel(f.date).slice(5)}</span>` +
        ['foreign', 'inst', 'indiv'].map((k) => `<span class="${cls(f[k])}">${short(f[k])}</span>`).join('') + '</div>').join('') +
      `<div class="mini-foot"><div><span class="up">외인·기관 매수 ${(buy / tot * 100).toFixed(1)}%</span><span class="dn">매도 ${(sell / tot * 100).toFixed(1)}%</span></div>` +
      `<div class="pressure"><span class="r" style="width:${buy / tot * 100}%"></span><span class="f" style="width:${sell / tot * 100}%"></span></div></div>`;
  } else {
    $('mini-flows').innerHTML = `<div class="empty">${us ? '미국 주식은 투자자별 수급을 제공하지 않습니다.' : '지수는 종목별 수급을 제공하지 않습니다. 종목을 선택하세요.'}</div>`;
  }
  document.title = `${q.name} ${fmt(q.price, dp)} · KRX::APEX`;
}

function renderWire(el, list, emptyText = '뉴스가 없습니다') {
  el.innerHTML = list.length ? list.map((n) => {
    const d = String(n.dt || '');
    const when = d.length >= 12 ? `${d.slice(4, 6)}.${d.slice(6, 8)} ${d.slice(8, 10)}:${d.slice(10, 12)}` : d.length === 8 ? `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}` : '';
    return `<a href="${esc(n.url)}" target="_blank" rel="noopener"><span class="meta"><span>[${esc(n.office || '뉴스')}]</span><span>${when}</span></span><p>${esc(n.title)}</p></a>`;
  }).join('') : `<div class="empty">${esc(emptyText)}</div>`;
}

// ── 차트 데이터 가공
function withMA(rows) {
  const bars = rows.map(([d, o, h, l, c, v]) => ({ date: d, o, h, l, c, v }));
  for (const p of [5, 20, 60]) {
    let sum = 0;
    bars.forEach((b, i) => {
      sum += b.c;
      if (i >= p) sum -= bars[i - p].c;
      b['ma' + p] = i >= p - 1 ? sum / p : null;
    });
  }
  return bars;
}
function toWeekly(bars) {
  const out = [];
  let key = null;
  for (const b of bars) {
    const s = String(b.date);
    const dt = new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
    const monday = Math.floor((dt.getTime() / 86400e3 + 3) / 7); // 월요일 시작 주 번호
    if (monday !== key) { out.push({ ...b }); key = monday; continue; }
    const w = out[out.length - 1];
    w.h = Math.max(w.h, b.h); w.l = Math.min(w.l, b.l); w.c = b.c; w.v += b.v;
    w.date = b.date; w.ma5 = b.ma5; w.ma20 = b.ma20; w.ma60 = b.ma60;
  }
  return out;
}

const chart = createChart($('chart'), { onHover: renderReadout });

function renderReadout(bar) {
  const b = bar || (chart.current && chart.current[chart.current.length - 1]);
  if (!b) { $('readout').textContent = ''; return; }
  $('readout').textContent = state.range === '1D'
    ? `${b.label}  ${fmt(b.c)}  거래량 ${fmt(b.v)}`
    : `${b.label}  시 ${fmt(b.o)}  고 ${fmt(b.h)}  저 ${fmt(b.l)}  종 ${fmt(b.c)}  거래량 ${fmt(b.v)}`;
}

function renderChart() {
  if (state.range === '1D') {
    const d = state.intraday && state.intraday.code === state.code ? state.intraday : null;
    const bars = d ? d.bars.map(([t, c, v]) => ({
      label: `${t.slice(0, 2)}:${t.slice(2)}`, o: c, h: c, l: c, c, v,
      tickKey: t.slice(0, 2), tickLabel: `${t.slice(0, 2)}시`,
    })) : [];
    chart.current = bars;
    chart.set({ mode: 'line', bars, prevClose: d ? d.prevClose : null, dp: isUS(state.code) ? 2 : undefined });
    $('legend').innerHTML = d ? '<span>점선: 전일 종가</span>' : '';
  } else {
    const d = state.daily && state.daily.code === state.code ? state.daily : null;
    let bars = d ? d.bars.slice(-Math.min(RANGES[state.range], d.bars.length)) : [];
    const weekly = bars.length > 320;
    if (weekly) bars = toWeekly(bars);
    const yearly = bars.length > 130;
    bars = bars.map((b) => {
      const s = String(b.date);
      return { ...b, label: dateLabel(b.date) + (weekly ? ' 주' : ''),
        tickKey: yearly ? s.slice(0, 4) + Math.floor((+s.slice(4, 6) - 1) / 3) : s.slice(0, 6),
        tickLabel: `${s.slice(2, 4)}.${s.slice(4, 6)}` };
    });
    chart.current = bars;
    chart.set({ mode: 'candle', bars, dp: isUS(state.code) ? 2 : undefined });
    $('legend').innerHTML = d ? [['ma5', '5일선'], ['ma20', '20일선'], ['ma60', '60일선']]
      .map(([k, t]) => `<span><i style="background:var(--${k})"></i>${t}</span>`).join('') + (weekly ? '<span>주봉</span>' : '') : '';
  }
  renderReadout(null);
}

async function loadChart(force) {
  const code = state.code;
  try {
    if (state.range === '1D') {
      if (force || !state.intraday || state.intraday.code !== code) {
        const d = await api(`chart?code=${code}&range=1D`);
        if (code !== state.code) return;
        state.intraday = { code, ...d };
      }
    } else if (force || !state.daily || state.daily.code !== code) {
      const d = await api(`chart?code=${code}&range=D`);
      if (code !== state.code) return;
      state.daily = { code, bars: withMA(d.bars) };
    }
  } catch (e) {
    if (code === state.code) showMsg(`차트를 불러오지 못했습니다 (${e.message})`);
  }
  if (code === state.code) renderChart();
}

async function loadQuote() {
  const code = state.code;
  const q = await api(`quote?code=${code}`);
  if (code !== state.code) return;
  state.quote = q;
  renderQuote(q);
}

// open=true면 종목 화면으로 이동한다.
async function selectCode(code, open = false) {
  code = isUS(code) ? String(code) : String(code).toUpperCase(); // 로이터 코드는 대소문자를 구분한다(BRKb.N)
  const prev = state.code;
  state.code = code;
  showMsg('');
  try {
    await loadQuote();
  } catch (e) {
    state.code = prev;
    showMsg(`'${code}' 종목을 찾지 못했습니다 (${e.message})`);
    return false;
  }
  save('code', code);
  document.querySelectorAll('#rank tbody tr').forEach((tr) => tr.classList.toggle('sel', tr.dataset.code === code));
  if (open) go('stock');
  loadChart();
  const isStock = !state.quote.isIndex;
  $('news-title').textContent = isStock ? `${state.quote.name} 뉴스` : '주요 뉴스';
  api(`news?code=${isStock ? code : ''}`).then((n) => code === state.code && renderWire($('news'), n)).catch(() => renderWire($('news'), []));
  loadStockExtras();
  return true;
}

// ── 주기 갱신
async function refresh() {
  const results = await Promise.allSettled([
    api('overview').then((o) => { const u = o.fx.find((f) => f.code === 'FX_USDKRW'); if (u) state.usdkrw = u.price; renderHeader(o); renderCards(o); renderTape(o); renderProgram(o); }),
    loadQuote(),
    loadView(currentView(), true),
  ]);
  if (results[0].status === 'rejected') { $('feed').textContent = 'FEED OFFLINE'; $('status-dot').className = 'dot off'; }
}

// 화면별로 필요한 데이터만 받는다.
function loadView(v, periodic = false) {
  if (v === 'market') {
    return Promise.allSettled([loadRank(), api('sectors').then(renderSectors),
      pollWire()]);
  }
  if (v === 'stock') {
    if (periodic && state.quote && state.quote.status === 'OPEN') loadChart(true);
    return Promise.allSettled([loadBook(), loadTicks()]);
  }
  if (v === 'macro') return loadMacro();
  if (v === 'port') return loadPort();
  return null;
}

// ── 종목 심층: 호가 · 체결 · 공시 · 재무
const keysLink = '<button type="button" class="link" data-open-keys>API 키 설정</button>';

function renderBook(b) {
  if (!b || (!b.sell.length && !b.buy.length)) {
    $('book').innerHTML = isUS(state.code) && !state.code.startsWith('.')
      ? `<div class="empty">미국 주식 호가는 토스증권 키를 입력하면 표시됩니다. ${keysLink}</div>`
      : '<div class="empty">호가 정보가 없습니다 (지수이거나 장 시작 전)</div>';
    return;
  }
  const levels = Math.max(b.sell.length, b.buy.length);
  $('book-src').textContent = `${b.source === 'KIS' ? 'KIS ' : b.source === 'TOSS' ? '토스증권 ' : ''}${levels}단계`;
  const prev = b.prevClose ?? (state.quote && state.quote.code === state.code ? state.quote.price - state.quote.chg : null);
  const row = (l, side) => `<div class="bk">` +
    (side === 'sell' ? `<span class="q sell"><i style="width:${l.rate}%"></i><b>${fmt(l.count)}</b></span>` : '<span class="q none"></span>') +
    `<span class="p ${prev == null ? 'flat' : cls(l.price - prev)}">${fmt(l.price)}</span>` +
    (side === 'buy' ? `<span class="q buy"><i style="width:${l.rate}%"></i><b>${fmt(l.count)}</b></span>` : '<span class="q none"></span>') + '</div>';
  const tot = (b.totalSell || 0) + (b.totalBuy || 0) || 1;
  $('book').innerHTML = '<div class="bk"><span class="q none dn" style="text-align:right">매도잔량</span><span class="q none flat" style="text-align:center">호가</span><span class="q none up">매수잔량</span></div>' +
    b.sell.map((l) => row(l, 'sell')).join('') + b.buy.map((l) => row(l, 'buy')).join('') +
    `<div class="mini-foot"><div><span class="up">총 매수잔량 ${(b.totalBuy / tot * 100).toFixed(1)}%</span><span class="dn">총 매도잔량 ${(b.totalSell / tot * 100).toFixed(1)}%</span></div>` +
    `<div class="pressure"><span class="r" style="width:${b.totalBuy / tot * 100}%"></span><span class="f" style="width:${b.totalSell / tot * 100}%"></span></div></div>`;
}
async function loadBook() {
  const code = state.code;
  try { const b = await api(`orderbook?code=${code}`); if (code === state.code) renderBook(b); }
  catch { if (code === state.code) renderBook(null); }
}

function renderTicks(t) {
  if (!t.enabled) {
    $('ticks-src').textContent = 'TICK';
    $('ticks').innerHTML = `<div class="empty">토스증권 또는 한국투자증권 키를 입력하면 체결 틱이 표시됩니다. ${keysLink}</div>`;
    return;
  }
  $('ticks-src').textContent = t.source || 'TICK';
  if (!t.ticks.length) { $('ticks').innerHTML = '<div class="empty">체결 내역이 없습니다</div>'; return; }
  $('ticks').innerHTML = '<div class="mini-row t h"><span>시간</span><span>체결가</span><span>수량</span><span>체결강도</span></div>' +
    t.ticks.map((x) => `<div class="mini-row t ${x.chg > 0 ? 'buy' : x.chg < 0 ? 'sell' : ''}"><span>${esc(x.time)}</span>` +
      `<span class="${cls(x.chg)}">${fmt(x.price)}</span><span>${fmt(x.volume)}</span><span class="${cls((x.strength ?? 100) - 100)}">${x.strength == null ? '−' : x.strength.toFixed(1) + '%'}</span></div>`).join('');
}
async function loadTicks() {
  const code = state.code;
  if (state.quote && state.quote.isIndex) { $('ticks').innerHTML = '<div class="empty">지수는 체결 틱을 제공하지 않습니다</div>'; return; }
  try { const t = await api(`ticks?code=${code}`); if (code === state.code) renderTicks(t); }
  catch (e) { if (code === state.code) $('ticks').innerHTML = `<div class="empty">체결 틱을 불러오지 못했습니다 (${esc(e.message)}). ${keysLink}</div>`; }
}

function renderFin(f) {
  const t = $('fin');
  if (!f || !f.rows.length) {
    t.tHead.innerHTML = ''; t.tBodies[0].innerHTML = '<tr><td style="text-align:left">재무 정보가 없습니다</td></tr>';
    return;
  }
  $('fin-unit').textContent = f.unit ? `${f.unit} · (E) 추정` : '매출·이익 억원 · (E) 추정';
  t.tHead.innerHTML = '<tr><th>항목</th>' + f.periods.map((p) => `<th class="${p.estimate ? 'est' : ''}">${esc(p.title)}${p.estimate ? ' (E)' : ''}</th>`).join('') + '</tr>';
  t.tBodies[0].innerHTML = f.rows.map((r) => `<tr><td>${esc(r.title)}</td>` +
    r.values.map((v) => `<td class="${String(v).startsWith('-') && v !== '-' ? 'dn' : ''}">${esc(v === '-' ? '−' : v)}</td>`).join('') + '</tr>').join('');
}

function loadStockExtras() {
  const code = state.code;
  const isStock = state.quote && !state.quote.isIndex;
  loadBook(); loadTicks();
  if (!isStock) { renderFin(null); renderWire($('disc'), []); return; }
  api(`financials?code=${code}`).then((f) => code === state.code && renderFin(f)).catch(() => renderFin(null));
  api(`disclosures?code=${code}`).then((d) => code === state.code && renderWire($('disc'), d, '공시가 없습니다')).catch(() => renderWire($('disc'), [], '공시를 불러오지 못했습니다'));
}

async function loadFilings() {
  try {
    const f = await api('filings');
    if (!f.enabled) { $('filings').innerHTML = `<div class="empty">DART 인증키를 입력하면 시장 전체 공시 속보가 표시됩니다. ${keysLink}</div>`; return; }
    renderWire($('filings'), f.list, '최근 공시가 없습니다');
    notifyNew('filings', f.list);
  } catch (e) { $('filings').innerHTML = `<div class="empty">공시를 불러오지 못했습니다 (${esc(e.message)}). ${keysLink}</div>`; }
}

// ── 속보 알림: 새로 들어온 뉴스·공시를 알림창으로 띄운다.
//    처음 받은 목록은 기준으로만 삼고, 그 뒤에 새로 나타난 항목만 알린다.
const WIRE_POLL_MS = 30000;
const KIND_LABEL = { news: '속보', filings: 'DART 공시', system: '알림' };
const seen = { news: null, filings: null };
let alertsOn = load('alerts') !== 'off';

function toast(kind, n) {
  const box = $('toasts');
  const el = document.createElement(n.url ? 'a' : 'div');
  el.className = 'toast ' + kind;
  if (n.url) { el.href = n.url; el.target = '_blank'; el.rel = 'noopener'; }
  const d = String(n.dt || '');
  const when = d.length >= 12 ? `${d.slice(8, 10)}:${d.slice(10, 12)}` : '';
  el.innerHTML = `<span class="meta"><span>[${esc(KIND_LABEL[kind])}${n.office ? ' / ' + esc(n.office) : ''}]</span><span>${when}</span></span>` +
    `<p>${esc(n.title)}</p><button type="button" class="x" aria-label="알림 닫기">✕</button>`;
  el.querySelector('.x').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); el.remove(); });
  box.prepend(el);
  while (box.children.length > 4) box.lastElementChild.remove();
  setTimeout(() => el.remove(), 15000);

  // 창이 가려져 있으면 Windows 알림으로도 띄운다(권한을 허용한 경우).
  if (kind !== 'system' && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const os = new Notification(`${KIND_LABEL[kind]}${n.office ? ' · ' + n.office : ''}`, { body: n.title, tag: n.url });
      os.onclick = () => { window.focus(); if (n.url) window.open(n.url, '_blank', 'noopener'); os.close(); };
    } catch { /* OS 알림 실패는 무시 */ }
  }
}

function notifyNew(kind, list) {
  if (seen[kind] === null) { seen[kind] = new Set(list.map((n) => n.url)); return; }
  const fresh = list.filter((n) => !seen[kind].has(n.url));
  fresh.forEach((n) => seen[kind].add(n.url));
  if (alertsOn) fresh.slice(0, 3).reverse().forEach((n) => toast(kind, n));
}

async function pollWire() {
  const [news] = await Promise.allSettled([api('news'), loadFilings()]);
  if (news.status === 'fulfilled') { renderWire($('market-news'), news.value); notifyNew('news', news.value); }
}

function renderAlertBtn() {
  $('alert-state').textContent = `속보 알림 ${alertsOn ? 'ON' : 'OFF'}`;
  $('alert-btn').classList.toggle('on', alertsOn);
  $('alert-btn').setAttribute('aria-pressed', String(alertsOn));
  $('alert-icon').textContent = alertsOn ? 'notifications_active' : 'notifications_off';
}
$('alert-btn').addEventListener('click', async () => {
  alertsOn = !alertsOn;
  save('alerts', alertsOn ? 'on' : 'off');
  renderAlertBtn();
  if (!alertsOn) { $('toasts').innerHTML = ''; return; }
  let extra = '창이 가려져 있을 때는 Windows 알림으로도 띄웁니다.';
  if (!('Notification' in window)) extra = '이 환경은 Windows 알림을 지원하지 않아 프로그램 안에서만 표시합니다.';
  else if (Notification.permission === 'default') {
    const r = await Notification.requestPermission().catch(() => 'denied');
    if (r !== 'granted') extra = 'Windows 알림 권한이 없어 프로그램 안에서만 표시합니다.';
  } else if (Notification.permission === 'denied') extra = 'Windows 알림이 차단되어 있어 프로그램 안에서만 표시합니다.';
  toast('system', { title: `속보 알림을 켰습니다. 새 뉴스·공시가 들어오면 여기에 표시됩니다. ${extra}` });
});

function bindToggle(tabsId, map) {
  $(tabsId).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    $(tabsId).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    Object.entries(map).forEach(([v, id]) => { $(id).hidden = v !== b.dataset.v; });
  });
}

// ── 거시경제
const MACRO_GROUPS = [['exchange', '환율 (원화)'], ['exchangeWorld', '주요 통화'], ['bond', '국채 금리 (%)'], ['domesticInterest', '국내 금리 (%)'],
  ['standardInterest', '기준금리 (%)'], ['energy', '에너지'], ['metals', '금속'], ['transport', '해운 운임']];
const NO_HISTORY = ['standardInterest'];
let macroSel = { category: 'exchange', code: 'FX_USDKRW' };
try { macroSel = JSON.parse(load('macro')) || macroSel; } catch { /* 기본값 사용 */ }
let macroData = null, macroBars = [], macroLoaded = '';
const macroChart = createChart($('macro-chart'), { onHover: (b) => renderMacroReadout(b) });

function renderMacroReadout(bar) {
  const b = bar || macroBars[macroBars.length - 1];
  const first = macroBars[0];
  if (!b) { $('macro-readout').textContent = ''; return; }
  const d = first && first.c ? (b.c - first.c) / first.c * 100 : null;
  $('macro-readout').textContent = `${b.label}  ${fmt(b.c, macroChart.dp)}` + (d == null ? '' : `  기간 대비 ${pct(d)}`);
}

function renderMacro(m) {
  macroData = m;
  const row = (x) => {
    const clickable = !NO_HISTORY.includes(x.category);
    const on = clickable && x.category === macroSel.category && x.code === macroSel.code;
    const body = `<span class="n">${esc(x.name)}${x.unit || x.month ? `<small>${esc([x.unit, x.month].filter(Boolean).join(' · '))}</small>` : ''}</span>` +
      `<span class="v ${cls(x.chg)}">${esc(x.priceText)}</span>` +
      `<span class="c ${cls(x.chg)}">${arrow(x.chg)} ${signed(x.chg, x.dp)}${x.pct == null ? '' : ` (${pct(x.pct)})`}</span>`;
    return clickable
      ? `<button type="button" class="mrow ${on ? 'on' : ''}" data-cat="${esc(x.category)}" data-code="${esc(x.code)}">${body}</button>`
      : `<div class="mrow">${body}</div>`;
  };
  $('macro-groups').innerHTML = MACRO_GROUPS.filter(([g]) => (m.groups[g] || []).length).map(([g, title]) =>
    `<section class="win"><div class="win-h"><span class="win-t">${esc(title)}</span><span class="win-tag">${esc(g.toUpperCase())}</span></div>` +
    `<div class="mrows">${m.groups[g].map(row).join('')}</div></section>`).join('');
  $('macro-world').innerHTML = m.world.map((x) => `<button type="button" class="mrow" data-code="${esc(x.code)}"><span class="n">${esc(x.name)}<small>${esc(x.nation)}</small></span>` +
    `<span class="v ${cls(x.chg)}">${fmt(x.price, 2)}</span><span class="c ${cls(x.chg)}">${arrow(x.chg)} ${signed(x.chg, 2)} (${pct(x.pct)})</span></button>`).join('') ||
    '<div class="empty">해외 지수를 불러오지 못했습니다</div>';
}

async function loadMacroChart() {
  const { category, code } = macroSel;
  const item = macroData && (macroData.groups[category] || []).find((x) => x.code === code);
  $('macro-title').textContent = item ? `${item.name} 추이` : '추이';
  const key = category + '|' + code;
  if (macroLoaded === key) return;
  try {
    const rows = await api(`macrochart?category=${encodeURIComponent(category)}&code=${encodeURIComponent(code)}`);
    if (macroSel.category !== category || macroSel.code !== code) return;
    macroBars = rows.map(([d, c]) => { const s = String(d); return { label: dateLabel(d), o: c, h: c, l: c, c, v: 0, tickKey: s.slice(0, 6), tickLabel: `${s.slice(2, 4)}.${s.slice(4, 6)}` }; });
    macroLoaded = key;
  } catch (e) { macroBars = []; showMsg(`추이를 불러오지 못했습니다 (${e.message})`); }
  macroChart.dp = item ? item.dp : 2;
  macroChart.set({ mode: 'line', bars: macroBars, dp: macroChart.dp });
  renderMacroReadout(null);
}

async function loadMacro() {
  try { renderMacro(await api('macro')); }
  catch (e) { $('macro-groups').innerHTML = `<div class="empty">거시 지표를 불러오지 못했습니다 (${esc(e.message)})</div>`; return; }
  const exists = (macroData.groups[macroSel.category] || []).some((x) => x.code === macroSel.code);
  if (!exists) macroSel = { category: 'exchange', code: 'FX_USDKRW' };
  await loadMacroChart();
}

$('macro-world').addEventListener('click', (e) => { const b = e.target.closest('[data-code]'); if (b) selectCode(b.dataset.code, true); });
$('macro-groups').addEventListener('click', (e) => {
  const b = e.target.closest('button.mrow');
  if (!b) return;
  macroSel = { category: b.dataset.cat, code: b.dataset.code };
  save('macro', JSON.stringify(macroSel));
  document.querySelectorAll('#macro-groups .mrow').forEach((x) => x.classList.toggle('on', x === b));
  loadMacroChart();
});

// ── 포트폴리오 (이 PC의 브라우저 저장소에만 보관, 주문 기능 없음)
let holdings = [];
try { holdings = JSON.parse(load('port')) || []; } catch { holdings = []; }
const saveHoldings = () => save('port', JSON.stringify(holdings));
const won = (v) => (v == null ? '−' : fmt(Math.round(v)));

function renderPort(prices) {
  const fx = state.usdkrw || 0;
  const rows = holdings.map((h) => {
    const p = prices[h.code];
    const cur = (p && p.currency) || h.currency || (isUS(h.code) ? 'USD' : 'KRW');
    const k = cur === 'USD' ? fx : 1; // 원화 환산 배수
    const price = p ? p.price : null;
    return { ...h, cur, symbol: (p && p.symbol) || h.symbol || h.code, name: (p && p.name) || h.name, price, pct: p ? p.pct : null,
      value: price == null ? null : price * h.qty, cost0: h.cost * h.qty,
      valueKrw: (price == null ? h.cost : price) * h.qty * k, costKrw: h.cost * h.qty * k, dayKrw: p ? p.chg * h.qty * k : 0 };
  });
  const hasUsd = rows.some((r) => r.cur === 'USD');
  const totalCost = rows.reduce((a, r) => a + r.costKrw, 0);
  const totalValue = rows.reduce((a, r) => a + r.valueKrw, 0);
  const pnl = totalValue - totalCost, day = rows.reduce((a, r) => a + r.dayKrw, 0);
  const card = (label, value, sub, c = '') => `<div class="card"><span class="sum-l">${label}</span><span class="card-px ${c}">${value}</span><span class="sum-s ${c}">${sub}</span></div>`;
  $('port-sum').innerHTML = card('총 매입금액', won(totalCost) + '원', `${rows.length}종목`) +
    card('총 평가금액', won(totalValue) + '원', hasUsd ? (fx ? `달러 환산 ${fmt(fx, 2)}원` : '달러 보유분 제외 (환율 조회 실패)') : '현재가 기준') +
    card('평가손익', signed(Math.round(pnl)) + '원', totalCost ? pct(pnl / totalCost * 100) : '−', cls(pnl)) +
    card('당일 손익', signed(Math.round(day)) + '원', totalValue - day ? pct(day / (totalValue - day) * 100) : '−', cls(day));

  $('port').tBodies[0].innerHTML = rows.length ? rows.map((r) => {
    const g = r.value == null ? null : r.value - r.cost0;
    const gain = g == null ? '−' : (g > 0 ? '+' : g < 0 ? '-' : '') + money(Math.abs(g), r.cur);
    return `<tr><td>${esc(r.symbol)}</td><td class="nm" data-code="${esc(r.code)}">${esc(r.name)}${r.cur === 'USD' ? '<span class="badge">US</span>' : ''}</td><td>${fmt(r.qty)}</td><td>${money(r.cost, r.cur)}</td>` +
      `<td class="${cls(r.pct)} b">${money(r.price, r.cur)}</td><td class="${cls(r.pct)}">${pct(r.pct)}</td><td>${money(r.value, r.cur)}</td>` +
      `<td class="${cls(g)} b">${gain}</td><td class="${cls(g)} b">${g == null || !r.cost0 ? '−' : pct(g / r.cost0 * 100)}</td>` +
      `<td>${totalValue ? (r.valueKrw / totalValue * 100).toFixed(1) + '%' : '−'}</td>` +
      `<td><button type="button" class="del" data-del="${esc(r.code)}" aria-label="${esc(r.name)} 삭제">✕</button></td></tr>`;
  }).join('') : '<tr><td colspan="11" style="text-align:left">보유 종목이 없습니다. 오른쪽에서 국내·미국 종목을 추가하면 평가손익을 현재 시세로 계산합니다.</td></tr>';

  $('port-alloc').innerHTML = rows.length ? [...rows].sort((a, b) => b.valueKrw - a.valueKrw).map((r) => {
    const w = totalValue ? r.valueKrw / totalValue * 100 : 0;
    return `<div class="mrow alloc"><span class="n">${esc(r.name)}</span><span class="track"><i style="width:${w}%"></i></span><span class="v">${w.toFixed(1)}%</span></div>`;
  }).join('') : '<div class="empty">종목을 추가하면 비중이 표시됩니다</div>';
}

let portMode = load('portMode') === 'toss' ? 'toss' : 'manual';

// 토스증권 계좌의 실제 보유 종목(국내·미국). 금액 합계는 원화, 종목별 금액은 해당 통화로 표시한다.
function renderTossPort(h) {
  const empty = (text, keepSummary) => {
    if (!keepSummary) $('port-sum').innerHTML = '';
    $('port').tBodies[0].innerHTML = `<tr><td colspan="11" style="text-align:left">${text}</td></tr>`;
    $('port-alloc').innerHTML = '<div class="empty">표시할 비중이 없습니다</div>';
  };
  if (!h.enabled) return empty(`토스증권 키를 입력하면 계좌의 보유 종목과 평가손익을 불러옵니다. ${keysLink}`);
  if (!h.summary) return empty('토스증권 종합매매 계좌를 찾지 못했습니다.');
  const s = h.summary;
  const fx = h.fx || 0;
  const rate = (v) => (v == null ? '−' : pct(v * 100));
  const card = (label, value, sub, c = '') => `<div class="card"><span class="sum-l">${label}</span><span class="card-px ${c}">${value}</span><span class="sum-s ${c}">${sub}</span></div>`;
  $('port-sum').innerHTML = card('총 매입금액', won(s.purchase) + '원', `${h.items.length}종목 · 계좌 ${esc(h.account || '')}`) +
    card('총 평가금액', won(s.value) + '원', h.items.some((x) => x.currency === 'USD') ? (fx ? `달러 환산 ${fmt(fx, 2)}원` : '달러 보유분 제외 (환율 조회 실패)') : '토스증권 기준') +
    card('평가손익', signed(Math.round(s.pnl ?? 0)) + '원', rate(s.pnlRate), cls(s.pnl)) +
    card('당일 손익', signed(Math.round(s.day ?? 0)) + '원', rate(s.dayRate), cls(s.day));
  if (!h.items.length) return empty('보유 종목이 없습니다.', true);

  // 달러 종목은 서버가 준 환율로 원화 환산해 비중을 구한다.
  const inKrw = (x) => (x.currency === 'USD' ? (x.value || 0) * fx : (x.value || 0));
  const money = (v, cur) => (v == null ? '−' : cur === 'USD' ? '$' + fmt(v, 2) : won(v));
  const weight = (x) => (s.value ? inKrw(x) / s.value * 100 : 0);

  $('port').tBodies[0].innerHTML = h.items.map((x) =>
    `<tr><td>${esc(x.code)}</td><td class="nm" ${x.country === 'KR' ? `data-code="${esc(x.code)}"` : ''}>${esc(x.name)}${x.country !== 'KR' ? `<span class="badge">${esc(x.country)}</span>` : ''}</td>` +
    `<td>${fmt(x.qty)}</td><td>${money(x.cost, x.currency)}</td><td class="${cls(x.day)} b">${money(x.price, x.currency)}</td><td class="${cls(x.day)}">${rate(x.dayRate)}</td>` +
    `<td>${money(x.value, x.currency)}</td><td class="${cls(x.pnl)} b">${x.pnl == null ? '−' : (x.pnl > 0 ? '+' : x.pnl < 0 ? '-' : '') + money(Math.abs(x.pnl), x.currency)}</td>` +
    `<td class="${cls(x.pnl)} b">${rate(x.pnlRate)}</td><td>${weight(x).toFixed(1)}%</td><td></td></tr>`).join('');
  $('port-alloc').innerHTML = [...h.items].sort((a, b) => inKrw(b) - inKrw(a)).map((x) =>
    `<div class="mrow alloc"><span class="n">${esc(x.name)}</span><span class="track"><i style="width:${weight(x)}%"></i></span><span class="v">${weight(x).toFixed(1)}%</span></div>`).join('');
}

function renderPortMode() {
  document.querySelectorAll('#port-mode button').forEach((b) => b.classList.toggle('on', b.dataset.v === portMode));
  $('port-add').hidden = portMode === 'toss';
  $('port-note').textContent = portMode === 'toss' ? '토스증권 계좌 조회 · 주문 기능 없음' : '이 PC에만 저장 · 주문 기능 없음';
}
$('port-mode').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  portMode = b.dataset.v; save('portMode', portMode);
  loadPort();
});

async function loadPort() {
  renderPortMode();
  if (portMode === 'toss') {
    try { renderTossPort(await api('holdings')); }
    catch (e) { renderTossPort({ enabled: true, summary: null }); $('port').tBodies[0].innerHTML = `<tr><td colspan="11" style="text-align:left">토스증권 계좌를 불러오지 못했습니다 (${esc(e.message)}). ${keysLink}</td></tr>`; }
    return;
  }
  let prices = {};
  if (holdings.some((h) => isUS(h.code)) && !state.usdkrw) {
    try { const o = await api('overview'); const u = o.fx.find((f) => f.code === 'FX_USDKRW'); if (u) state.usdkrw = u.price; } catch { /* 환율 없이 표시 */ }
  }
  if (holdings.length) {
    try { prices = Object.fromEntries((await api('quotes?codes=' + holdings.map((h) => h.code).join(','))).map((q) => [q.code, q])); }
    catch (e) { showMsg(`시세를 불러오지 못했습니다 (${e.message})`); }
  }
  renderPort(prices);
}

$('port-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('pf-msg');
  const text = $('pf-code').value.trim(), qty = Number($('pf-qty').value), costIn = $('pf-cost').value.trim();
  if (!text || !(qty > 0)) { msg.textContent = '종목과 수량을 입력하세요.'; return; }
  try {
    let code = isUS(text) ? text : text.toUpperCase();
    if (!isUS(code) && !(/^[0-9A-Z]{6}$/.test(code) && /\d/.test(code))) {
      const list = await api('search?q=' + encodeURIComponent(text));
      if (!list.length) { msg.textContent = `'${text}' 종목을 찾지 못했습니다.`; return; }
      code = list[0].code;
    }
    const [q] = await api('quotes?codes=' + code);
    if (!q || q.price == null) { msg.textContent = `'${code}' 시세를 찾지 못했습니다.`; return; }
    const cost = costIn ? Number(costIn) : q.price;
    if (!(cost >= 0)) { msg.textContent = '평단가를 확인하세요.'; return; }
    const cur = holdings.find((h) => h.code === code);
    if (cur) { cur.cost = (cur.cost * cur.qty + cost * qty) / (cur.qty + qty); cur.qty += qty; }
    else holdings.push({ code, symbol: q.symbol, currency: q.currency, name: q.name, qty, cost });
    saveHoldings();
    msg.textContent = `${q.name} ${fmt(qty)}주를 추가했습니다.`;
    e.target.reset();
    loadPort();
  } catch (err) { msg.textContent = `추가하지 못했습니다 (${err.message})`; }
});
$('port').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) { holdings = holdings.filter((h) => h.code !== del.dataset.del); saveHoldings(); loadPort(); return; }
  const nm = e.target.closest('td.nm');
  if (nm && nm.dataset.code) selectCode(nm.dataset.code, true);
});

// ── API 키 설정
function renderKeyState(s) {
  $('keys-state').textContent = `API 키  DART ${s.dart.set ? '●' : '○'} · 토스 ${s.toss.set ? '●' : '○'} · KIS ${s.kis.set ? '●' : '○'}  [F9]`;
  const badge = (el, set, text) => { el.textContent = set ? text : '미입력'; el.className = 'badge ' + (set ? 'ok' : ''); };
  badge($('ks-dart'), s.dart.set, `저장됨 ${s.dart.masked}`);
  badge($('ks-kis'), s.kis.set, `저장됨 ${s.kis.keyMasked}`);
  badge($('ks-toss'), s.toss.set, `저장됨 ${s.toss.idMasked}`);
  $('k-kis-paper').checked = s.kis.paper;
  $('keys-file').textContent = `저장 위치: ${s.file}`;
}
async function loadKeyState() { try { renderKeyState(await api('settings')); } catch { /* 설정 조회 실패는 무시 */ } }
function openKeys() { $('keys-modal').hidden = false; $('keys-msg').textContent = ''; loadKeyState(); $('k-dart').focus(); }
function closeKeys() { $('keys-modal').hidden = true; clearArmed = false; $('keys-clear').textContent = '키 모두 삭제'; }
function afterKeyChange(r) {
  renderKeyState(r);
  ['k-dart', 'k-kis-key', 'k-kis-secret', 'k-toss-id', 'k-toss-secret'].forEach((id) => { $(id).value = ''; });
  loadFilings(); loadStockExtras();
  if (currentView() === 'port') loadPort();
}
$('keys-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { KIS_ENV: $('k-kis-paper').checked ? 'paper' : '' };
  const put = (id, name) => { const v = $(id).value.trim(); if (v) body[name] = v; };
  put('k-dart', 'DART_API_KEY'); put('k-kis-key', 'KIS_APP_KEY'); put('k-kis-secret', 'KIS_APP_SECRET');
  put('k-toss-id', 'TOSS_CLIENT_ID'); put('k-toss-secret', 'TOSS_CLIENT_SECRET');
  $('keys-msg').textContent = '저장하고 연결을 확인하는 중…';
  try {
    const r = await api('settings', body);
    afterKeyChange(r);
    const line = (name, t, set) => (t ? `${name}: ${t.ok ? '연결 확인됨' : '실패 — ' + t.message}` : `${name}: ${set ? '확인 안 함' : '미입력'}`);
    $('keys-msg').textContent = '저장했습니다.\n' + line('DART', r.test.dart, r.dart.set) + '\n' + line('토스증권', r.test.toss, r.toss.set) + '\n' + line('KIS', r.test.kis, r.kis.set);
  } catch (err) { $('keys-msg').textContent = `저장하지 못했습니다 (${err.message})`; }
});
let clearArmed = false;
$('keys-clear').addEventListener('click', async () => {
  if (!clearArmed) { clearArmed = true; $('keys-clear').textContent = '한 번 더 누르면 삭제'; return; }
  clearArmed = false; $('keys-clear').textContent = '키 모두 삭제';
  try {
    afterKeyChange(await api('settings', { DART_API_KEY: '', TOSS_CLIENT_ID: '', TOSS_CLIENT_SECRET: '', KIS_APP_KEY: '', KIS_APP_SECRET: '', KIS_ENV: '' }));
    $('keys-msg').textContent = '저장된 키를 모두 삭제했습니다.';
  } catch (err) { $('keys-msg').textContent = `삭제하지 못했습니다 (${err.message})`; }
});
$('keys-btn').addEventListener('click', openKeys);
$('keys-close').addEventListener('click', closeKeys);
$('keys-modal').addEventListener('mousedown', (e) => { if (e.target === $('keys-modal')) closeKeys(); });
document.addEventListener('click', (e) => { if (e.target.closest('[data-open-keys]')) openKeys(); });

// ── 명령 입력
const HELP = 'CMD: 종목명 또는 6자리 코드 <GO> · KOSPI / KOSDAQ / KPI200 · 1D 1M 3M 1Y 3Y(차트 기간) · MKT · MACRO · PORT · KEYS · ↑↓ 후보 선택 · / 입력창 · F1 도움말 F2 마켓 F3 종목 F4 거시 F8 포트폴리오 F9 API 키';
let suggestions = [], sel = 0, searchSeq = 0, searchTimer = null;

function renderSuggest() {
  $('suggest').hidden = !suggestions.length;
  $('suggest').innerHTML = suggestions.map((s, i) =>
    `<li data-code="${esc(s.code)}" class="${i === sel ? 'sel' : ''}"><span>${esc(s.name)}</span><span>${esc(s.symbol || s.code)} · ${esc(s.market || '')}</span></li>`).join('');
}
function closeSuggest() { suggestions = []; renderSuggest(); }

function setRange(r, open = false) {
  state.range = r; save('range', r);
  document.querySelectorAll('#range button').forEach((b) => b.classList.toggle('on', b.dataset.v === r));
  if (open) go('stock');
  loadChart();
}

async function runCommand(raw) {
  const text = raw.trim();
  if (!text) return;
  const upper = text.toUpperCase().replace(/\s+/g, '');
  $('cmd').value = '';
  closeSuggest();
  if (upper === 'HELP' || upper === '?' || text === '도움말') return showMsg(HELP);
  if (upper === 'MKT' || upper === '/MKT') return go('market');
  if (upper === 'MACRO') return go('macro');
  if (upper === 'PORT') return go('port');
  if (upper === 'KEYS' || upper === 'KEY') return openKeys();
  if (upper === 'HOGA') return go('stock');
  if (upper in RANGES || upper === '1D') return setRange(upper, true);
  if (INDEX_ALIAS[upper]) return selectCode(INDEX_ALIAS[upper], true);
  if (US_ALIAS[upper]) return selectCode(US_ALIAS[upper], true);
  if (isUS(text) && !/\s/.test(text)) return selectCode(text, true);
  if (/^[0-9A-Z]{6}$/.test(upper) && /\d/.test(upper)) return selectCode(upper, true);
  try {
    const list = await api('search?q=' + encodeURIComponent(text));
    if (list.length) return selectCode(list[0].code, true);
    showMsg(`'${text}' 검색 결과가 없습니다`);
  } catch (e) { showMsg(`검색 실패 (${e.message})`); }
}

function submitCmd() {
  clearTimeout(searchTimer); searchSeq++;
  if (suggestions.length) { const s = suggestions[sel]; $('cmd').value = ''; closeSuggest(); selectCode(s.code, true); }
  else runCommand($('cmd').value);
}

$('cmd').addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = $('cmd').value.trim();
  if (!q) return closeSuggest();
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    try {
      const list = await api('search?q=' + encodeURIComponent(q));
      if (seq !== searchSeq || $('cmd').value.trim() !== q) return;
      suggestions = list; sel = 0; renderSuggest();
    } catch { /* 자동완성 실패는 조용히 넘긴다 */ }
  }, 150);
});
$('cmd').addEventListener('keydown', (e) => {
  if (e.isComposing) return; // 한글 조합 중 Enter 중복 방지
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!suggestions.length) return;
    e.preventDefault();
    sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length;
    renderSuggest();
  } else if (e.key === 'Enter') { e.preventDefault(); submitCmd(); }
  else if (e.key === 'Escape') { closeSuggest(); $('cmd').blur(); }
});
$('go').addEventListener('click', submitCmd);
$('suggest').addEventListener('mousedown', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  e.preventDefault();
  $('cmd').value = ''; closeSuggest(); selectCode(li.dataset.code, true);
});
$('cmd').addEventListener('blur', () => setTimeout(closeSuggest, 100));

const FKEYS = { F1: () => showMsg($('msg').hidden ? HELP : ''), F2: () => go('market'), F3: () => go('stock'), F4: () => go('macro'), F8: () => go('port'), F9: () => ($('keys-modal').hidden ? openKeys() : closeKeys()) };
document.addEventListener('keydown', (e) => {
  if (FKEYS[e.key]) { e.preventDefault(); FKEYS[e.key](); }
  else if (e.key === 'Escape' && !$('keys-modal').hidden) closeKeys();
  else if (e.key === '/' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) { e.preventDefault(); $('cmd').focus(); }
});
document.querySelector('.fkeys').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) FKEYS[b.dataset.key](); });

// ── 클릭 핸들러
$('cards').addEventListener('click', (e) => { const b = e.target.closest('[data-code]'); if (b) selectCode(b.dataset.code, true); });
$('rank').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-code]'); if (tr) selectCode(tr.dataset.code); });
$('rank').addEventListener('dblclick', (e) => { if (e.target.closest('tr[data-code]')) go('stock'); });
$('open-chart').addEventListener('click', () => go('stock'));
$('open-stock').addEventListener('click', () => go('stock'));
$('add-port').addEventListener('click', () => {
  if (state.quote && state.quote.isIndex) return showMsg('지수는 포트폴리오에 담을 수 없습니다');
  go('port'); $('pf-code').value = state.code; $('pf-qty').focus();
});
bindToggle('wire-tabs', { news: 'market-news', filings: 'filings' });
bindToggle('news-tabs', { news: 'news', disc: 'disc' });
$('range').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setRange(b.dataset.v); });
function bindTabs(id, key) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state[key] = b.dataset.v;
    $(id).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    loadRank();
  });
}
bindTabs('rank-type', 'rankType');
bindTabs('rank-market', 'rankMarket');
function syncRankTabs(market = state.rankMarket) {
  const us = US_MARKETS.includes(market);
  const vol = document.querySelector('#rank-type [data-v="quantTop"]');
  vol.hidden = us;
  if (us && state.rankType === 'quantTop') {
    state.rankType = 'marketValue';
    document.querySelectorAll('#rank-type button').forEach((x) => x.classList.toggle('on', x.dataset.v === 'marketValue'));
  }
  document.querySelector('#rank thead th:nth-child(3)').textContent = us ? '현재가(USD)' : '현재가(KRW)';
}
// 순위를 받기 전에(캡처 단계) 누른 시장에 맞춰 탭을 정리한다
$('rank-market').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) syncRankTabs(b.dataset.v); }, true);
window.addEventListener('hashchange', applyView);

// ── 프로그램 잠금 (비밀번호)
let auth = { hasPassword: false, locked: false };
function showLock() {
  if (!$('lock').hidden) return;
  $('lock').hidden = false; $('lock-msg').textContent = ''; $('lock-pw').value = '';
  setTimeout(() => $('lock-pw').focus(), 0);
}
$('lock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('lock-msg').textContent = '확인 중…';
  try {
    const res = await fetch('api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('lock-pw').value }) });
    const r = await res.json().catch(() => ({}));
    if (res.ok) return location.reload();
    $('lock-msg').textContent = r.error || '비밀번호가 올바르지 않습니다.';
    $('lock-pw').select();
  } catch { $('lock-msg').textContent = '프로그램에 연결하지 못했습니다.'; }
});

function renderPwState() {
  $('ks-pw').textContent = auth.hasPassword ? '사용 중' : '사용 안 함';
  $('ks-pw').className = 'badge ' + (auth.hasPassword ? 'ok' : '');
  $('pw-cur-row').hidden = !auth.hasPassword;
  $('pw-remove').hidden = !auth.hasPassword; $('pw-lock').hidden = !auth.hasPassword;
}
async function changePassword(next) {
  const msg = $('pw-msg');
  try {
    const r = await api('auth/password', { current: $('pw-cur').value, next });
    auth = { hasPassword: r.hasPassword, locked: false };
    ['pw-cur', 'pw-new', 'pw-new2'].forEach((id) => { $(id).value = ''; });
    renderPwState();
    msg.textContent = r.hasPassword ? '비밀번호를 설정했습니다. 다음 실행부터 비밀번호를 묻습니다.' : '비밀번호를 해제했습니다.';
  } catch (err) { msg.textContent = `변경하지 못했습니다 (${err.message})`; }
}
$('pw-save').addEventListener('click', () => {
  const a = $('pw-new').value, b = $('pw-new2').value;
  if (a.length < 4) { $('pw-msg').textContent = '새 비밀번호는 4자 이상이어야 합니다.'; return; }
  if (a !== b) { $('pw-msg').textContent = '새 비밀번호가 서로 다릅니다.'; return; }
  changePassword(a);
});
$('pw-remove').addEventListener('click', () => changePassword(''));
$('pw-lock').addEventListener('click', async () => { try { await api('auth/lock', {}); } catch { /* 무시 */ } location.reload(); });

// 프로그램 창이 열려 있는 동안 연결을 유지한다(창을 모두 닫으면 프로그램이 스스로 종료된다).
try { new EventSource('api/alive'); } catch { /* 미지원 환경 */ }

// ── 시작
function tick() { $('clock').textContent = `SEOUL ${kstTime(Date.now())} KST`; }
tick(); setInterval(tick, 1000);
function boot() {
  document.querySelectorAll('#range button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.range));
  syncRankTabs();
  applyView();
  selectCode(state.code).then((ok) => { if (!ok) selectCode('005930'); });
  refresh();
  loadKeyState();
  renderAlertBtn();
  renderPwState();
  // 어느 화면에 있든 속보는 계속 확인한다
  setInterval(() => { if (currentView() !== 'market' || document.hidden) pollWire(); }, WIRE_POLL_MS);
  if (currentView() !== 'market') pollWire();
  setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_MS);
  // 종목 화면에서는 호가·체결을 더 자주 갱신한다
  setInterval(() => { if (!document.hidden && currentView() === 'stock' && state.quote && state.quote.status === 'OPEN') { loadBook(); loadTicks(); } }, 4000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}
fetch('api/auth').then((r) => r.json()).then((a) => { auth = a; if (a.locked) showLock(); else boot(); }).catch(boot);
