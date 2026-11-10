// Preço ao vivo do par escolhido: candles de 5m da sessão, a faixa inicial e o candle de rompimento.
// Tudo desenhado em canvas a partir dos candles reais (REST + WebSocket).
import { live, now } from "../app/live";
import * as fmt from "../app/format";
import { HOUR, IV } from "../engine/core";
import { STATUS_LABEL } from "../engine/plan";
import { useSettings } from "../state/settings";
import { useAnalysis, useMarket, useTelemetry, useTicks } from "../state/stores";
import { LiveDot, NoData, Panel, SkeletonStack, Stat } from "../ui";
import { type Draw, alpha, tokens, useCanvas } from "../ui/useCanvas";

function Chart() {
  const symbol = useSettings((s) => s.symbol);
  const tick = useTicks((t) => t.bars);
  const signal = useAnalysis((a) => a.signal);
  const plan = useAnalysis((a) => (a.planSource === "live" ? a.plan : null));

  const draw: Draw = (ctx, w, h) => {
    const T = tokens();
    const bars = live.bars.get(symbol) ?? [];
    if (!signal || !bars.length) return;
    const padL = 8;
    const padR = 64;
    const padT = 18;
    const padB = 20;
    const s = signal.session_start;
    const t = now();
    const t0 = s - HOUR;
    const t1 = Math.max(signal.flat_by, t) + 3 * IV;
    const vis = bars.filter((b) => b.t >= t0);
    if (!vis.length) return;

    // faixa: a do sinal, ou a provisória enquanto ainda está se formando
    let rHi = signal.range_high;
    let rLo = signal.range_low;
    const forming = signal.status === "forming";
    if (rHi === undefined || rLo === undefined) {
      const rb = bars.filter((b) => b.t >= s && b.t < signal.range_end);
      if (rb.length) {
        rHi = Math.max(...rb.map((b) => b.h));
        rLo = Math.min(...rb.map((b) => b.l));
      }
    }
    let lo = Math.min(...vis.map((b) => b.l));
    let hi = Math.max(...vis.map((b) => b.h));
    if (rHi !== undefined && rLo !== undefined) {
      lo = Math.min(lo, rLo);
      hi = Math.max(hi, rHi);
    }
    if (plan) {
      lo = Math.min(lo, plan.stop);
      hi = Math.max(hi, plan.target);
    }
    const padY = (hi - lo) * 0.08 || hi * 0.001;
    lo -= padY;
    hi += padY;
    const X = (ms: number) => padL + ((ms - t0) / (t1 - t0)) * (w - padL - padR);
    const Y = (p: number) => padT + (1 - (p - lo) / (hi - lo)) * (h - padT - padB);
    const last = bars[bars.length - 1].c;
    const dec = fmt.priceDecimals(last);
    ctx.font = `10px ${T.font}`;
    ctx.textBaseline = "middle";

    // grade: horas no eixo x, preços no eixo y
    ctx.strokeStyle = T.line1;
    ctx.fillStyle = T.tx3;
    ctx.lineWidth = 1;
    const spanH = (t1 - t0) / HOUR;
    const stepH = spanH > 14 ? 4 : spanH > 7 ? 2 : 1;
    ctx.textAlign = "center";
    for (let ms = Math.ceil(t0 / HOUR) * HOUR; ms < t1; ms += HOUR) {
      if (((ms - s) / HOUR) % stepH !== 0) continue;
      const x = Math.round(X(ms)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, h - padB);
      ctx.stroke();
      ctx.fillText(fmt.hhmm(ms), x, h - padB / 2);
    }
    ctx.textAlign = "left";
    for (let i = 0; i <= 4; i++) {
      const p = lo + ((hi - lo) * i) / 4;
      const y = Math.round(Y(p)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      if (i > 0 && i < 4) ctx.fillText(fmt.num(p, dec), w - padR + 6, y);
    }

    // faixa inicial (âmbar = sinal)
    if (rHi !== undefined && rLo !== undefined) {
      const x0 = X(s);
      const x1 = X(signal.range_end);
      ctx.fillStyle = alpha(T.signal, forming ? 0.06 : 0.1);
      ctx.fillRect(x0, Y(rHi), x1 - x0, Y(rLo) - Y(rHi));
      ctx.strokeStyle = alpha(T.signal, 0.9);
      ctx.setLineDash(forming ? [3, 3] : []);
      ctx.strokeRect(Math.round(x0) + 0.5, Math.round(Y(rHi)) + 0.5, Math.round(x1 - x0), Math.round(Y(rLo) - Y(rHi)));
      ctx.setLineDash([]);
      ctx.fillStyle = T.signal;
      ctx.textAlign = "left";
      ctx.fillText(forming ? "FAIXA EM FORMAÇÃO" : `FAIXA ${fmt.pct(((rHi - rLo) / rLo) * 100)}`, x0 + 2, Math.max(8, Y(rHi) - 8));
      if (!forming) {
        // o topo da faixa segue como gatilho até o fim da janela de entrada
        const xe = X(Math.min(signal.window_end, signal.flat_by));
        ctx.strokeStyle = alpha(T.signal, 0.55);
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(x1, Math.round(Y(rHi)) + 0.5);
        ctx.lineTo(xe, Math.round(Y(rHi)) + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // marcos de tempo: fim da janela e hora de zerar
    const marks: Array<[number, string]> = [
      [signal.window_end, "fim da janela"],
      [signal.flat_by, "zerar"],
    ];
    ctx.textAlign = "right";
    for (const [ms, label] of marks) {
      if (ms > t1) continue;
      const x = Math.round(X(ms)) + 0.5;
      ctx.strokeStyle = T.line2;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, h - padB);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = T.tx3;
      ctx.fillText(label, x - 3, h - padB - 7);
    }

    // plano da sessão atual: stop e alvo
    if (plan) {
      const lines: Array<[number, string, string]> = [
        [plan.target, T.pos, `alvo ${fmt.num(plan.target_r, 1)}R`],
        [plan.entry, T.signal, "entrada"],
        [plan.stop, T.neg, "stop"],
      ];
      ctx.textAlign = "left";
      for (const [p, color, label] of lines) {
        const y = Math.round(Y(p)) + 0.5;
        ctx.strokeStyle = alpha(color, 0.8);
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(X(plan.entry_time ?? s), y);
        ctx.lineTo(w - padR, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        ctx.fillText(label, w - padR + 6, y);
      }
    }

    // candles (azul frio = dado bruto): alta preenchida, baixa vazada
    const cw = Math.max(1, Math.min(9, ((w - padL - padR) / ((t1 - t0) / IV)) * 0.7));
    for (const b of vis) {
      const x = X(b.t + IV / 2);
      const up = b.c >= b.o;
      ctx.strokeStyle = alpha(T.raw, up ? 0.95 : 0.6);
      ctx.fillStyle = alpha(T.raw, up ? 0.85 : 0.12);
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, Y(b.h));
      ctx.lineTo(Math.round(x) + 0.5, Y(b.l));
      ctx.stroke();
      const yo = Y(Math.max(b.o, b.c));
      const hh = Math.max(1, Y(Math.min(b.o, b.c)) - yo);
      ctx.fillRect(x - cw / 2, yo, cw, hh);
      if (cw >= 3) ctx.strokeRect(Math.round(x - cw / 2) + 0.5, Math.round(yo) + 0.5, Math.round(cw) - 1, Math.max(1, Math.round(hh) - 1));
    }

    // candle de rompimento
    if (signal.trigger) {
      const tb = signal.trigger;
      const x = X(tb.bar_t + IV / 2);
      const y = Y(tb.close);
      ctx.fillStyle = T.signal;
      ctx.beginPath();
      ctx.moveTo(x, y - 6);
      ctx.lineTo(x - 5, y - 15);
      ctx.lineTo(x + 5, y - 15);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = T.signal;
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.textAlign = x > w * 0.6 ? "right" : "left";
      ctx.fillText(`ROMPEU ${fmt.hhmm(tb.time)}`, x + (x > w * 0.6 ? -9 : 9), y - 12);
    }

    // último preço
    const yl = Math.round(Y(last)) + 0.5;
    ctx.strokeStyle = alpha(T.raw, 0.5);
    ctx.beginPath();
    ctx.moveTo(padL, yl);
    ctx.lineTo(w - padR, yl);
    ctx.stroke();
    ctx.fillStyle = T.raw;
    ctx.fillRect(w - padR + 1, yl - 8, padR - 2, 16);
    ctx.fillStyle = T.bg0;
    ctx.textAlign = "left";
    ctx.font = `700 10px ${T.font}`;
    ctx.fillText(fmt.num(last, dec), w - padR + 5, yl);
  };

  const ref = useCanvas(draw, [symbol, tick, signal, plan]);
  return <canvas ref={ref} className="price__canvas" role="img" aria-label={`Gráfico de candles de 5 minutos de ${symbol} com a faixa inicial da sessão`} />;
}

function Readout() {
  const symbol = useSettings((s) => s.symbol);
  const price = useMarket((m) => m.prices[symbol]);
  const signal = useAnalysis((a) => a.signal);
  const dec = price !== undefined ? fmt.priceDecimals(price) : 2;
  const p = (v: number | undefined) => (v === undefined ? "—" : fmt.num(v, dec));
  return (
    <div className="price__read">
      <Stat label="último" value={price} format={(v) => fmt.num(v, dec)} tone="raw" />
      <Stat label="topo da faixa" text={p(signal?.range_high)} tone="signal" />
      <Stat label="fundo da faixa" text={p(signal?.range_low)} />
      <Stat label="largura" text={signal?.range_pct !== undefined ? fmt.pct(signal.range_pct) : "—"} />
      <Stat label="janela até" text={signal ? fmt.hhmm(signal.window_end) : "—"} hint={signal ? `zerar ${fmt.hhmm(signal.flat_by)} BRT` : undefined} />
      <div className="price__status" aria-live="polite">
        <span className="label">estado do sinal</span>
        <span className={signal?.status === "triggered" ? "tone-signal" : "tone-dim"}>
          {signal ? STATUS_LABEL[signal.status].toLowerCase() + (signal.trigger ? ` às ${fmt.hhmm(signal.trigger.time)} BRT` : "") : "—"}
        </span>
      </div>
    </div>
  );
}

export function PricePanel() {
  const symbol = useSettings((s) => s.symbol);
  const range = useSettings((s) => s.range_minutes);
  const anchor = useSettings((s) => s.anchor_utc);
  const ready = useMarket((m) => m.boot === "pronto");
  const offline = useMarket((m) => m.boot === "erro");
  const ws = useTelemetry((t) => t.wsStatus);
  return (
    <Panel
      area="price"
      title="Preço ao vivo"
      sub={`${symbol} · 5m · âncora ${anchor} UTC · faixa de ${range} min · horários em BRT`}
      state={<LiveDot state={ws === "ao vivo" ? "live" : ws === "parado" ? "error" : "busy"} label={ws} />}
    >
      {ready ? (
        <>
          <div className="price__chart">
            <Chart />
          </div>
          <Readout />
        </>
      ) : offline ? (
        <NoData />
      ) : (
        <SkeletonStack lines={7} label="Carregando candles" />
      )}
    </Panel>
  );
}
