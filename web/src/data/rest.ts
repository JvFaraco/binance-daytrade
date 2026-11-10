// Cliente REST dos endpoints PÚBLICOS da Binance (sem chave, sem assinatura).
// Só GET em /api/v3/{klines,ticker/24hr,exchangeInfo,avgPrice,time}. Não existe aqui nenhum
// caminho para enviar ordem: o painel é só análise.
//
// Respeito ao limite por IP (6000 de peso por minuto), como o core.py:
//  - cada pedido declara o peso; a soma dos últimos 60 s é acompanhada localmente
//  - X-MBX-USED-WEIGHT-1M é lido quando o navegador expõe o cabeçalho (via CORS normalmente não expõe)
//  - 429: espera o Retry-After (ou 2 s, dobrando) e tenta de novo, no máximo 2 vezes
//  - 418: IP banido. Não insiste; tudo falha rápido até o prazo passar
import { ApiError } from "../engine/core";

export const DATA_HOST = "https://data-api.binance.vision";
export const WEIGHT_LIMIT_1M = 6000;
export const WEIGHT_PACE_PCT = 70;

export interface RestTelemetry {
  /** peso usado no último minuto */
  weight1m: number;
  /** "cabeçalho" quando veio de X-MBX-USED-WEIGHT-1M; "estimado" quando é a soma local */
  weightSource: "cabeçalho" | "estimado";
  requests: number;
  inFlight: number;
  /** até quando a API pediu para esperar (429) ou baniu (418); 0 = livre */
  limitedUntil: number;
  banned: boolean;
  lastError: string | null;
  lastLatencyMs: number | null;
}

type Params = Record<string, string | number | undefined>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class BinanceRest {
  private window: Array<[number, number]> = [];
  private headerWeight: number | null = null;
  private headerAt = 0;
  private active = 0;
  private waiters: Array<() => void> = [];
  private tel: RestTelemetry = { weight1m: 0, weightSource: "estimado", requests: 0, inFlight: 0, limitedUntil: 0, banned: false, lastError: null, lastLatencyMs: null };

  constructor(
    private onTelemetry: (t: RestTelemetry) => void = () => {},
    private host = DATA_HOST,
    private concurrency = 6,
  ) {}

  telemetry(): RestTelemetry {
    return { ...this.tel };
  }

  private estimated(now: number): number {
    while (this.window.length && now - this.window[0][0] > 60000) this.window.shift();
    let s = 0;
    for (const [, w] of this.window) s += w;
    return s;
  }

  private publish(): void {
    const now = Date.now();
    const est = this.estimated(now);
    if (this.headerWeight !== null && now - this.headerAt < 60000) {
      this.tel.weight1m = this.headerWeight;
      this.tel.weightSource = "cabeçalho";
    } else {
      this.tel.weight1m = est;
      this.tel.weightSource = "estimado";
    }
    this.tel.inFlight = this.active;
    if (this.tel.limitedUntil && now >= this.tel.limitedUntil) {
      this.tel.limitedUntil = 0;
      this.tel.banned = false;
    }
    this.onTelemetry({ ...this.tel });
  }

  private async acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++;
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
  }

  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }

  /** GET público. `weight` é o peso documentado do endpoint. */
  async get<T>(path: string, params: Params = {}, weight = 1, retries = 2): Promise<T> {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    const url = this.host + path + (qs ? "?" + qs : "");
    await this.acquire();
    try {
      let last: unknown = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        const now = Date.now();
        if (this.tel.limitedUntil > now) {
          if (this.tel.banned) throw new ApiError("HTTP 418: a Binance baniu este IP por excesso de pedidos. O painel parou de pedir e espera o prazo.", 418);
          await sleep(this.tel.limitedUntil - now);
        }
        // vai devagar perto do limite, como o aviso de 70% do core.py
        while (this.estimated(Date.now()) + weight > (WEIGHT_LIMIT_1M * WEIGHT_PACE_PCT) / 100) await sleep(1000);
        this.window.push([Date.now(), weight]);
        this.tel.requests++;
        const t0 = performance.now();
        let res: Response;
        try {
          res = await fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" });
        } catch (e) {
          last = e;
          this.tel.lastError = "falha de rede";
          this.publish();
          if (attempt < retries) {
            await sleep(1000 * (1 + attempt));
            continue;
          }
          break;
        }
        this.tel.lastLatencyMs = performance.now() - t0;
        const hw = res.headers.get("x-mbx-used-weight-1m");
        if (hw !== null && !Number.isNaN(Number(hw))) {
          this.headerWeight = Number(hw);
          this.headerAt = Date.now();
        }
        if (res.status === 418 || res.status === 429) {
          const ra = Number(res.headers.get("retry-after"));
          const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra, res.status === 418 ? 3600 : 30) : res.status === 418 ? 120 : 2 * (attempt + 1);
          this.tel.limitedUntil = Date.now() + wait * 1000;
          this.tel.banned = res.status === 418;
          this.tel.lastError = `HTTP ${res.status}`;
          this.publish();
          if (res.status === 418) {
            throw new ApiError(`HTTP 418: a Binance baniu este IP por ${wait}s por excesso de pedidos. Pare e espere.`, 418, wait);
          }
          if (attempt < retries) continue; // o laço espera limitedUntil
          throw new ApiError(`HTTP 429 em ${path}: a Binance pediu para esperar ${wait}s`, 429, wait);
        }
        if (!res.ok) {
          const body = (await res.text()).slice(0, 300);
          this.tel.lastError = `HTTP ${res.status}`;
          this.publish();
          throw new ApiError(`HTTP ${res.status} em ${path}: ${body}`, res.status);
        }
        const json = (await res.json()) as T;
        this.tel.lastError = null;
        this.publish();
        return json;
      }
      throw new ApiError(`sem acesso a ${this.host}${path}: ${String(last)}`);
    } finally {
      this.release();
      this.publish();
    }
  }
}
