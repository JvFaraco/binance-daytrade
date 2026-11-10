// @vitest-environment jsdom
// Os dois modos renderizados de verdade com o mesmo estado: os números têm de ser os mesmos,
// a troca preserva par, custo e período, e a esfera só é carregada quando o Pro pede.
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const sceneLoaded = vi.fn();
vi.mock("../src/sphere/SphereScene", () => {
  sceneLoaded();
  return { default: () => null };
});
// canvas e medidor de fps não existem no jsdom; não fazem parte do que este teste confere
vi.mock("../src/panels/PriceChart", () => ({ PriceChart: () => null }));
vi.mock("../src/app/fps", () => ({ startFpsMeter: () => {} }));
// a partida real fala com a Binance por um Web Worker; aqui o estado é montado direto com o motor
vi.mock("../src/app/controller", async (orig) => ({ ...(await orig<typeof import("../src/app/controller")>()), boot: vi.fn(async () => {}), selectSymbol: vi.fn() }));

import { App } from "../src/App";
import { runSizeAndRisk } from "../src/app/controller";
import * as fmt from "../src/app/format";
import { type Bar, DEFAULTS, orbSignal } from "../src/engine";
import { DEFAULT_GRID, evaluateTrades, grid as makeGrid, gridVerdict, summarizeCombo } from "../src/engine/backtest";
import { parseRules } from "../src/engine/size";
import { type McRaw, mcCostStats, summarizeMc } from "../src/engine/timemachine";
import { breakevenR, costK } from "../src/sphere/geometry";
import { MODE_PARAM, setMode, useMode } from "../src/state/mode";
import { STORAGE_KEY } from "../src/state/persist";
import { splitCost, useSettings } from "../src/state/settings";
import { useAnalysis, useMarket } from "../src/state/stores";
import { timeMachineJob } from "../src/workers/jobs";
import { fixture } from "./helpers";

const NUMS = ["avg_net_r", "pct_target", "pct_open", "pct_stop", "hit_rate", "breakeven", "hist_avg", "at_target", "at_stop", "grid_top", "grid_all", "cost"];
const fx = fixture();
const plan = fx.timemachine.plan;

function read(names = NUMS): Record<string, string> {
  return Object.fromEntries(names.map((n) => [n, (document.querySelector(`[data-num="${n}"]`)?.textContent ?? "").trim()]));
}

async function go(mode: "lite" | "pro"): Promise<void> {
  await act(async () => setMode(mode));
  await waitFor(() => expect(document.querySelector(mode === "lite" ? '[data-area="verdict"]' : '[data-area="stats"]')).not.toBeNull(), { timeout: 10000 });
}

async function setCost(cost: number): Promise<void> {
  await act(async () => {
    useSettings.getState().set({ cost_pct: cost });
    runSizeAndRisk(); // no app quem chama é o controlador, a cada mudança de custo
  });
}

beforeAll(() => {
  // movimento reduzido: os números aparecem na hora, sem interpolação
  window.matchMedia = ((q: string) => ({ matches: true, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", Observer);
  vi.stubGlobal("ResizeObserver", Observer);

  // o mesmo estado que a interface recebe do worker, montado com o motor sobre os candles sintéticos
  const tm = timeMachineJob(fx.timemachine.bars as Bar[], { plan, tmNow: plan.entry_time, days: 60, replays: 3000, seed: 19, window: 2, maxDraw: 400 }).data;
  const bars = fx.backtest.random.bars as Bar[];
  const combos = makeGrid(DEFAULT_GRID.anchors, DEFAULT_GRID.ranges, DEFAULT_GRID.stops, DEFAULT_GRID.targets, DEFAULT_GRID.minRanges);
  const gridResult = { combos: evaluateTrades(bars, DEFAULTS.entry_buffer_pct, combos, 0.7, 240, 8, 1.0), candles: bars.length, first: bars[0].t, last: bars[bars.length - 1].t };
  useMarket.setState({ boot: "pronto", universe: [{ symbol: "BTCUSDT", quote_volume: 1e9, change_pct: -1.2 }], prices: { BTCUSDT: 101.7 } });
  useAnalysis.setState({
    history: { status: "ready", symbol: "BTCUSDT", months: 3, done: 1, total: 1, note: "", info: { symbol: "BTCUSDT", months: 3, candles: bars.length, first: bars[0].t, last: bars[bars.length - 1].t, cached: 0, fetched: 0, requests: 0 }, error: null },
    signal: orbSignal([], plan.session_start + 9 * 3600000, DEFAULTS),
    plan,
    planSource: "replay",
    planNote: "sem rompimento (status: expired). Não há plano pra montar.",
    tm: { result: tm, sortedExit: Float64Array.from(tm.exit).sort(), plan },
    tmStatus: "ready",
    tmProgress: 1,
    rules: parseRules(fx.size_risk.rules[0].info, "BTCUSDT"),
    grid: { status: "ready", done: 96, total: 96, result: gridResult, error: null, ms: 12, symbol: "BTCUSDT", months: 3 },
  });
  act(() => runSizeAndRisk());
});

afterEach(() => cleanup());

describe("Lite e Pro com o mesmo estado", () => {
  it("abre no Lite sem carregar a esfera; ela só é pedida quando o Pro é aberto", async () => {
    expect(useMode.getState().mode).toBe("lite");
    render(<App />);
    await waitFor(() => expect(read(["avg_net_r"]).avg_net_r).not.toBe(""));
    expect(document.querySelector(".board")?.getAttribute("data-mode")).toBe("lite");
    expect(document.body.textContent).toContain("somente análise — nenhuma ordem é enviada");
    expect(document.querySelector('[data-area="sphere"]')).toBeNull();
    expect(document.querySelector('[data-area="scan"]')).toBeNull();
    // os replays e os buffers da esfera estão no estado, mas o Lite não pede o módulo three.js
    expect(useAnalysis.getState().tm?.result.sphere).not.toBeNull();
    expect(sceneLoaded).not.toHaveBeenCalled();
    // (a fábrica do módulo roda uma vez, no primeiro import: por isso esta checagem é o primeiro teste do arquivo)
    await go("pro");
    await waitFor(() => expect(sceneLoaded).toHaveBeenCalledTimes(1), { timeout: 10000 });
    expect(document.querySelector('[data-area="sphere"]')).not.toBeNull();
    await go("lite");
    expect(document.querySelector('[data-area="sphere"]')).toBeNull();
  });

  it("os mesmos números nos dois modos, em vários custos, e iguais aos do motor", async () => {
    render(<App />);
    const tm = useAnalysis.getState().tm;
    if (!tm) throw new Error("estado do teste sem Time Machine");
    const r = tm.result;
    const raw: McRaw = { replays: r.replays, seed: r.seed, entry: r.entry, stop: r.stop, target: r.target, exit: r.exit, outcome: r.outcome, len: r.len, pathLen: r.pathLen, paths: null };
    const gridResult = useAnalysis.getState().grid.result;
    if (!gridResult) throw new Error("estado do teste sem grade");
    for (const cost of [0.15, 0, 0.075, 0.2, 0.13]) {
      await go("lite");
      await setCost(cost);
      const lite = read();
      const evenLite = read(["even_r"]).even_r;
      await go("pro");
      const pro = read();
      for (const n of NUMS) {
        expect(lite[n], `${n} vazio no Lite (custo ${cost})`).not.toBe("");
        expect(lite[n], `${n} com custo ${cost}`).toBe(pro[n]);
      }
      // e os dois batem com o motor, calculado aqui à parte
      const c = splitCost(cost);
      const stats = mcCostStats(raw, tm.sortedExit, c);
      const mc = summarizeMc(raw, c);
      const v = gridVerdict(gridResult.combos.map((x) => summarizeCombo(x, c)));
      expect(lite.avg_net_r).toBe(fmt.rr(stats.avg_net_r));
      expect(lite.pct_target).toBe(fmt.pct(mc.pct.target, 1));
      expect(lite.pct_stop).toBe(fmt.pct(mc.pct.stop, 1));
      expect(lite.grid_top).toBe(`${v.topPositive} de ${v.topN}`);
      expect(lite.grid_all).toBe(`${v.allPositive} de ${v.allN}`);
      expect(lite.cost).toBe(fmt.num(cost, 3) + "%");
      expect(evenLite).toBe(fmt.rr(breakevenR(costK(plan.entry, plan.stop), cost / 100)));
    }
  });

  it("trocar de modo preserva par, custo e período, salva a escolha e põe na URL", async () => {
    render(<App />);
    await go("lite");
    await act(async () => useSettings.getState().set({ symbol: "BTCUSDT", cost_pct: 0.1, months: 12 }));
    const before = { ...useSettings.getState() };
    await go("pro");
    expect(new URLSearchParams(window.location.search).get(MODE_PARAM)).toBe("pro");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")).toMatchObject({ modo: "pro", par: "BTCUSDT", custo: 0.1, meses: 12 });
    await go("lite");
    expect(new URLSearchParams(window.location.search).get(MODE_PARAM)).toBe("lite");
    const after = useSettings.getState();
    expect([after.symbol, after.cost_pct, after.months, after.anchor_utc, after.target_r]).toEqual([before.symbol, before.cost_pct, before.months, before.anchor_utc, before.target_r]);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}").modo).toBe("lite");
  });

  it("o seletor é um grupo de opções operável por teclado, com nome para leitor de tela", async () => {
    render(<App />);
    await go("lite");
    const group = document.querySelector('.top__mode [role="radiogroup"]') as HTMLElement;
    expect(group.getAttribute("aria-label")).toMatch(/Modo do painel/);
    const checked = () => (group.querySelector('[aria-checked="true"]') as HTMLElement).textContent;
    expect(checked()).toBe("Lite");
    await act(async () => {
      (group.querySelector('[aria-checked="true"]') as HTMLElement).focus();
      group.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    await waitFor(() => expect(useMode.getState().mode).toBe("pro"));
    await waitFor(() => expect(document.querySelector('[data-area="stats"]')).not.toBeNull());
    expect((document.querySelector('.top__mode [aria-checked="true"]') as HTMLElement).textContent).toBe("Pro");
  });

  it("veredito positivo não vira comemoração no Lite", async () => {
    render(<App />);
    await go("lite");
    // um plano em que a simulação dá positivo: todos os replays batendo no alvo
    const tm = useAnalysis.getState().tm;
    if (!tm) throw new Error("estado do teste sem Time Machine");
    const win = { ...tm.result, exit: new Float64Array(tm.result.replays).fill(tm.result.target), outcome: new Uint8Array(tm.result.replays) };
    await act(async () => {
      useSettings.getState().set({ cost_pct: 0.15 });
      useAnalysis.setState({ tm: { result: win, sortedExit: Float64Array.from(win.exit).sort(), plan } });
    });
    const title = document.querySelector(".lite__title") as HTMLElement;
    expect(title.getAttribute("data-tone")).toBe("mixed");
    expect(title.textContent).toContain("não prova nada");
    expect(document.querySelector(".lite__text--warn")?.textContent).toContain("não é vantagem comprovada");
    // o número continua sendo o do motor, sem maquiagem para cima nem para baixo
    expect(read(["avg_net_r"]).avg_net_r.startsWith("+")).toBe(true);
    await act(async () => useAnalysis.setState({ tm }));
    expect((document.querySelector(".lite__title") as HTMLElement).getAttribute("data-tone")).toBe("neg");
  });
});
