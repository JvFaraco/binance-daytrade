// Texto do modo Lite. Aqui não se calcula nada: as funções recebem os números que o Pro já
// mostra e escolhem como dizê-los a quem nunca operou, com o mínimo de palavras.
//
// Regra do veredito: resultado negativo aparece primeiro e sem rodeio; resultado positivo nunca
// vira comemoração, porque uma simulação positiva num par não prova vantagem.
import * as fmt from "../app/format";

export type VerdictTone = "neg" | "mixed";

export interface LiteVerdict {
  tone: VerdictTone;
  title: string;
}

export function liteVerdict(avgNetR: number, costPct: number): LiteVerdict {
  if (avgNetR < 0) {
    return { tone: "neg", title: costPct > 0 ? "Perdeu dinheiro depois das taxas." : "Perdeu dinheiro mesmo sem taxa nenhuma." };
  }
  return { tone: "mixed", title: "Deu positivo nesta simulação. Isso sozinho não prova nada." };
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
  if (avgNetR === 0) return "na média, não ganha nem perde";
  return `em média, ${avgNetR < 0 ? "perde" : "ganha"} ${riskedPct(avgNetR)} do valor arriscado em cada operação`;
}
