// 캔버스 차트: 봉(일·주) 또는 선(분) + 이동평균선 + 거래량 + 십자선.
// 색은 CSS 변수(--up, --down, --ma5 …)에서 읽으므로 스타일시트만 바꾸면 따라온다.
// 사용: const c = createChart(canvas, { onHover(bar|null) }); c.set({ mode, bars, prevClose })
//   bars: [{ label, o, h, l, c, v, ma5?, ma20?, ma60? }]
function createChart(canvas, opts = {}) {
  const ctx = canvas.getContext('2d');
  let state = { mode: 'candle', bars: [], prevClose: null };
  let hover = -1;
  let geo = null;

  const css = (name) => getComputedStyle(canvas).getPropertyValue(name).trim() || '#888';
  const MAS = [['ma5', '--ma5'], ['ma20', '--ma20'], ['ma60', '--ma60']];

  function niceTicks(min, max, count) {
    const raw = (max - min) / count || 1;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
    const out = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(v);
    return out;
  }
  // state.dp(소수 자릿수)가 주어지면 그 자릿수로, 아니면 크기에 따라 정한다.
  const fmt = (v) => (state.dp != null
    ? v.toLocaleString('ko-KR', { minimumFractionDigits: state.dp, maximumFractionDigits: state.dp })
    : v.toLocaleString('ko-KR', { maximumFractionDigits: Math.abs(v) < 1000 ? 2 : 0 }));
  const fmtVol = (v) => (v >= 1e8 ? (v / 1e8).toFixed(1) + '억' : v >= 1e4 ? Math.round(v / 1e4).toLocaleString('ko-KR') + '만' : String(Math.round(v)));

  function draw() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const W = rect.width, H = rect.height;
    if (!W || !H) return;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const { bars, mode, prevClose } = state;
    const C = { up: css('--up'), down: css('--down'), line: css('--line'), muted: css('--muted'), fg: css('--fg'), accent: css('--accent') };
    ctx.font = `11px ${css('--mono')}`;
    if (!bars.length) {
      ctx.fillStyle = C.muted; ctx.textAlign = 'center';
      ctx.fillText('차트 데이터가 없습니다', W / 2, H / 2);
      geo = null; return;
    }

    const hasVol = bars.some((b) => b.v > 0); // 거래량이 없는 시계열(환율·금리)은 거래량 영역을 접는다
    const padR = 62, padT = 8, axisH = 18, gap = hasVol ? 14 : 0;
    const volH = hasVol ? Math.round(H * 0.2) : 0;
    const priceH = H - padT - axisH - gap - volH;
    const plotW = W - padR;
    const n = bars.length;
    const step = plotW / n;
    const xc = (i) => i * step + step / 2;

    // 가격축 (단일 축; 거래량은 아래 별도 영역)
    let lo = Infinity, hi = -Infinity;
    for (const b of bars) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
    if (mode === 'line' && prevClose != null) { lo = Math.min(lo, prevClose); hi = Math.max(hi, prevClose); }
    const pad = (hi - lo) * 0.06 || hi * 0.01 || 1;
    lo -= pad; hi += pad;
    const y = (v) => padT + (hi - v) / (hi - lo) * priceH;

    ctx.lineWidth = 1; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    for (const t of niceTicks(lo, hi, 5)) {
      const yy = Math.round(y(t)) + 0.5;
      ctx.strokeStyle = C.line; ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke();
      ctx.fillStyle = C.muted; ctx.fillText(fmt(t), plotW + 6, yy);
    }

    // x축 라벨: 달(또는 시)이 바뀌는 지점, 최소 간격 유지
    ctx.textBaseline = 'top'; ctx.textAlign = 'center';
    let lastX = -Infinity, prevKey = null;
    bars.forEach((b, i) => {
      const key = b.tickKey;
      if (key !== prevKey && i > 0 && xc(i) - lastX > 56 && xc(i) < plotW - 20) {
        ctx.fillStyle = C.muted; ctx.fillText(b.tickLabel, xc(i), H - axisH + 4);
        ctx.strokeStyle = C.line; ctx.beginPath(); ctx.moveTo(Math.round(xc(i)) + 0.5, padT); ctx.lineTo(Math.round(xc(i)) + 0.5, padT + priceH); ctx.stroke();
        lastX = xc(i);
      }
      prevKey = key;
    });

    // 거래량
    const volTop = padT + priceH + gap;
    const vmax = Math.max(...bars.map((b) => b.v || 0)) || 1;
    const bw = Math.max(1, Math.min(step * 0.7, 14));
    bars.forEach((b, i) => {
      const prev = i ? bars[i - 1].c : (prevClose ?? b.o);
      const upBar = mode === 'candle' ? b.c >= b.o : b.c >= prev;
      const h = (b.v || 0) / vmax * (volH - 2);
      ctx.globalAlpha = 0.6; ctx.fillStyle = upBar ? C.up : C.down;
      ctx.fillRect(xc(i) - bw / 2, volTop + volH - h, bw, h);
    });
    ctx.globalAlpha = 1;
    ctx.fillStyle = C.muted; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    if (hasVol) ctx.fillText(fmtVol(vmax), plotW + 6, volTop);

    if (mode === 'candle') {
      bars.forEach((b, i) => {
        const col = b.c > b.o ? C.up : b.c < b.o ? C.down : C.muted;
        const x = xc(i);
        ctx.strokeStyle = col; ctx.fillStyle = col;
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, y(b.h)); ctx.lineTo(Math.round(x) + 0.5, y(b.l)); ctx.stroke();
        const top = y(Math.max(b.o, b.c)), bot = y(Math.min(b.o, b.c));
        ctx.fillRect(x - bw / 2, top, bw, Math.max(1, bot - top));
      });
      for (const [key, token] of MAS) {
        ctx.strokeStyle = css(token); ctx.lineWidth = 1.5; ctx.beginPath();
        let started = false;
        bars.forEach((b, i) => {
          if (b[key] == null) return;
          started ? ctx.lineTo(xc(i), y(b[key])) : ctx.moveTo(xc(i), y(b[key]));
          started = true;
        });
        ctx.stroke();
      }
      ctx.lineWidth = 1;
    } else {
      const last = bars[n - 1].c;
      const col = prevClose == null || last === prevClose ? C.accent : last > prevClose ? C.up : C.down;
      if (prevClose != null) {
        const yy = Math.round(y(prevClose)) + 0.5;
        ctx.setLineDash([4, 4]); ctx.strokeStyle = C.muted;
        ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.beginPath();
      bars.forEach((b, i) => (i ? ctx.lineTo(xc(i), y(b.c)) : ctx.moveTo(xc(i), y(b.c))));
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke(); ctx.lineWidth = 1;
      ctx.lineTo(xc(n - 1), padT + priceH); ctx.lineTo(xc(0), padT + priceH); ctx.closePath();
      ctx.globalAlpha = 0.1; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1;
    }

    // 현재가 태그
    const lastBar = bars[n - 1];
    const ref = mode === 'line' ? (prevClose ?? lastBar.o) : (n > 1 ? bars[n - 2].c : lastBar.o);
    tag(y(lastBar.c), fmt(lastBar.c), lastBar.c > ref ? C.up : lastBar.c < ref ? C.down : C.muted);

    // 십자선
    if (hover >= 0 && hover < n) {
      const b = bars[hover];
      const x = Math.round(xc(hover)) + 0.5, yy = Math.round(y(b.c)) + 0.5;
      ctx.strokeStyle = C.muted; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, volTop + volH); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke();
      ctx.setLineDash([]);
      tag(yy, fmt(b.c), C.fg, css('--bg'));
    }

    function tag(yy, text, bg, fg = '#fff') {
      ctx.fillStyle = bg; ctx.fillRect(plotW + 1, yy - 8, padR - 2, 16);
      ctx.fillStyle = fg; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(text, plotW + 6, yy);
    }
    geo = { step, n, plotW };
  }

  function setHover(i) {
    if (i === hover) return;
    hover = i;
    draw();
    if (opts.onHover) opts.onHover(i >= 0 ? state.bars[i] : null);
  }
  canvas.addEventListener('pointermove', (e) => {
    if (!geo) return;
    const x = e.clientX - canvas.getBoundingClientRect().left;
    setHover(x > geo.plotW ? -1 : Math.max(0, Math.min(geo.n - 1, Math.floor(x / geo.step))));
  });
  canvas.addEventListener('pointerleave', () => setHover(-1));
  new ResizeObserver(draw).observe(canvas);

  return {
    set(next) { state = { prevClose: null, ...next }; hover = -1; draw(); },
    redraw: draw,
  };
}
