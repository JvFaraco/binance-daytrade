// Lado da interface do worker do motor: uma promessa por pedido, com progresso e tempo gasto.
import { ApiError, TraderError } from "../engine/core";
import type { RestTelemetry } from "./rest";
import type { Progress, Request, ResponseMap, WorkerIn, WorkerOut } from "../workers/protocol";

interface Pending {
  resolve: (v: { data: unknown; ms: number }) => void;
  reject: (e: Error) => void;
  onProgress?: (p: Progress) => void;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();
let telemetryListener: (t: RestTelemetry) => void = () => {};

function ensure(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("../workers/engine.worker.ts", import.meta.url), { type: "module", name: "motor" });
  worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
    const m = ev.data;
    if (m.kind === "telemetry") {
      telemetryListener(m.rest);
      return;
    }
    const p = pending.get(m.id);
    if (!p) return;
    if (m.kind === "progress") {
      p.onProgress?.(m.progress);
      return;
    }
    pending.delete(m.id);
    if (m.kind === "result") p.resolve({ data: m.data, ms: m.ms });
    else if (m.name === "TraderError") p.reject(new TraderError(m.message));
    else if (m.name === "ApiError") p.reject(new ApiError(m.message, m.status));
    else p.reject(new Error(m.message));
  };
  worker.onerror = (ev) => {
    const err = new Error("o worker do motor falhou: " + (ev.message || "erro desconhecido"));
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  return worker;
}

export function onRestTelemetry(fn: (t: RestTelemetry) => void): void {
  telemetryListener = fn;
}

/** Envia um pedido ao worker. Resolve com o dado e o tempo que o worker levou (ms). */
export function engine<K extends Request["type"]>(
  req: Extract<Request, { type: K }>,
  onProgress?: (p: Progress) => void,
): Promise<{ data: ResponseMap[K]; ms: number }> {
  const w = ensure();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: resolve as Pending["resolve"], reject, onProgress });
    w.postMessage({ id, req } satisfies WorkerIn);
  });
}
