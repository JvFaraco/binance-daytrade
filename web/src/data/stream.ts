// Fluxos públicos de mercado da Binance por WebSocket (sem chave): candles de 5m dos pares do
// scanner e negócios agregados do par escolhido. Uma conexão, inscrições ajustadas em uso.
// Reserva: se o host de dados falhar duas vezes seguidas, tenta stream.binance.com:9443.
import type { Bar } from "../engine/core";

export const WS_HOSTS = ["wss://data-stream.binance.vision", "wss://stream.binance.com:9443"];

export type StreamStatus = "conectando" | "ao vivo" | "reconectando" | "parado";

export interface Trade {
  /** hora do negócio (ms, relógio da Binance) */
  t: number;
  price: number;
  qty: number;
  /** true = o agressor vendeu (comprador era o maker) */
  sell: boolean;
}

export interface StreamHandlers {
  onKline: (symbol: string, bar: Bar, closed: boolean) => void;
  onTrade: (symbol: string, trade: Trade) => void;
  onStatus: (status: StreamStatus, host: string) => void;
  /** atraso entre a hora do evento na Binance e a chegada aqui, em ms */
  onLatency: (ms: number) => void;
}

interface KlinePayload {
  e: "kline";
  E: number;
  s: string;
  k: { t: number; o: string; h: string; l: string; c: string; q: string; x: boolean };
}

interface AggTradePayload {
  e: "aggTrade";
  E: number;
  s: string;
  p: string;
  q: string;
  T: number;
  m: boolean;
}

export class MarketStream {
  private ws: WebSocket | null = null;
  private want = new Set<string>();
  private have = new Set<string>();
  private hostIdx = 0;
  private fails = 0;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private msgId = 1;
  private lat: number[] = [];
  private latTimer: ReturnType<typeof setInterval> | null = null;
  /** relógio da Binance menos o local (vem de /api/v3/time) */
  clockOffset = 0;
  messages = 0;

  constructor(private h: StreamHandlers) {}

  /** Define o conjunto de fluxos desejado (ex.: "btcusdt@kline_5m"). */
  setStreams(streams: Iterable<string>): void {
    this.want = new Set(streams);
    if (!this.ws && !this.retry && !this.stopped) this.connect();
    else this.sync();
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.latTimer) clearInterval(this.latTimer);
    this.retry = null;
    this.ws?.close();
    this.ws = null;
    this.h.onStatus("parado", WS_HOSTS[this.hostIdx]);
  }

  private connect(): void {
    const host = WS_HOSTS[this.hostIdx];
    this.h.onStatus(this.fails ? "reconectando" : "conectando", host);
    let ws: WebSocket;
    try {
      ws = new WebSocket(host + "/ws");
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.have = new Set();
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.fails = 0;
      this.h.onStatus("ao vivo", host);
      this.sync();
    };
    ws.onmessage = (ev) => this.onMessage(ev.data as string);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.stopped) this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
    if (!this.latTimer) {
      this.latTimer = setInterval(() => {
        if (!this.lat.length) return;
        const s = this.lat.slice().sort((a, b) => a - b);
        this.lat = [];
        this.h.onLatency(s[Math.floor(s.length / 2)]);
      }, 1000);
    }
  }

  private scheduleReconnect(): void {
    this.fails++;
    if (this.fails % 2 === 0) this.hostIdx = (this.hostIdx + 1) % WS_HOSTS.length;
    const wait = Math.min(30000, 1000 * 2 ** Math.min(this.fails - 1, 5));
    this.h.onStatus("reconectando", WS_HOSTS[this.hostIdx]);
    this.retry = setTimeout(() => {
      this.retry = null;
      if (!this.stopped) this.connect();
    }, wait);
  }

  /** Envia só a diferença entre o que está inscrito e o que é desejado. */
  private sync(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const add = [...this.want].filter((s) => !this.have.has(s));
    const del = [...this.have].filter((s) => !this.want.has(s));
    // a Binance aceita poucas mensagens de controle por segundo: um pedido por operação
    if (del.length) ws.send(JSON.stringify({ method: "UNSUBSCRIBE", params: del, id: this.msgId++ }));
    if (add.length) ws.send(JSON.stringify({ method: "SUBSCRIBE", params: add, id: this.msgId++ }));
    this.have = new Set(this.want);
  }

  private onMessage(raw: string): void {
    let m: KlinePayload | AggTradePayload | { result?: unknown; id?: number };
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!("e" in m)) return;
    this.messages++;
    this.lat.push(Date.now() + this.clockOffset - m.E);
    if (m.e === "kline") {
      const k = m.k;
      this.h.onKline(m.s, { t: k.t, o: Number(k.o), h: Number(k.h), l: Number(k.l), c: Number(k.c), v: Number(k.q) }, k.x);
    } else if (m.e === "aggTrade") {
      this.h.onTrade(m.s, { t: m.T, price: Number(m.p), qty: Number(m.q), sell: m.m });
    }
  }
}
