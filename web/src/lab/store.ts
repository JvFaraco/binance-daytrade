// Carrega o resultado do laboratório (public/cemiterio.json) uma vez, para o Pro e o Lite.
import { create } from "zustand";
import { type LabData, validateLab } from "./model";

export interface LabState {
  status: "idle" | "loading" | "ready" | "error";
  data: LabData | null;
  error?: string;
}

export const useLab = create<LabState>(() => ({ status: "idle", data: null }));

export function labUrl(): string {
  return `${import.meta.env.BASE_URL ?? "/"}cemiterio.json`;
}

/** Carrega uma vez. Depois de um erro só tenta de novo com `retry` (o botão do painel):
 *  montar o painel de novo não apaga a mensagem de erro. */
export async function loadLab({ retry = false, fetcher = fetch }: { retry?: boolean; fetcher?: typeof fetch } = {}): Promise<void> {
  const st = useLab.getState().status;
  if (st === "loading" || st === "ready" || (st === "error" && !retry)) return;
  useLab.setState({ status: "loading", error: undefined });
  try {
    const res = await fetcher(labUrl(), { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status} ao buscar o resultado`);
    useLab.setState({ status: "ready", data: validateLab(await res.json()) });
  } catch (e) {
    useLab.setState({ status: "error", error: e instanceof Error ? e.message : String(e) });
  }
}
