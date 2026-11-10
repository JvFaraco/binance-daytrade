// O que fica salvo no navegador entre visitas: modo do painel, par, custo e período.
// Só preferências de exibição; nenhuma chave, nenhum dado de conta (o painel não tem nenhum dos dois).
export const STORAGE_KEY = "binance-daytrade:preferencias:v1";

export interface Saved {
  modo?: string;
  par?: string;
  custo?: number;
  meses?: number;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // navegador com armazenamento bloqueado
  }
}

/** Lê o que está salvo. Qualquer coisa ilegível ou com formato estranho vira "nada salvo". */
export function loadSaved(): Saved {
  const s = storage();
  if (!s) return {};
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return {};
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object") return {};
    const o = v as Record<string, unknown>;
    return {
      modo: typeof o.modo === "string" ? o.modo : undefined,
      par: typeof o.par === "string" && /^[A-Z0-9]{5,20}$/.test(o.par) ? o.par : undefined,
      custo: typeof o.custo === "number" && Number.isFinite(o.custo) ? o.custo : undefined,
      meses: typeof o.meses === "number" && Number.isInteger(o.meses) ? o.meses : undefined,
    };
  } catch {
    return {};
  }
}

/** Grava por cima só os campos informados. */
export function save(patch: Saved): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify({ ...loadSaved(), ...patch }));
  } catch {
    // cota cheia ou armazenamento bloqueado: a preferência só vale nesta visita
  }
}
