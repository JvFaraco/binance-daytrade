import { create } from "zustand";

/** O fio destacado na esfera (sob o mouse ou escolhido pelo teclado). */
export interface HoverInfo {
  /** índice entre os fios desenhados */
  drawn: number;
  /** número do replay (0..replays-1) */
  replay: number;
  /** posição do ponteiro dentro do painel, em px; null quando veio do teclado */
  x: number | null;
  y: number | null;
}

export const useSphereHover = create<{ hover: HoverInfo | null }>(() => ({ hover: null }));
