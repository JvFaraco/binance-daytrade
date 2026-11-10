// O trabalho do Time Machine como função pura (sem worker nem rede): o worker chama isto,
// e os testes também, para montar o mesmo estado que a interface recebe.
import { type Bar, DAY, TraderError, closedOnly } from "../engine/core";
import type { Plan } from "../engine/plan";
import { fullSessions, historyTrades, runMcRaw } from "../engine/timemachine";
import { buildSphereBuffers } from "../sphere/geometry";
import type { Progress, TimeMachineResult } from "./protocol";

export interface TimeMachineJob {
  plan: Plan;
  tmNow: number;
  days: number;
  replays: number;
  seed: number;
  window: number;
  /** quantos fios desenhar; 0 = não montar a esfera (modo Lite) */
  maxDraw: number;
}

export function timeMachineJob(allBars: ReadonlyArray<Bar>, req: TimeMachineJob, progress: (p: Progress) => void = () => {}): { data: TimeMachineResult; transfer: Transferable[] } {
  const { plan } = req;
  const from = req.tmNow - req.days * DAY;
  const bars = closedOnly(
    allBars.filter((b) => b.t >= from),
    req.tmNow,
  );
  const sessions = fullSessions(bars, plan.params, plan.session_start);
  if (sessions.length < 20) {
    throw new TraderError(`só ${sessions.length} sessões completas no histórico (mínimo 20). Aumente o período.`);
  }
  const withSphere = req.maxDraw > 0;
  const t0 = performance.now();
  // os caminhos só são gravados quando a esfera vai ser desenhada; os sorteios e os resultados são os mesmos
  const raw = runMcRaw(plan, sessions, req.replays, req.seed, req.window, {
    recordPaths: withSphere,
    progressEvery: 1000,
    onProgress: (done, total) => progress({ done, total, note: "replays" }),
  });
  const mcMs = performance.now() - t0;
  const sphere = withSphere ? buildSphereBuffers(raw, plan.target_r, req.maxDraw) : null;
  const data: TimeMachineResult = {
    sessions: sessions.length,
    from,
    to: req.tmNow,
    replays: raw.replays,
    seed: raw.seed,
    window: req.window,
    entry: raw.entry,
    stop: raw.stop,
    target: raw.target,
    exit: raw.exit,
    outcome: raw.outcome,
    len: raw.len,
    pathLen: raw.pathLen,
    history: historyTrades(plan, sessions),
    sphere,
    mcMs,
  };
  const transfer: Transferable[] = [raw.exit.buffer, raw.outcome.buffer, raw.len.buffer];
  if (sphere) transfer.push(sphere.points.buffer, sphere.index.buffer, sphere.pathReplay.buffer, sphere.pathStart.buffer, sphere.pathCount.buffer);
  return { data, transfer };
}
