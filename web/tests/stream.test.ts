// O fluxo ao vivo com um WebSocket falso e relógio controlado: inscrições, queda, silêncio e retomada.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketStream, SILENCE_MS, type StreamStatus, WS_HOSTS } from "../src/data/stream";

class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Array<{ method: string; params: string[] }> = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  kline(symbol: string, t: number, closed: boolean) {
    this.onmessage?.({ data: JSON.stringify({ e: "kline", E: Date.now(), s: symbol, k: { t, o: "1", h: "2", l: "0.5", c: "1.5", q: "10", x: closed } }) });
  }
}

describe("MarketStream", () => {
  let statuses: StreamStatus[];
  let resumes: number;
  let klines: Array<[string, number, boolean]>;
  let stream: MarketStream;
  const last = () => FakeSocket.all[FakeSocket.all.length - 1];

  beforeEach(() => {
    vi.useFakeTimers();
    FakeSocket.all = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    statuses = [];
    resumes = 0;
    klines = [];
    stream = new MarketStream({
      onKline: (s, b, closed) => klines.push([s, b.c, closed]),
      onTrade: () => {},
      onStatus: (s) => statuses.push(s),
      onLatency: () => {},
      onResume: () => resumes++,
    });
  });

  afterEach(() => {
    stream.stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("conecta no host público de dados e só envia a diferença das inscrições", () => {
    stream.setStreams(["btcusdt@kline_5m", "ethusdt@kline_5m"]);
    expect(last().url).toBe(WS_HOSTS[0] + "/ws");
    last().open();
    expect(statuses).toEqual(["conectando", "ao vivo"]);
    expect(last().sent).toEqual([{ method: "SUBSCRIBE", params: ["btcusdt@kline_5m", "ethusdt@kline_5m"], id: 1 }]);
    stream.setStreams(["btcusdt@kline_5m", "solusdt@aggTrade"]);
    expect(last().sent.slice(1).map((m) => [m.method, m.params])).toEqual([
      ["UNSUBSCRIBE", ["ethusdt@kline_5m"]],
      ["SUBSCRIBE", ["solusdt@aggTrade"]],
    ]);
    last().kline("BTCUSDT", 300000, true);
    expect(klines).toEqual([["BTCUSDT", 1.5, true]]);
    expect(resumes).toBe(0);
  });

  it("silêncio de 20 s com a conexão aberta: deixa de dizer 'ao vivo', reconecta e avisa da retomada", () => {
    stream.setStreams(["btcusdt@kline_5m"]);
    const first = last();
    first.open();
    // mensagens chegando: nada acontece
    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(1000);
      first.kline("BTCUSDT", 0, false);
    }
    expect(statuses[statuses.length - 1]).toBe("ao vivo");
    expect(FakeSocket.all).toHaveLength(1);
    // o servidor para de entregar sem fechar
    vi.advanceTimersByTime(SILENCE_MS + 1500);
    expect(statuses[statuses.length - 1]).toBe("reconectando");
    vi.advanceTimersByTime(1500);
    expect(FakeSocket.all).toHaveLength(2);
    expect(resumes).toBe(0);
    last().open();
    expect(statuses[statuses.length - 1]).toBe("ao vivo");
    expect(resumes).toBe(1);
    // reinscreve tudo na conexão nova
    expect(last().sent).toEqual([{ method: "SUBSCRIBE", params: ["btcusdt@kline_5m"], id: expect.any(Number) }]);
    // mensagem atrasada da conexão abandonada é ignorada
    first.kline("BTCUSDT", 0, true);
    expect(klines.filter((k) => k[2])).toHaveLength(0);
  });

  it("conexão fechada pelo servidor: espera crescente e host reserva depois de duas falhas", () => {
    stream.setStreams(["btcusdt@kline_5m"]);
    last().open();
    last().close();
    expect(statuses[statuses.length - 1]).toBe("reconectando");
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(2);
    expect(last().url).toBe(WS_HOSTS[0] + "/ws");
    last().close(); // segunda falha seguida: troca de host
    vi.advanceTimersByTime(2000);
    expect(FakeSocket.all).toHaveLength(3);
    expect(last().url).toBe(WS_HOSTS[1] + "/ws");
    last().open();
    expect(resumes).toBe(1);
    expect(statuses[statuses.length - 1]).toBe("ao vivo");
  });

  it("parado não reconecta", () => {
    stream.setStreams(["btcusdt@kline_5m"]);
    last().open();
    stream.stop();
    vi.advanceTimersByTime(60000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(statuses[statuses.length - 1]).toBe("parado");
  });
});
