/// <reference lib="webworker" />
// Worker do motor: todo pedido à API pública, o cache em IndexedDB e o cálculo pesado
// (10.000 replays, grade do backtest, pesquisa) rodam aqui, fora da thread da interface.
import { evaluateTrades } from "../engine/backtest";
import { type Bar, type KlineRow, ApiError, DAY, HOUR, TraderError, closedOnly, orbSignal, parseKlines } from "../engine/core";
import { buildPlan } from "../engine/plan";
import { rejectionReport } from "../engine/rejections";
import { researchRaw } from "../engine/research";
import { type Ticker, slimTickers } from "../engine/scan";
import type { ExchangeInfo } from "../engine/size";
import { completeSessions, fullSessions, historyTrades, runMcRaw } from "../engine/timemachine";
import { loadHistory } from "../data/history";
import { STORE_KV, idbGet, idbSet } from "../data/idb";
import { packBars } from "../data/pack";
import { BinanceRest } from "../data/rest";
import { buildSphereBuffers } from "../sphere/geometry";
import type { Progress, Request, ResponseMap, WorkerIn, WorkerOut } from "./protocol";

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const post = (m: WorkerOut, transfer: Transferable[] = []) => ctx.postMessage(m, transfer);

const rest = new BinanceRest((t) => post({ id: -1, kind: "telemetry", rest: t }));

/** histórico em memória por par: o maior período já carregado */
const hist = new Map<string, { months: number; bars: Bar[] }>();
const infoCache = new Map<string, { at: number; info: ExchangeInfo }>();

function barsOf(symbol: string): Bar[] {
  const h = hist.get(symbol);
  if (!h) throw new TraderError(`histórico de ${symbol} ainda não foi carregado`);
  return h.bars;
}

type Handler<K extends Request["type"]> = (
  req: Extract<Request, { type: K }>,
  progress: (p: Progress) => void,
) => Promise<{ data: ResponseMap[K]; transfer?: Transferable[] }>;

const handlers: { [K in Request["type"]]: Handler<K> } = {
  async time() {
    const t0 = Date.now();
    const p0 = performance.now();
    const r = await rest.get<{ serverTime: number }>("/api/v3/time", {}, 1);
    const rt = performance.now() - p0;
    return { data: { offset: Math.round(r.serverTime - (t0 + rt / 2)), roundTripMs: rt } };
  },

  async tickers(req) {
    // ticker/24hr sem símbolo pesa 80: a lista fica em cache, como o universe_cache.json do scan.py
    const key = "tickers|" + req.quote;
    const now = Date.now();
    if (!req.refresh) {
      const c = await idbGet<{ at: number; tickers: Ticker[] }>(STORE_KV, key);
      if (c && now - c.at < req.ttlMinutes * 60000) return { data: { tickers: c.tickers, at: c.at, fromCache: true } };
    }
    const raw = await rest.get<Ticker[]>("/api/v3/ticker/24hr", { type: "MINI" }, 80);
    const tickers = slimTickers(raw, req.quote);
    await idbSet(STORE_KV, key, { at: now, tickers });
    return { data: { tickers, at: now, fromCache: false } };
  },

  async sessionBars(req, progress) {
    const bars: Record<string, Float64Array> = {};
    const errors: Record<string, string> = {};
    let done = 0;
    await Promise.all(
      req.symbols.map(async (symbol) => {
        try {
          const rows = await rest.get<KlineRow[]>("/api/v3/klines", { symbol, interval: "5m", limit: req.limit }, 2);
          bars[symbol] = packBars(parseKlines(rows));
        } catch (e) {
          if (e instanceof ApiError && (e.status === 418 || e.status === 429)) throw e;
          errors[symbol] = e instanceof Error ? e.message : String(e);
        }
        progress({ done: ++done, total: req.symbols.length });
      }),
    );
    return { data: { bars, errors }, transfer: Object.values(bars).map((b) => b.buffer) };
  },

  async exchangeInfo(req) {
    const c = infoCache.get(req.symbol);
    if (c && Date.now() - c.at < 6 * HOUR) return { data: c.info };
    const info = await rest.get<ExchangeInfo>("/api/v3/exchangeInfo", { symbol: req.symbol }, 20);
    infoCache.set(req.symbol, { at: Date.now(), info });
    return { data: info };
  },

  async avgPrice(req) {
    const r = await rest.get<{ price: string }>("/api/v3/avgPrice", { symbol: req.symbol }, 2);
    return { data: Number(r.price) };
  },

  async history(req, progress) {
    const r = await loadHistory(rest, req.symbol, req.months, req.now, (p) =>
      progress({ done: p.done, total: Math.max(p.total, 1), note: `${p.cached + p.fetched} candles` }),
    );
    hist.set(req.symbol, { months: req.months, bars: r.bars });
    const n = r.bars.length;
    return {
      data: {
        symbol: req.symbol,
        months: req.months,
        candles: n,
        first: n ? r.bars[0].t : 0,
        last: n ? r.bars[n - 1].t : 0,
        cached: r.cached,
        fetched: r.fetched,
        requests: r.requests,
      },
    };
  },

  async lastBreakout(req) {
    const cfg = req.cfg;
    const sessions = completeSessions(barsOf(req.symbol), cfg.anchor_utc, cfg.flat_by_hours, req.before);
    const flatMs = Math.trunc(Number(cfg.flat_by_hours) * HOUR);
    for (let i = sessions.length - 1; i >= 0; i--) {
      const { s, bars } = sessions[i];
      const sig = orbSignal(bars, s + flatMs, cfg, s);
      if (sig.status !== "triggered" || !sig.trigger) continue;
      try {
        return { data: buildPlan(req.symbol, sig, cfg, req.stopRule, req.targetR, null, sig.trigger.time) };
      } catch (e) {
        if (!(e instanceof TraderError)) throw e;
      }
    }
    return { data: null };
  },

  async timemachine(req, progress) {
    const { plan } = req;
    const from = req.tmNow - req.days * DAY;
    const bars = closedOnly(
      barsOf(req.symbol).filter((b) => b.t >= from),
      req.tmNow,
    );
    const sessions = fullSessions(bars, plan.params, plan.session_start);
    if (sessions.length < 20) {
      throw new TraderError(`só ${sessions.length} sessões completas no histórico (mínimo 20). Aumente o período.`);
    }
    const t0 = performance.now();
    const raw = runMcRaw(plan, sessions, req.replays, req.seed, req.window, {
      recordPaths: true,
      progressEvery: 1000,
      onProgress: (done, total) => progress({ done, total, note: "replays" }),
    });
    const mcMs = performance.now() - t0;
    const sphere = buildSphereBuffers(raw, plan.target_r, req.maxDraw);
    const data: ResponseMap["timemachine"] = {
      sessions: sessions.length,
      from,
      to: req.tmNow,
      replays: raw.replays,
      seed: raw.seed,
      window: req.window,
      entry: raw.entry,
      stop: raw.stop,
      target: raw.target,
      exit: raw.exit,
      outcome: raw.outcome,
      len: raw.len,
      pathLen: raw.pathLen,
      history: historyTrades(plan, sessions),
      sphere,
      mcMs,
    };
    return {
      data,
      transfer: [raw.exit.buffer, raw.outcome.buffer, raw.len.buffer, sphere.points.buffer, sphere.index.buffer, sphere.pathReplay.buffer, sphere.pathStart.buffer, sphere.pathCount.buffer],
    };
  },

  async grid(req, progress) {
    const bars = barsOf(req.symbol);
    const combos = evaluateTrades(bars, req.entryBufferPct, req.combos, req.split, req.entryWindow, req.flatBy, req.maxChase, (index) => {
      if ((index + 1) % 8 === 0 || index + 1 === req.combos.length) progress({ done: index + 1, total: req.combos.length, note: "combinações" });
    });
    const n = bars.length;
    return { data: { combos, candles: n, first: n ? bars[0].t : 0, last: n ? bars[n - 1].t : 0 } };
  },

  async research(req) {
    return { data: researchRaw(barsOf(req.symbol), req.lookbacks, req.buyH, req.sellH) };
  },

  async rejections(req) {
    const sessions = completeSessions(barsOf(req.symbol), req.cfg.anchor_utc, req.cfg.flat_by_hours);
    return { data: rejectionReport(sessions, req.symbol, req.cfg, req.stopRule, req.targetR, req.rules) };
  },
};

ctx.onmessage = async (ev: MessageEvent<WorkerIn>) => {
  const { id, req } = ev.data;
  const t0 = performance.now();
  try {
    const handler = handlers[req.type] as Handler<typeof req.type>;
    const out = await handler(req as never, (progress) => post({ id, kind: "progress", progress }));
    post({ id, kind: "result", data: out.data, ms: performance.now() - t0 }, out.transfer ?? []);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    post({ id, kind: "error", message: err.message, name: err.name, status: e instanceof ApiError ? e.status : undefined });
  }
};
