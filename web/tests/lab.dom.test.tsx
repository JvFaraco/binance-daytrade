// @vitest-environment jsdom
// O Cemitério renderizado de verdade: o controle de custo troca a linha pesquisada e os números
// da tela acompanham o que o lab.py gravou para aquele custo.
import { act, cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { costIndex, survivors, validateLab } from "../src/lab/model";
import { loadLab, useLab } from "../src/lab/store";
import { CemiterioPanel } from "../src/panels/CemiterioPanel";
import { DEFAULT_COST, useSettings } from "../src/state/settings";

const here = dirname(fileURLToPath(import.meta.url));
const data = validateLab(JSON.parse(readFileSync(resolve(here, "../public/cemiterio.json"), "utf8")));

function beatsOf(key: string): string {
  return (document.querySelector(`[data-key="${key}"] [data-col="beats"]`)?.textContent ?? "").trim();
}

describe("Cemitério de estratégias", () => {
  beforeEach(() => {
    useLab.setState({ status: "ready", data, error: undefined });
    useSettings.setState({ cost_pct: DEFAULT_COST });
  });
  afterEach(() => cleanup());

  it("mostra quantas sobrevivem no custo do controle e uma linha por estratégia", () => {
    render(<CemiterioPanel />);
    const ci = costIndex(data, DEFAULT_COST);
    expect(document.querySelector('[data-num="lab_survivors"]')?.textContent).toBe(`${survivors(data, ci)} de ${data.strategies.length}`);
    expect(document.querySelectorAll(".cem__row").length).toBe(data.strategies.length);
    // a cópia do controle tem id próprio e não repete o data-num do controle principal
    expect(document.getElementById("cost-range-cem")).not.toBeNull();
    expect(document.querySelector('[data-num="cost"]')).toBeNull();
  });

  it("arrastar o custo troca os números para a linha pesquisada naquele custo", () => {
    render(<CemiterioPanel />);
    const dt = data.strategies.find((s) => s.key === "dt")!;
    const expected = (c: number) => `${Object.values(dt.by_pair).filter((p) => p.at[costIndex(data, c)][6] === 1).length}/5`;
    expect(beatsOf("dt")).toBe(expected(DEFAULT_COST));
    act(() => useSettings.setState({ cost_pct: 0 }));
    expect(beatsOf("dt")).toBe(expected(0));
    act(() => useSettings.setState({ cost_pct: 0.2 }));
    expect(beatsOf("dt")).toBe(expected(0.2));
    expect(expected(0)).not.toBe(expected(0.2)); // o exemplo só vale se a taxa muda alguma coisa
  });

  it("estado de erro desenhado, sem número", () => {
    useLab.setState({ status: "error", data: null, error: "HTTP 404 ao buscar o resultado" });
    render(<CemiterioPanel />);
    expect(document.body.textContent).toContain("O resultado da pesquisa não carregou");
    expect(document.body.textContent).toContain("HTTP 404");
    expect(document.querySelector('[data-num="lab_survivors"]')).toBeNull();
  });

  it("tentar de novo carrega o arquivo e mostra o resultado", async () => {
    useLab.setState({ status: "error", data: null, error: "falhou" });
    const calls: string[] = [];
    const fetcher = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(data), { status: 200 });
    }) as unknown as typeof fetch;
    await loadLab({ fetcher });
    expect(calls).toEqual([]); // sem pedir, um erro não vira nova tentativa
    await loadLab({ retry: true, fetcher });
    expect(calls).toEqual(["/cemiterio.json"]);
    expect(useLab.getState().status).toBe("ready");
  });
});
