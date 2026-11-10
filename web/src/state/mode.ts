// Modo do painel: Lite (para quem nunca operou) ou Pro (o painel completo).
// Os dois leem as mesmas stores e o mesmo motor; o modo só escolhe o que mostrar e como dizer.
import { create } from "zustand";
import { loadSaved, save } from "./persist";

export type Mode = "lite" | "pro";
export const MODE_PARAM = "modo";
/** Quem chega pelo link público sem preferência nenhuma vê o Lite. */
export const DEFAULT_MODE: Mode = "lite";

export function parseMode(v: string | null | undefined): Mode | null {
  const s = (v ?? "").trim().toLowerCase();
  return s === "lite" || s === "pro" ? s : null;
}

/** A URL (?modo=lite) vence o valor salvo, que vence o padrão. */
function modeFromUrl(search: string): Mode | null {
  try {
    return parseMode(new URLSearchParams(search).get(MODE_PARAM));
  } catch {
    return null;
  }
}

/** A URL (?modo=lite) vence o valor salvo, que vence o padrão. */
export function resolveMode(search: string, saved: string | null | undefined): Mode {
  return modeFromUrl(search) ?? parseMode(saved) ?? DEFAULT_MODE;
}

function initialMode(): Mode {
  const search = typeof window === "undefined" ? "" : window.location.search;
  return resolveMode(search, loadSaved().modo);
}

export const useMode = create<{ mode: Mode }>(() => ({ mode: initialMode() }));

/** Troca o modo, salva a escolha e põe na URL, para o link já abrir no modo certo. */
export function setMode(mode: Mode): void {
  if (useMode.getState().mode === mode) return;
  useMode.setState({ mode });
  save({ modo: mode });
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    url.searchParams.set(MODE_PARAM, mode);
    window.history.replaceState(window.history.state, "", url);
  } catch {
    // sem History API: o modo vale mesmo assim
  }
}
