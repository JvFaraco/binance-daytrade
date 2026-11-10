// Guarda de desempenho: os 10.000 replays com caminhos gravados precisam caber folgados num worker.
import { expect, it } from "vitest";
import type { Bar } from "../src/engine";
import * as tm from "../src/engine/timemachine";
import { fixture } from "./helpers";

it("10.000 replays com caminhos em bem menos de 2 s", () => {
  const t = fixture().timemachine;
  const sessions = tm.fullSessions(t.bars as Bar[], t.plan.params, t.before);
  const t0 = performance.now();
  const raw = tm.runMcRaw(t.plan, sessions, 10000, 19, 2, { recordPaths: true });
  const ms = performance.now() - t0;
  expect(raw.paths?.length).toBe(10000 * raw.pathLen);
  expect(ms).toBeLessThan(2000);
  console.log(`10.000 replays + caminhos: ${ms.toFixed(0)} ms`);
});
