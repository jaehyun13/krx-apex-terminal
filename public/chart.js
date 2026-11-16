// 차트: TradingView Lightweight Charts(lwc.js) 위에 얇게 씌운 래퍼.
// 마우스 휠로 확대·축소, 끌어서 이동, 십자선으로 값 확인이 된다. 색은 CSS 변수에서 읽는다.
// 사용: const c = createChart(el, { onHover(bar|null) });
//       c.set({ mode: 'candle'|'line', bars, prevClose, dp, visible })
//   bars: [{ time, label, o, h, l, c, v, ma5?, ma20?, ma60? }]
//     time — 일봉은 'YYYY-MM-DD', 분봉은 UTC 초(현지 시각을 그대로 UTC로 넣어 표시 시각을 맞춘다)
//   visible — 처음에 보여줄 최근 봉 개수(없으면 전체). 나머지는 왼쪽으로 끌어서 볼 수 있다.
function createChart(el, opts = {}) {
  const css = (name) => getComputedStyle(el).getPropertyValue(name).trim() || '#888';
  const LWC = window.LightweightCharts;
  if (!LWC) {
    el.textContent = '차트 엔진을 불러오지 못했습니다';
    return { set() {}, redraw() {}, fit() {} };
  }

  const chart = LWC.createChart(el, {
    autoSize: true,
    layout: { background: { color: 'transparent' }, textColor: css('--muted'), fontFamily: css('--mono'), fontSize: 11 },
    grid: { vertLines: { color: css('--line') }, horzLines: { color: css('--line') } },
    rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.06, bottom: 0.26 } },
    timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 3 },
    crosshair: { mode: LWC.CrosshairMode.Normal },
    localization: { locale: 'ko-KR', dateFormat: 'yyyy.MM.dd' },
  });

  let series = [];
  let byTime = new Map();
  let count = 0, visible = 0;

  function clear() {
    for (const s of series) chart.removeSeries(s);
    series = [];
  }

  function set(next) {
    const { mode, bars, prevClose = null } = next;
    clear();
    byTime = new Map(bars.map((b) => [b.time, b]));
    count = bars.length; visible = next.visible || 0;
    if (!bars.length) return;

    const up = css('--up'), down = css('--down'), accent = css('--accent');
    const maxPrice = Math.max(...bars.map((b) => b.h));
    const precision = next.dp != null ? next.dp : (maxPrice < 1000 ? 2 : 0);
    const priceFormat = { type: 'price', precision, minMove: 1 / 10 ** precision };
    // 가격축·십자선 값에 천 단위 구분 기호를 넣는다
    chart.applyOptions({ localization: { priceFormatter: (v) => v.toLocaleString('ko-KR', { minimumFractionDigits: precision, maximumFractionDigits: precision }) } });
    const hasVol = bars.some((b) => b.v > 0);
    // 거래량이 없는 시계열(환율·금리)은 가격 영역을 끝까지 쓴다
    chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.06, bottom: hasVol ? 0.26 : 0.06 } });

    if (mode === 'candle') {
      const candle = chart.addCandlestickSeries({
        upColor: up, downColor: down, borderVisible: false, wickUpColor: up, wickDownColor: down, priceFormat,
      });
      candle.setData(bars.map((b) => ({ time: b.time, open: b.o, high: b.h, low: b.l, close: b.c })));
      series.push(candle);
      for (const [key, token] of [['ma5', '--ma5'], ['ma20', '--ma20'], ['ma60', '--ma60']]) {
        const data = bars.filter((b) => b[key] != null).map((b) => ({ time: b.time, value: b[key] }));
        if (!data.length) continue;
        const line = chart.addLineSeries({ color: css(token), lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat });
        line.setData(data);
        series.push(line);
      }
    } else {
      const last = bars[bars.length - 1].c;
      const color = prevClose == null || last === prevClose ? accent : last > prevClose ? up : down;
      const area = chart.addAreaSeries({ lineColor: color, topColor: color + '33', bottomColor: color + '00', lineWidth: 2, priceFormat });
      area.setData(bars.map((b) => ({ time: b.time, value: b.c })));
      if (prevClose != null) area.createPriceLine({ price: prevClose, color: css('--muted'), lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title: '전일' });
      series.push(area);
    }

    if (hasVol) {
      const vol = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false });
      chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      vol.setData(bars.map((b, i) => {
        const prev = i ? bars[i - 1].c : (prevClose ?? b.o);
        const rising = mode === 'candle' ? b.c >= b.o : b.c >= prev;
        return { time: b.time, value: b.v || 0, color: (rising ? up : down) + '99' };
      }));
      series.push(vol);
    }
    fit();
  }

  // 처음 보여줄 범위: 최근 visible개(없으면 전체)
  function fit() {
    if (!count) return;
    if (visible && visible < count) chart.timeScale().setVisibleLogicalRange({ from: count - visible - 0.5, to: count + 2.5 });
    else chart.timeScale().fitContent();
  }

  chart.subscribeCrosshairMove((p) => {
    if (opts.onHover) opts.onHover(p && p.time != null && p.point ? byTime.get(p.time) || null : null);
  });

  return { set, fit, redraw() { /* autoSize가 크기 변화를 따라간다 */ } };
}
