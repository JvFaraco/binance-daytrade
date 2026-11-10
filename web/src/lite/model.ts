// Texto do modo Lite. Aqui não se calcula nada: as funções recebem os números que o Pro já
// mostra e escolhem como dizê-los a quem nunca operou.
//
// Regra do veredito: resultado negativo aparece primeiro e sem rodeio; resultado positivo nunca
// vira comemoração, porque uma simulação positiva num par não prova vantagem.
import * as fmt from "../app/format";
import type { GridVerdict } from "../engine/backtest";
import type { Signal } from "../engine/core";

export type VerdictTone = "neg" | "mixed";

export interface LiteVerdict {
  tone: VerdictTone;
  title: string;
}

export function liteVerdict(avgNetR: number, costPct: number): LiteVerdict {
  if (avgNetR < 0) {
    return {
      tone: "neg",
      title: costPct > 0 ? "Nas simulações, esta estratégia perdeu dinheiro depois das taxas." : "Nas simulações, esta estratégia perdeu dinheiro mesmo sem taxa nenhuma.",
    };
  }
  return { tone: "mixed", title: "Nesta simulação o resultado médio ficou positivo, mas isso sozinho não prova nada." };
}

/**
 * O mesmo R médio dito como porcentagem do valor arriscado: −0,61R -> "61%".
 * Sai dos dígitos do próprio texto que o Pro mostra, para os dois nunca arredondarem diferente.
 */
export function riskedPct(avgNetR: number): string {
  const digits = fmt.num(Math.abs(avgNetR), 2).replace(/\D/g, "");
  return fmt.int(Number(digits)) + "%";
}

/** A frase do resultado médio. */
export function averageSentence(avgNetR: number): string {
  if (avgNetR === 0) return "na média, não se ganha nem se perde.";
  return `${avgNetR < 0 ? "perde-se" : "ganha-se"} em média ${riskedPct(avgNetR)} do valor arriscado a cada operação.`;
}

/** As duas perguntas que a grade responde, com as contagens do relatório do backtest.py. */
export function variationsSentences(v: GridVerdict): { top: string; all: string } {
  return {
    top: v.topN
      ? `Das ${v.topN} que mais ganharam no período de treino, quantas continuaram positivas no período seguinte:`
      : "Nenhuma variação operou vezes suficientes no treino (20) para entrar na comparação.",
    all: v.allN ? "Das que operaram pelo menos 10 vezes no período de teste, quantas deram lucro:" : "Nenhuma variação operou 10 vezes no período de teste.",
  };
}

/** O estado do sinal de hoje, em frase. Horários já no fuso de exibição. */
export function statusSentence(sig: Signal, hhmm: (ms: number) => string): string {
  switch (sig.status) {
    case "forming":
      return `A faixa inicial de hoje ainda está se formando (fecha às ${hhmm(sig.range_end)}).`;
    case "waiting":
      return `O preço ainda não fechou acima do topo da faixa. A janela de entrada vai até ${hhmm(sig.window_end)}.`;
    case "triggered":
      return `Rompeu: um candle de 5 minutos fechou acima do topo da faixa às ${hhmm(sig.trigger?.time ?? sig.range_end)}.`;
    case "expired":
      return `Hoje não rompeu: a janela de entrada acabou às ${hhmm(Math.min(sig.window_end, sig.flat_by))}.`;
    default:
      return "Faltam candles para montar a faixa de hoje.";
  }
}

export const GLOSSARY: Array<[string, string]> = [
  ["Faixa inicial", "A máxima e a mínima do preço na primeira hora da sessão. Fica desenhada como a caixa âmbar no gráfico."],
  ["Rompimento", "Quando um candle de 5 minutos fecha acima do topo da faixa. É o sinal de compra desta estratégia."],
  ["Stop", "O preço em que a operação é encerrada com perda, para a perda não crescer."],
  ["Alvo", "O preço em que a operação é encerrada com ganho."],
  ["R", "O valor arriscado: a distância entre o preço de entrada e o stop. +1R é ganhar o que se arriscou; −1R é perder isso."],
  ["Custo", "A taxa da corretora mais a pequena diferença de preço na execução, pagas na compra e de novo na venda."],
  ["Treino e teste", "A regra é escolhida olhando só a primeira parte dos dados (treino) e depois conferida na parte que ela nunca viu (teste). O número que vale é o do teste."],
];
