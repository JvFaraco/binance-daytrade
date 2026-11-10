// Controlador: liga a API pública, o fluxo ao vivo, o worker e as stores.
// É aqui que o pipeline do skill acontece de verdade: scan -> plan -> timemachine -> size -> risk.
// Não existe etapa de envio: o broker.py não foi portado e nenhuma ordem sai daqui.
import { DEFAULT_GRID, grid as makeGrid } from "../engine/backtest";
import { type Config, ApiError, IV, TraderError, closedOnly, fmtTs, orbSignal } from "../engine/core";
import { type Plan, buildPlan } from "../engine/plan";
import * as fmt from "./format";
import { runChecks, riskVerdict } from "../engine/risk";
import { counts, explainFiltered, filterHits, pickUniverse, scanOrb } from "../engine/scan";
import { type Order, parseRules, sizeOrder } from "../engine/size";
import { type McRaw, summarizeMc, verdict } from "../engine/timemachine";
import { engine, onRestTelemetry } from "../data/engineClient";
import { unpackBars } from "../data/pack";
import { MarketStream } from "../data/stream";
import { useMode } from "../state/mode";
import { type Settings, configFrom, useSettings } from "../state/settings";
import { type TmState, setStage, useAnalysis, useMarket, useTelemetry, useTicks } from "../state/stores";
import { TAPE_MAX, live, now, upsertBar } from "./live";

export const UNIVERSE_TOP = 40;
export const UNIVERSE_REFRESH_MS = 30 * 60000;
/** histórico mais velho que isso é recarregado antes de simular (só o mês corrente é pedido de novo) */
export const HISTORY_STALE_MS = 30 * 60000;
export const TM_DAYS = 60;
export const TM_REPLAYS = 10000;
export const TM_SEED = 19;
export const TM_WINDOW = 2;
export const GRID_SPLIT = 0.7;
export const RESEARCH_LOOKBACKS = [10, 20, 30, 40, 55];
export const SEASON_BUY = 21;
export const SEASON_SELL = 23;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fmtMs = (ms: number) => fmt.num(ms, ms < 10 ? 1 : 0);

const isPro = () => useMode.getState().mode === "pro";

/**
 * O Pro acompanha todos os pares do scanner; o Lite, só o par escolhido. Depois que o Pro foi
 * aberto uma vez nesta visita os dados já estão aqui, então o escopo largo continua valendo.
 */
let wide = false;

function scopeSymbols(): string[] {
  const sel = useSettings.getState().symbol;
  if (!wide) return [sel];
  const all = useMarket.getState().universe.map((u) => u.symbol);
  if (!all.includes(sel)) all.push(sel);
  return all;
}

/**
 * Quantos fios a esfera desenha: todos no desktop, menos em telas pequenas ou GPUs modestas.
 * No Lite a esfera não existe: zero fios, e o worker nem monta os buffers dela.
 */
export function sphereMaxDraw(): number {
  if (!isPro()) return 0;
  if (typeof window === "undefined") return 2500;
  const small = window.matchMedia("(max-width: 720px)").matches;
  const cores = navigator.hardwareConcurrency || 4;
  if (small) return 2500;
  return cores <= 4 ? 5000 : TM_REPLAYS;
}

/** McRaw (formato do motor) a partir do resultado do worker. */
export function rawOf(tm: TmState): McRaw {
  const r = tm.result;
  return { replays: r.replays, seed: r.seed, entry: r.entry, stop: r.stop, target: r.target, exit: r.exit, outcome: r.outcome, len: r.len, pathLen: r.pathLen, paths: null };
}

// ---------------------------------------------------------------- fluxo ao vivo

let stream: MarketStream | null = null;
let scanTimer: ReturnType<typeof setTimeout> | null = null;
let pricesDirty = false;
let tapeDirty = false;
let barsDirty = false;
let msgCount = 0;

function scheduleScan(delay = 250): void {
  if (scanTimer) return;
  scanTimer = setTimeout(() => {
    scanTimer = null;
    runScan();
  }, delay);
}

function startStream(): void {
  stream = new MarketStream({
    onKline(symbol, bar, closed) {
      msgCount++;
      upsertBar(symbol, bar);
      pricesDirty = true;
      if (symbol === useSettings.getState().symbol) barsDirty = true;
      if (closed) scheduleScan();
    },
    onTrade(symbol, trade) {
      msgCount++;
      if (symbol !== useSettings.getState().symbol) return;
      live.tape.push(trade);
      if (live.tape.length > TAPE_MAX) live.tape.splice(0, live.tape.length - TAPE_MAX);
      live.last.set(symbol, trade.price);
      tapeDirty = true;
      pricesDirty = true;
    },
    onStatus(wsStatus, wsHost) {
      useTelemetry.setState({ wsStatus, wsHost });
      // sem conexão não há latência nem taxa de mensagens para mostrar
      if (wsStatus !== "ao vivo") useTelemetry.setState({ wsLatency: null, wsRate: 0 });
    },
    onResume() {
      void resync();
    },
    onLatency(ms) {
      const t = useTelemetry.getState();
      useTelemetry.setState({ wsLatency: ms, wsLatencyHistory: [...t.wsLatencyHistory.slice(-59), ms] });
    },
  });
  stream.clockOffset = live.offset;
  // resumo para as stores com teto de frequência: preços 2x/s, fita e candle 5x/s
  setInterval(() => {
    if (!pricesDirty) return;
    pricesDirty = false;
    const prev = useMarket.getState().prices;
    const next: Record<string, number> = {};
    let changed = false;
    for (const [s, p] of live.last) {
      next[s] = p;
      if (prev[s] !== p) changed = true;
    }
    if (changed) useMarket.setState({ prices: next });
  }, 500);
  setInterval(() => {
    if (!tapeDirty && !barsDirty) return;
    const t = useTicks.getState();
    useTicks.setState({ tape: tapeDirty ? t.tape + 1 : t.tape, bars: barsDirty ? t.bars + 1 : t.bars });
    tapeDirty = false;
    barsDirty = false;
  }, 200);
  setInterval(() => {
    useTelemetry.setState({ wsRate: msgCount });
    msgCount = 0;
  }, 1000);
  // os estados mudam com o relógio (fim da faixa, fim da janela), não só com candle novo
  setInterval(() => scheduleScan(0), 15000);
  // a lista de pares vale 30 min, como o universe_cache.json do scan.py
  setInterval(() => void refreshUniverse(), UNIVERSE_REFRESH_MS);
}

/**
 * Depois de uma queda do WebSocket: os candles que fecharam no intervalo não chegaram.
 * Busca de novo os candles de cada par e refaz o scanner, para o sinal não sair de dado com buraco.
 */
/** Busca os candles dos pares que ainda não estão em memória. */
async function ensureBars(symbols: string[], onProgress?: (done: number, total: number) => void): Promise<void> {
  const missing = symbols.filter((sym) => !live.bars.has(sym));
  if (!missing.length) return;
  // 300 candles de 5m = 25 h: cobre a sessão atual de qualquer âncora (scan.py pede só do início da sessão;
  // o sinal ignora o que vem antes, então o resultado é o mesmo)
  const sb = await engine({ type: "sessionBars", symbols: missing, limit: 300 }, (p) => onProgress?.(p.done, p.total));
  for (const [sym, packed] of Object.entries(sb.data.bars)) {
    const bars = unpackBars(packed);
    live.bars.set(sym, bars);
    if (bars.length) live.last.set(sym, bars[bars.length - 1].c);
  }
  pricesDirty = true;
}

let resyncing = false;
async function resync(): Promise<void> {
  if (resyncing) return;
  resyncing = true;
  try {
    const sb = await engine({ type: "sessionBars", symbols: scopeSymbols(), limit: 300 });
    for (const [sym, packed] of Object.entries(sb.data.bars)) {
      const fresh = unpackBars(packed);
      const last = live.bars.get(sym);
      // mantém o candle em formação mais novo que já chegou pelo fluxo
      const tail = last && fresh.length && last.length && last[last.length - 1].t > fresh[fresh.length - 1].t ? [last[last.length - 1]] : [];
      live.bars.set(sym, [...fresh, ...tail]);
      if (fresh.length) live.last.set(sym, (tail[0] ?? fresh[fresh.length - 1]).c);
    }
    useTicks.setState((t) => ({ ...t, bars: t.bars + 1 }));
    pricesDirty = true;
    runScan();
  } catch {
    // sem REST agora: o próximo retorno do fluxo tenta de novo
  } finally {
    resyncing = false;
  }
}

/** Renova a lista de pares (ticker 24h pesa 80, por isso só a cada 30 min) e ajusta os fluxos. */
async function refreshUniverse(): Promise<void> {
  if (useMarket.getState().boot !== "pronto") return;
  const cfg = configFrom(useSettings.getState());
  try {
    const tick = await engine({ type: "tickers", quote: cfg.quote, ttlMinutes: cfg.universe_cache_minutes });
    const universe = pickUniverse(tick.data.tickers, cfg, UNIVERSE_TOP);
    if (!universe.length) return;
    useMarket.setState({ universe, universeAt: tick.data.at, universeCached: tick.data.fromCache });
    await ensureBars(scopeSymbols());
    syncStreams();
    runScan();
  } catch {
    // fica com a lista anterior; a telemetria mostra se a API limitou
  }
}

function syncStreams(): void {
  if (!stream) return;
  const sel = useSettings.getState().symbol;
  const names = new Set(scopeSymbols().map((sym) => sym.toLowerCase() + "@kline_5m"));
  // a fita de negócios só existe no Pro
  if (wide) names.add(sel.toLowerCase() + "@aggTrade");
  stream.setStreams(names);
}

// ---------------------------------------------------------------- scan

let lastSignalKey = "";

function countSessionCandles(): void {
  let n = 0;
  for (const arr of live.bars.values()) n += arr.length;
  useTelemetry.setState({ sessionCandles: n });
}

/** O scanner: exatamente scan.py (orb_signal em cada par, filter_hits, explain_filtered). */
export function runScan(): void {
  const all = useMarket.getState().universe;
  if (!all.length) return;
  const s = useSettings.getState();
  const cfg = configFrom(s);
  const t = now();
  const t0 = performance.now();
  const inScope = new Set(scopeSymbols());
  const universe = all.filter((u) => inScope.has(u.symbol));
  const results = scanOrb(universe, t, cfg, (sym) => closedOnly(live.bars.get(sym) ?? [], t));
  const hits = filterHits(results, cfg).map((r) => r.symbol);
  const discarded = explainFiltered(results, cfg);
  const ms = performance.now() - t0;
  const bySymbol: Record<string, (typeof results)[number]> = {};
  for (const r of results) bySymbol[r.symbol] = r;
  useMarket.setState((m) => ({ results, bySymbol, counts: counts(results), hits, discarded, scanMs: ms, scannedAt: t, scans: m.scans + 1 }));
  setStage("scan", { status: "done", ms, note: `${results.length} ${results.length === 1 ? "par" : "pares"} · ${hits.length} ${hits.length === 1 ? "rompimento válido" : "rompimentos válidos"}`, progress: null });
  countSessionCandles();
  // o sinal do par escolhido mudou? refaz o plano
  const sig = orbSignal(closedOnly(live.bars.get(s.symbol) ?? [], t), t, cfg);
  const key = `${s.symbol}|${sig.session_start}|${sig.status}|${sig.trigger?.time ?? 0}`;
  useAnalysis.setState({ signal: sig });
  if (key !== lastSignalKey) {
    const first = lastSignalKey === "";
    lastSignalKey = key;
    if (!first) void analyze();
  }
}

// ---------------------------------------------------------------- análise do par

let seq = 0;
let gridKey = "";
let settingsKey = "";
let researchKey = "";

async function loadHistoryFor(symbol: string, months: number, token: number): Promise<boolean> {
  const a = useAnalysis.getState();
  const fresh = a.history.info ? now() - (a.history.info.last + IV) < HISTORY_STALE_MS : false;
  if (a.history.status === "ready" && a.history.symbol === symbol && a.history.months === months && fresh) return true;
  // recarga do mesmo par e período (histórico envelhecido): mantém o resumo anterior na tela enquanto atualiza
  const keep = a.history.symbol === symbol && a.history.months === months ? a.history.info : null;
  useAnalysis.setState({ history: { status: "loading", symbol, months, done: 0, total: 0, note: "", info: keep, error: null } });
  try {
    const { data, ms } = await engine({ type: "history", symbol, months, now: now() }, (p) => {
      if (token !== seq) return;
      useAnalysis.setState((s) => ({ history: { ...s.history, done: p.done, total: p.total, note: p.note ?? "" } }));
    });
    if (token !== seq) return false;
    useAnalysis.setState({ history: { status: "ready", symbol, months, done: 1, total: 1, note: "", info: data, error: null } });
    useTelemetry.setState({ workerMs: ms, workerJob: `histórico (${data.requests} pedidos)` });
    return true;
  } catch (e) {
    if (token !== seq) return false;
    useAnalysis.setState({ history: { status: "error", symbol, months, done: 0, total: 0, note: "", info: null, error: msg(e) } });
    return false;
  }
}

async function loadRules(symbol: string, token: number): Promise<void> {
  useAnalysis.setState({ rules: null, rulesError: null, avgPrice: null });
  try {
    const [info, avg] = await Promise.all([engine({ type: "exchangeInfo", symbol }), engine({ type: "avgPrice", symbol })]);
    if (token !== seq) return;
    useAnalysis.setState({ rules: parseRules(info.data, symbol), avgPrice: avg.data, rulesError: null });
  } catch (e) {
    if (token !== seq) return;
    useAnalysis.setState({ rules: null, rulesError: msg(e) });
  }
}

/** size + risk: rápidos, na thread da interface. Rodam de novo a cada mudança de custo. */
export function runSizeAndRisk(): void {
  const s = useSettings.getState();
  const cfg = configFrom(s);
  const a = useAnalysis.getState();
  const { plan, rules, tm } = a;
  if (!plan) {
    useAnalysis.setState({ order: null, orderError: null, checks: null, riskVerdict: null });
    setStage("size", { status: "skipped", ms: null, note: "sem plano", progress: null });
    setStage("risk", { status: "skipped", ms: null, note: "sem plano", progress: null });
    return;
  }
  if (!rules) {
    useAnalysis.setState({ order: null, orderError: a.rulesError, checks: null, riskVerdict: null });
    setStage("size", a.rulesError ? { status: "error", ms: null, note: a.rulesError, progress: null } : { status: "running", ms: null, note: "lendo exchangeInfo", progress: null });
    setStage("risk", { status: "skipped", ms: null, note: "sem ordem dimensionada", progress: null });
    return;
  }
  let order: Order;
  let t0 = performance.now();
  try {
    // o preço médio só vale para o plano da sessão atual; num replay ele é de outro dia
    order = sizeOrder(plan, cfg, rules, a.planSource === "live" ? a.avgPrice : null);
    setStage("size", { status: "done", ms: performance.now() - t0, note: `${order.qty.replace(".", ",")} ${order.base} · ${fmt.num(order.notional)} ${order.quote}`, progress: null });
    useAnalysis.setState({ order, orderError: null });
  } catch (e) {
    if (!(e instanceof TraderError)) throw e;
    setStage("size", { status: "error", ms: performance.now() - t0, note: e.message, progress: null });
    setStage("risk", { status: "skipped", ms: null, note: "sem ordem dimensionada", progress: null });
    useAnalysis.setState({ order: null, orderError: e.message, checks: null, riskVerdict: null });
    return;
  }
  t0 = performance.now();
  let tmSummary = null;
  if (tm && tm.plan === plan) {
    const mc = summarizeMc(rawOf(tm), cfg);
    tmSummary = { verdict: verdict(mc, plan, cfg), mc: { avg_net_r: mc.avg_net_r } };
  }
  const checks = runChecks(plan, order, cfg, { orders: [] }, now(), tmSummary);
  const v = riskVerdict(checks);
  const blocks = checks.filter((c) => c.level === "block").length;
  setStage("risk", { status: "done", ms: performance.now() - t0, note: v === "PASS" ? "PASS" : `BLOCK · ${blocks} ${blocks === 1 ? "motivo" : "motivos"}`, progress: null });
  useAnalysis.setState({ checks, riskVerdict: v });
}

async function planStage(token: number, s: Settings, cfg: Config): Promise<Plan | null> {
  setStage("plan", { status: "running", note: "", progress: null });
  const t0 = performance.now();
  const t = now();
  const sig = orbSignal(closedOnly(live.bars.get(s.symbol) ?? [], t), t, cfg);
  useAnalysis.setState({ signal: sig });
  try {
    const plan = buildPlan(s.symbol, sig, cfg, s.stop_rule, s.target_r, null, t);
    useAnalysis.setState({ plan, planSource: "live", planNote: null });
    setStage("plan", { status: "done", ms: performance.now() - t0, note: `rompimento da sessão atual · faixa de ${fmt.pct(plan.range_pct)}`, progress: null });
    return plan;
  } catch (e) {
    if (!(e instanceof TraderError)) throw e;
    const note = e.message;
    try {
      const { data } = await engine({ type: "lastBreakout", symbol: s.symbol, cfg, stopRule: s.stop_rule, targetR: s.target_r, before: sig.session_start });
      if (token !== seq) return null;
      if (!data) {
        useAnalysis.setState({ plan: null, planSource: null, planNote: note });
        setStage("plan", { status: "error", ms: performance.now() - t0, note: "nenhum rompimento no histórico carregado", progress: null });
        return null;
      }
      useAnalysis.setState({ plan: data, planSource: "replay", planNote: note });
      setStage("plan", { status: "done", ms: performance.now() - t0, note: `replay do último rompimento · ${fmtTs(data.entry_time ?? data.session_start, cfg.display_tz)}`, progress: null });
      return data;
    } catch (e2) {
      if (token !== seq) return null;
      useAnalysis.setState({ plan: null, planSource: null, planNote: note });
      setStage("plan", { status: "error", ms: performance.now() - t0, note: msg(e2), progress: null });
      return null;
    }
  }
}

async function timeMachineStage(token: number, s: Settings, plan: Plan): Promise<void> {
  const live_ = useAnalysis.getState().planSource === "live";
  setStage("timemachine", { status: "running", note: "sorteando candles de 5m", progress: 0 });
  useAnalysis.setState({ tmStatus: "loading", tmProgress: 0, tmError: null });
  try {
    const { data, ms } = await engine(
      {
        type: "timemachine",
        symbol: s.symbol,
        plan,
        // o Time Machine olha os 60 dias antes do sinal: agora (ao vivo) ou a hora do rompimento (replay)
        tmNow: live_ ? now() : (plan.entry_time ?? plan.session_start),
        days: TM_DAYS,
        replays: TM_REPLAYS,
        seed: TM_SEED,
        window: TM_WINDOW,
        maxDraw: sphereMaxDraw(),
      },
      (p) => {
        if (token !== seq) return;
        const f = p.total ? p.done / p.total : 0;
        useAnalysis.setState({ tmProgress: f });
        setStage("timemachine", { status: "running", progress: f });
      },
    );
    if (token !== seq) return;
    const sortedExit = Float64Array.from(data.exit).sort();
    useAnalysis.setState({ tm: { result: data, sortedExit, plan }, tmStatus: "ready", tmProgress: 1, tmError: null });
    useTelemetry.setState({ workerMs: ms, workerJob: `${data.replays.toLocaleString("pt-BR")} replays` });
    setStage("timemachine", { status: "done", ms, note: `${data.replays.toLocaleString("pt-BR")} replays · ${data.sessions} sessões · seed ${data.seed}`, progress: null });
  } catch (e) {
    if (token !== seq) return;
    useAnalysis.setState({ tm: null, tmStatus: "error", tmError: msg(e) });
    setStage("timemachine", { status: "error", ms: null, note: msg(e), progress: null });
  }
}

async function gridStage(token: number, s: Settings, cfg: Config): Promise<void> {
  const key = `${s.symbol}|${s.months}`;
  if (key !== gridKey || useAnalysis.getState().grid.status !== "ready") {
    gridKey = key;
    const combos = makeGrid(DEFAULT_GRID.anchors, DEFAULT_GRID.ranges, DEFAULT_GRID.stops, DEFAULT_GRID.targets, DEFAULT_GRID.minRanges);
    useAnalysis.setState({ grid: { status: "loading", done: 0, total: combos.length, result: null, error: null, ms: null, symbol: s.symbol, months: s.months } });
    try {
      const { data, ms } = await engine(
        { type: "grid", symbol: s.symbol, entryBufferPct: cfg.entry_buffer_pct, combos, split: GRID_SPLIT, entryWindow: cfg.entry_window_minutes, flatBy: cfg.flat_by_hours, maxChase: cfg.max_chase_pct },
        (p) => token === seq && useAnalysis.setState((st) => ({ grid: { ...st.grid, done: p.done, total: p.total } })),
      );
      if (token !== seq) return;
      useAnalysis.setState({ grid: { status: "ready", done: combos.length, total: combos.length, result: data, error: null, ms, symbol: s.symbol, months: s.months } });
      useTelemetry.setState({ workerMs: ms, workerJob: `grade (${combos.length} combinações)` });
    } catch (e) {
      if (token !== seq) return;
      gridKey = "";
      useAnalysis.setState((st) => ({ grid: { ...st.grid, status: "error", error: msg(e) } }));
    }
  }
  // a pesquisa (sazonalidade, Donchian, buy & hold) só aparece no Pro: no Lite ela nem é calculada
  if (!isPro() || researchKey === key) return;
  researchKey = key;
  useAnalysis.setState({ research: { status: "loading", raw: null, error: null, ms: null } });
  try {
    const { data, ms } = await engine({ type: "research", symbol: s.symbol, lookbacks: RESEARCH_LOOKBACKS, buyH: SEASON_BUY, sellH: SEASON_SELL });
    if (token !== seq) return;
    useAnalysis.setState({ research: { status: "ready", raw: data, error: null, ms } });
  } catch (e) {
    if (token !== seq) return;
    researchKey = "";
    useAnalysis.setState({ research: { status: "error", raw: null, error: msg(e), ms: null } });
  }
}

/** O que depende dos controles da regra (âncora, faixa, stop, alvo) no período inteiro. */
async function ruleStage(token: number, s: Settings, cfg: Config): Promise<void> {
  // bruto x líquido do rompimento e o Pareto dos rejeitados são painéis do Pro
  if (!isPro()) return;
  const key = `${s.symbol}|${s.months}|${s.anchor_utc}|${s.range_minutes}|${s.stop_rule}|${s.target_r}|${s.account}|${s.max_loss_per_trade}|${useAnalysis.getState().rules ? 1 : 0}`;
  if (key === settingsKey) return;
  settingsKey = key;
  useAnalysis.setState((st) => ({ breakout: { ...st.breakout, status: "loading" }, rejections: { ...st.rejections, status: "loading" } }));
  try {
    const combo = { anchor_utc: s.anchor_utc, range_minutes: s.range_minutes, stop_rule: s.stop_rule, target_r: s.target_r, min_range_pct: cfg.min_range_pct };
    const [g, r] = await Promise.all([
      engine({ type: "grid", symbol: s.symbol, entryBufferPct: cfg.entry_buffer_pct, combos: [combo], split: 1, entryWindow: cfg.entry_window_minutes, flatBy: cfg.flat_by_hours, maxChase: cfg.max_chase_pct }),
      engine({ type: "rejections", symbol: s.symbol, cfg, stopRule: s.stop_rule, targetR: s.target_r, rules: useAnalysis.getState().rules }),
    ]);
    if (token !== seq) return;
    useAnalysis.setState({
      breakout: { status: "ready", trades: g.data.combos[0].train, sessions: g.data.combos[0].sessions[0] },
      rejections: { status: "ready", report: r.data },
    });
  } catch {
    if (token !== seq) return;
    settingsKey = "";
    useAnalysis.setState((st) => ({ breakout: { ...st.breakout, status: "error" }, rejections: { ...st.rejections, status: "error" } }));
  }
}

/** Roda o pipeline do par escolhido do plano em diante. */
export async function analyze(): Promise<void> {
  const token = ++seq;
  const s = useSettings.getState();
  const cfg = configFrom(s);
  const a = useAnalysis.getState();
  const symbolChanged = a.history.symbol !== s.symbol;
  const periodChanged = symbolChanged || a.history.months !== s.months;
  if (periodChanged) {
    // pesquisa e motivos de rejeição são do período: saem da tela até o novo cálculo chegar
    settingsKey = "";
    researchKey = "";
    useAnalysis.setState({
      research: { status: "idle", raw: null, error: null, ms: null },
      breakout: { status: "idle", trades: null, sessions: 0 },
      rejections: { status: "idle", report: null },
    });
  }
  if (symbolChanged) {
    useAnalysis.setState({ plan: null, planSource: null, planNote: null, tm: null, tmStatus: "idle", order: null, orderError: null, checks: null, riskVerdict: null });
    setStage("plan", { status: "running", ms: null, note: "carregando histórico", progress: null });
    setStage("timemachine", { status: "idle", ms: null, note: "", progress: null });
    setStage("size", { status: "idle", ms: null, note: "", progress: null });
    setStage("risk", { status: "idle", ms: null, note: "", progress: null });
  }
  const rules = symbolChanged || (!a.rules && !a.rulesError) ? loadRules(s.symbol, token) : Promise.resolve();
  const ok = await loadHistoryFor(s.symbol, s.months, token);
  if (token !== seq) return;
  if (!ok) {
    setStage("plan", { status: "error", ms: null, note: "sem histórico", progress: null });
    return;
  }
  const plan = await planStage(token, s, cfg);
  if (token !== seq) return;
  if (plan) await timeMachineStage(token, s, plan);
  else {
    useAnalysis.setState({ tm: null, tmStatus: "idle" });
    setStage("timemachine", { status: "skipped", ms: null, note: "sem plano", progress: null });
  }
  if (token !== seq) return;
  await rules;
  if (token !== seq) return;
  runSizeAndRisk();
  await gridStage(token, s, cfg);
  if (token !== seq) return;
  await ruleStage(token, s, cfg);
}

// ---------------------------------------------------------------- partida e reação aos controles

export function selectSymbol(symbol: string): void {
  if (symbol === useSettings.getState().symbol) return;
  live.tape.length = 0;
  useTicks.setState((t) => ({ tape: t.tape + 1, bars: t.bars + 1 }));
  useSettings.getState().set({ symbol });
}

let booted = false;
let wired = false;

/** Controles -> recalcular. Custo não refaz sorteio nem simulação: só size, risk e o R líquido. */
function wireSettings(): void {
  if (wired) return;
  wired = true;
  let costRaf = 0;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let ruleDebounce: ReturnType<typeof setTimeout> | null = null;
  useSettings.subscribe((cur, prev) => {
    if (useMarket.getState().boot !== "pronto") return;
    if (cur.symbol !== prev.symbol) {
      lastSignalKey = "";
      syncStreams();
      void ensureBars([cur.symbol])
        .catch(() => {})
        .then(() => {
          if (useSettings.getState().symbol !== cur.symbol) return;
          useTicks.setState((t) => ({ ...t, bars: t.bars + 1 }));
          runScan();
          void analyze();
        });
      return;
    }
    const rule = cur.anchor_utc !== prev.anchor_utc || cur.range_minutes !== prev.range_minutes || cur.stop_rule !== prev.stop_rule || cur.target_r !== prev.target_r;
    if (rule || cur.months !== prev.months) {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        lastSignalKey = "";
        runScan();
        void analyze();
      }, 180);
      return;
    }
    if (cur.cost_pct !== prev.cost_pct || cur.account !== prev.account || cur.max_loss_per_trade !== prev.max_loss_per_trade) {
      if (!costRaf) {
        costRaf = requestAnimationFrame(() => {
          costRaf = 0;
          runSizeAndRisk();
        });
      }
      // capital e perda máxima mudam o que o size e o risk recusam no histórico
      if (cur.account !== prev.account || cur.max_loss_per_trade !== prev.max_loss_per_trade) {
        if (ruleDebounce) clearTimeout(ruleDebounce);
        ruleDebounce = setTimeout(() => {
          const s = useSettings.getState();
          void ruleStage(seq, s, configFrom(s));
        }, 400);
      }
    }
  });
}

/**
 * Abrir o Pro: carrega o que o Lite não precisou (candles dos outros pares, fita, esfera,
 * pesquisa e Pareto), sem recarregar a página. Os números que já estavam na tela não mudam:
 * os replays são refeitos com a mesma seed só para gravar os caminhos da esfera.
 */
let widening: Promise<void> | null = null;
export function ensurePro(): Promise<void> {
  if (useMarket.getState().boot !== "pronto") return Promise.resolve();
  if (widening) return widening;
  widening = (async () => {
    try {
      if (!wide) {
        wide = true;
        await ensureBars(scopeSymbols(), (done, total) => useMarket.setState({ bootDone: done, bootTotal: total }));
        syncStreams();
        lastSignalKey = "";
        runScan();
      }
      const a = useAnalysis.getState();
      const needs = (a.tm && !a.tm.result.sphere) || a.research.status === "idle" || a.rejections.status === "idle";
      if (needs) await analyze();
    } catch {
      // sem rede agora: o scanner mostra o que tem; a próxima troca tenta de novo
    } finally {
      widening = null;
    }
  })();
  return widening;
}

let modeWired = false;
function wireMode(): void {
  if (modeWired) return;
  modeWired = true;
  useMode.subscribe((cur, prev) => {
    if (cur.mode === "pro" && prev.mode !== "pro") void ensurePro();
  });
}

export async function boot(): Promise<void> {
  if (booted) return;
  booted = true;
  wireSettings();
  wireMode();
  onRestTelemetry((rest) => useTelemetry.setState({ rest }));
  const s = useSettings.getState();
  const cfg = configFrom(s);
  setStage("scan", { status: "running", note: "acertando o relógio", progress: null });
  useMarket.setState({ boot: "relógio", error: null });
  try {
    const time = await engine({ type: "time" });
    live.offset = time.data.offset;
    useTelemetry.setState({ clockOffset: time.data.offset });

    useMarket.setState({ boot: "universo" });
    setStage("scan", { status: "running", note: "lista de pares USDT", progress: null });
    const tick = await engine({ type: "tickers", quote: cfg.quote, ttlMinutes: cfg.universe_cache_minutes });
    const universe = pickUniverse(tick.data.tickers, cfg, UNIVERSE_TOP);
    if (!universe.length) throw new ApiError("nenhum par passou no filtro de volume");
    useMarket.setState({ universe, universeAt: tick.data.at, universeCached: tick.data.fromCache, boot: "candles", bootTotal: universe.length });
    if (!universe.some((u) => u.symbol === s.symbol)) useSettings.getState().set({ symbol: universe[0].symbol });

    // Pro: candles de todos os pares do scanner. Lite: só os do par escolhido.
    wide = isPro();
    await ensureBars(scopeSymbols(), (done, total) => {
      useMarket.setState({ bootDone: done, bootTotal: total });
      setStage("scan", { status: "running", note: "candles da sessão", progress: total ? done / total : 0 });
    });
    useMarket.setState({ boot: "pronto", error: null, prices: Object.fromEntries(live.last) });
    useTicks.setState((t) => ({ ...t, bars: t.bars + 1 }));
    startStream();
    syncStreams();
    runScan();
    void analyze();
    // o modo pode ter virado Pro enquanto a partida ainda carregava como Lite
    if (isPro() && !wide) void ensurePro();
  } catch (e) {
    booted = false;
    useMarket.setState({ boot: "erro", error: msg(e) });
    if (!stream) useTelemetry.setState({ wsStatus: "parado" });
    setStage("scan", { status: "error", ms: null, note: msg(e), progress: null });
  }

}

/** Texto curto de tempo para a interface. */
export function stageTime(ms: number | null): string {
  if (ms === null) return "—";
  return ms >= 1000 ? fmt.num(ms / 1000, 2) + " s" : fmtMs(ms) + " ms";
}
