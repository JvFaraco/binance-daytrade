#!/usr/bin/env python3
"""scan.py - scanner de rompimento da faixa inicial nos pares USDT mais líquidos da Binance.

  scan.py universe [--top 40]
  scan.py orb [--top 40] [--now "2026-11-02 14:20"] [--json]
"""
import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import core  # noqa: E402

STABLE = {"USDC", "FDUSD", "TUSD", "USDP", "DAI", "BUSD", "USD1", "AEUR", "EUR", "EURI", "USDE", "XUSD"}


def _change_pct(t):
    """Variação do dia. A versão enxuta (MINI) do ticker não traz o campo pronto."""
    try:
        if t.get("priceChangePercent") not in (None, ""):
            return float(t["priceChangePercent"])
        o, c = float(t["openPrice"]), float(t["lastPrice"])
        return (c - o) / o * 100 if o else 0.0
    except (KeyError, TypeError, ValueError):
        return 0.0


def _looks_stable(t):
    """Preço colado em 1 e quase sem variação no dia: stablecoin, não serve pra rompimento."""
    try:
        return 0.97 <= float(t["lastPrice"]) <= 1.03 and abs(_change_pct(t)) < 0.3
    except (KeyError, TypeError, ValueError):
        return False


def load_tickers(cfg, refresh=False, now=None):
    """Tickers 24h dos pares da moeda de cotação. Versão MINI + gzip, com cache em disco."""
    now = now or core.now_ms()
    path = core.path_in("universe_cache.json")
    cache = None if refresh else core.read_json(path)
    ttl = float(cfg.get("universe_cache_minutes", 30)) * 60000
    if cache and cache.get("quote") == cfg["quote"] and now - cache.get("at", 0) < ttl:
        return cache["tickers"]
    raw = core.market_get("/api/v3/ticker/24hr", {"type": "MINI"})
    keep = [{"symbol": t["symbol"], "quoteVolume": t.get("quoteVolume"), "lastPrice": t.get("lastPrice"),
             "priceChangePercent": _change_pct(t)}
            for t in raw if t.get("symbol", "").endswith(cfg["quote"])]
    core.write_json(path, {"at": now, "quote": cfg["quote"], "tickers": keep})
    return keep


def pick_universe(tickers, cfg, top):
    quote = cfg["quote"]
    out = []
    for t in tickers:
        sym = t.get("symbol", "")
        if not sym.endswith(quote):
            continue
        base = sym[: -len(quote)]
        if not base or base in STABLE:
            continue
        try:
            qv = float(t["quoteVolume"])
        except (KeyError, TypeError, ValueError):
            continue
        if qv < float(cfg["min_quote_volume"]):
            continue
        if base in set(cfg.get("exclude_bases", [])) or _looks_stable(t):
            continue
        out.append({"symbol": sym, "quote_volume": qv, "change_pct": _change_pct(t)})
    out.sort(key=lambda x: -x["quote_volume"])
    return out[:top]


def scan_orb(universe, now_ms, cfg, fetch, workers=10):
    """fetch(symbol) -> candles fechados. Devolve uma lista de resultados por simbolo."""
    def one(u):
        try:
            sig = core.orb_signal(fetch(u["symbol"]), now_ms, cfg)
        except core.ApiError as e:
            return {"symbol": u["symbol"], "status": "error", "error": str(e)}
        r = {"symbol": u["symbol"], "status": sig["status"], "quote_volume": u["quote_volume"]}
        if "range_high" in sig:
            r.update(range_high=sig["range_high"], range_low=sig["range_low"],
                     range_mid=sig["range_mid"], range_pct=sig["range_pct"])
        if sig["trigger"]:
            r["trigger"] = sig["trigger"]
        return r
    with ThreadPoolExecutor(max_workers=workers) as ex:
        return list(ex.map(one, universe))


def filter_hits(results, cfg):
    """Rompimentos que ainda valem: faixa larga o bastante e preço não fugiu."""
    hits = []
    for r in results:
        if r["status"] != "triggered":
            continue
        if r["range_pct"] < float(cfg["min_range_pct"]):
            continue
        if r["trigger"]["pct_over"] > float(cfg["max_chase_pct"]):
            continue
        hits.append(r)
    hits.sort(key=lambda r: -r["trigger"]["time"])
    return hits


def explain_filtered(results, cfg):
    """Rompimentos que o filtro descartou, com o motivo."""
    out = []
    for r in results:
        if r["status"] != "triggered":
            continue
        if r["range_pct"] < float(cfg["min_range_pct"]):
            out.append((r["symbol"], "faixa de %.2f%%, abaixo do mínimo de %.1f%%" % (r["range_pct"], cfg["min_range_pct"])))
        elif r["trigger"]["pct_over"] > float(cfg["max_chase_pct"]):
            out.append((r["symbol"], "já fechou %.2f%% acima do topo (máximo %.1f%%)" % (r["trigger"]["pct_over"], cfg["max_chase_pct"])))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["universe", "orb"])
    ap.add_argument("--top", type=int, default=40)
    ap.add_argument("--now", help='hora UTC fixa, "AAAA-MM-DD HH:MM"')
    ap.add_argument("--config")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--verbose", action="store_true", help="mostra o tempo de cada etapa")
    ap.add_argument("--refresh", action="store_true", help="ignora o cache da lista de pares")
    a = ap.parse_args(argv)
    cfg = core.load_config(a.config)
    try:
        t0 = time.perf_counter()
        uni = pick_universe(load_tickers(cfg, a.refresh), cfg, a.top)
        if a.verbose:
            print("[tempo] lista de pares: %.1fs (%d pares)" % (time.perf_counter() - t0, len(uni)), file=sys.stderr)
        if a.cmd == "universe":
            for u in uni:
                print("%-12s %10.1f M USDT  %+6.2f%%" % (u["symbol"], u["quote_volume"] / 1e6, u["change_pct"]))
            return 0
        now = core.now_ms(a.now)
        def fetch(sym):
            t1 = time.perf_counter()
            bars = core.get_session_bars(sym, now, cfg)
            if a.verbose:
                print("[tempo] candles %s: %.1fs" % (sym, time.perf_counter() - t1), file=sys.stderr)
            return bars
        t0 = time.perf_counter()
        res = scan_orb(uni, now, cfg, fetch)
        if a.verbose:
            print("[tempo] candles de todos: %.1fs" % (time.perf_counter() - t0), file=sys.stderr)
    except core.ApiError as e:
        print("Erro: %s" % e)
        return 1
    hits = filter_hits(res, cfg)
    if a.json:
        print(json.dumps({"now": now, "hits": hits, "counts": _counts(res),
                          "descartados": [{"symbol": a, "motivo": b} for a, b in explain_filtered(res, cfg)],
                          "triggered": [r for r in res if r["status"] == "triggered"]}, indent=2))
        return 0
    tz = cfg["display_tz"]
    c = _counts(res)
    print("Sessão desde %s | %d pares | rompidos %d, esperando %d, formando %d, expirados %d"
          % (core.fmt_ts(core.session_start(now, cfg["anchor_utc"]), tz), len(res),
             c.get("triggered", 0), c.get("waiting", 0), c.get("forming", 0), c.get("expired", 0)))
    if not hits:
        print("Nenhum rompimento válido agora (faixa >= %.1f%% e no máximo %.1f%% acima do topo)."
              % (cfg["min_range_pct"], cfg["max_chase_pct"]))
        for sym, why in explain_filtered(res, cfg):
            print("  descartado %s: %s" % (sym, why))
        return 0
    print("%-12s %-21s %6s %10s %7s  %s" % ("par", "faixa", "larg.%", "fechou", "acima%", "quando"))
    for r in hits:
        t = r["trigger"]
        print("%-12s %-21s %6.2f %10.6g %7.2f  %s" % (
            r["symbol"], "%.6g-%.6g" % (r["range_low"], r["range_high"]), r["range_pct"],
            t["close"], t["pct_over"], core.fmt_ts(t["time"], tz)))
    return 0


def _counts(res):
    c = {}
    for r in res:
        c[r["status"]] = c.get(r["status"], 0) + 1
    return c


if __name__ == "__main__":
    sys.exit(main())
