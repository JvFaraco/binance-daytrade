// Geometria da esfera do Time Machine: cada replay vira um fio.
//
//   tempo da sessão  -> longitude (o fio avança em volta da esfera)
//   R bruto do ponto -> latitude (equador = entrada, norte = ganho, sul = perda)
//   R líquido final  -> cor (calculada no shader a partir do R bruto de saída e do custo)
//
// O mesmo mapeamento existe em GLSL (SphereThreads) e aqui em JS (para achar o fio sob o mouse).
import { type McRaw } from "../engine/timemachine";

export const SWEEP = Math.PI * 1.15; // quanto de longitude a sessão inteira percorre
export const LAT_MAX = (70 * Math.PI) / 180;
export const GOLDEN = Math.PI * (3 - Math.sqrt(5));
/** floats por ponto: tau, R bruto, fase do fio, progresso no fio, R bruto de saída */
export const POINT_STRIDE = 5;

export interface SphereBuffers {
  /** POINT_STRIDE floats por ponto */
  points: Float32Array;
  /** pares de índices (LineSegments) */
  index: Uint32Array;
  /** por fio desenhado: índice do replay, primeiro ponto, nº de pontos */
  pathReplay: Uint32Array;
  pathStart: Uint32Array;
  pathCount: Uint16Array;
  /** fios desenhados e replays simulados */
  drawn: number;
  replays: number;
  pathLen: number;
  /** escala de latitude: R que cai em LAT_MAX */
  rScale: number;
}

/**
 * R bruto que empata depois dos custos: net = g(1-c) - cK = 0, com c = custo por lado (fração)
 * e K = 2 * entrada / risco. É o anel "empate" da esfera e a frase de custo do modo Lite.
 */
export function breakevenR(k: number, costFraction: number): number {
  return (costFraction * k) / (1 - costFraction);
}

/** K do plano: transforma custo percentual em R. */
export function costK(entry: number, stop: number): number {
  return (2 * entry) / (entry - stop);
}

export function latitudeOf(r: number, rScale: number): number {
  return Math.max(-1.25, Math.min(1.25, r / rScale)) * LAT_MAX;
}

/** Posição unitária de um ponto (tau, R, fase). */
export function pointOnSphere(tau: number, r: number, phase: number, rScale: number, out: Float32Array, o: number): void {
  const lon = phase + tau * SWEEP;
  const lat = latitudeOf(r, rScale);
  const cl = Math.cos(lat);
  out[o] = cl * Math.cos(lon);
  out[o + 1] = Math.sin(lat);
  out[o + 2] = cl * Math.sin(lon);
}

/**
 * Monta os buffers a partir dos caminhos dos replays. `maxDraw` limita quantos fios são
 * desenhados (um a cada k replays); as estatísticas continuam vindo de todos.
 */
export function buildSphereBuffers(raw: McRaw, targetR: number, maxDraw: number): SphereBuffers {
  const paths = raw.paths;
  if (!paths) throw new Error("replays sem caminhos gravados");
  const { replays, pathLen } = raw;
  const step = Math.max(1, Math.ceil(replays / Math.max(1, maxDraw)));
  const drawn = Math.ceil(replays / step);
  let nPoints = 0;
  let nSeg = 0;
  for (let i = 0; i < replays; i += step) {
    nPoints += raw.len[i];
    nSeg += raw.len[i] - 1;
  }
  const points = new Float32Array(nPoints * POINT_STRIDE);
  const index = new Uint32Array(nSeg * 2);
  const pathReplay = new Uint32Array(drawn);
  const pathStart = new Uint32Array(drawn);
  const pathCount = new Uint16Array(drawn);
  const risk = raw.entry - raw.stop;
  const denom = Math.max(1, pathLen - 1);
  let p = 0;
  let s = 0;
  let d = 0;
  for (let i = 0; i < replays; i += step, d++) {
    const n = raw.len[i];
    const phase = (i * GOLDEN) % (Math.PI * 2);
    const exitR = (raw.exit[i] - raw.entry) / risk;
    pathReplay[d] = i;
    pathStart[d] = p;
    pathCount[d] = n;
    const base = i * pathLen;
    for (let j = 0; j < n; j++, p++) {
      const k = p * POINT_STRIDE;
      points[k] = j / denom;
      points[k + 1] = paths[base + j];
      points[k + 2] = phase;
      points[k + 3] = n > 1 ? j / (n - 1) : 1;
      points[k + 4] = exitR;
      if (j > 0) {
        index[s++] = p - 1;
        index[s++] = p;
      }
    }
  }
  return { points, index, pathReplay, pathStart, pathCount, drawn, replays, pathLen, rScale: Math.max(1, targetR) };
}
