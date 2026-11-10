// Antes dos testes: o Python do repositório exporta os candles sintéticos de tests/test_all.py
// e as saídas do motor original. Os testes de paridade comparam o TypeScript contra esse arquivo.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE = resolve(here, "tests/.fixtures/parity.json");

export default function setup() {
  mkdirSync(dirname(FIXTURE), { recursive: true });
  const py = process.env.PYTHON || "python3";
  try {
    execFileSync(py, [resolve(here, "tools/export_parity.py"), FIXTURE], { stdio: ["ignore", "inherit", "inherit"] });
  } catch (e) {
    if (!existsSync(FIXTURE)) {
      throw new Error("Os testes de paridade precisam de python3 para gerar " + FIXTURE, { cause: e });
    }
    throw e;
  }
}
