#!/usr/bin/env python3
"""backtest.py - a regra de rompimento em meses de dados, com custos, treino e teste separados.

  backtest.py run BTCUSDT --months 12                       varre parametros; treino 70%, teste 30%
  backtest.py run BTCUSDT --months 12 --anchors 00:00,13:00 --ranges 30,60 --targets 1.5,2,3
  backtest.py run BTCUSDT --fixture bars.json --now "..."   offline

Pra cada combinacao (ancora, largura da faixa, regra de stop, alvo em R, faixa minima)
roda a MESMA regra do scanner/plan em cada sessao: primeiro candle de 5m fechando
acima do topo da faixa, dentro da janela; stop e alvo; zera no fim. R liquido com
taxa e slippage do config. Mostra as melhores no treino e como elas foram no TESTE,
que e o unico numero que vale alguma coisa.
"""
import argparse
import itertools
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import core  # noqa: E402
import history  # noqa: E402


def sessions_for(bars, anchor, flat_by_hours):
    """Sessões completas (todos os candles de 5m entre a âncora e o horário de zerar)."""
    n = int(float(flat_by_hours) * 12)
    by = {}
    for b in bars:
        s = core.session_start(b["t"], anchor)
        slot = (b["t"] - s) // core.IV
        if slot < n:
            by.setdefault(s, {})[slot] = b
    return [(s, [by[s][i] for i in range(n)]) for s in sorted(by) if len(by[s]) == n]


def run_rule(sessions, params, cfg, stop_rule, target_r, min_range_pct, max_chase_pct):
    """Devolve a lista de R líquidos, um por trade."""
    rs = []
    flat_ms = int(float(params["flat_by_hours"]) * 3600000)
    for s, bars in sessions:
        sig = core.orb_signal(bars, s + flat_ms, params, session=s)
        if sig["status"] != "triggered":
            continue
        if sig["range_pct"] < min_range_pct or sig["trigger"]["pct_over"] > max_chase_pct:
            continue
        t = sig["trigger"]
        entry = t["close"] * (1 + cfg["entry_buffer_pct"] / 100.0)   # limite de compra, como no size.py
        stop = core.stop_price(sig, stop_rule)
        if stop >= entry:
            continue
        target = entry + target_r * (entry - stop)
        exit_p = bars[-1]["c"]
        for b in bars[t["slot"] + 1:]:
            if b["l"] <= stop:
                exit_p = stop
                break
            if b["h"] >= target:
                exit_p = target
                break
        rs.append(core.net_r(entry, exit_p, stop, cfg["fee_pct"], cfg["slippage_pct"]))
    return rs


def summarize(rs):
    if not rs:
        return {"trades": 0, "sum_r": 0.0, "avg_r": None, "win_pct": None, "max_dd_r": 0.0}
    peak = run = dd = 0.0
    for r in rs:
        run += r
        peak = max(peak, run)
        dd = min(dd, run - peak)
    wins = sum(1 for r in rs if r > 0)
    return {"trades": len(rs), "sum_r": round(sum(rs), 2), "avg_r": round(sum(rs) / len(rs), 3),
            "win_pct": round(wins / len(rs) * 100, 1), "max_dd_r": round(dd, 2)}


def grid(anchors, ranges, stops, targets, min_ranges):
    for a, rg, st, tg, mr in itertools.product(anchors, ranges, stops, targets, min_ranges):
        yield {"anchor_utc": a, "range_minutes": rg, "stop_rule": st, "target_r": tg, "min_range_pct": mr}


def evaluate(bars, cfg, combos, split, entry_window, flat_by, max_chase):
    results = []
    cache = {}
    for c in combos:
        key = (c["anchor_utc"], flat_by)
        if key not in cache:
            ss = sessions_for(bars, c["anchor_utc"], flat_by)
            cut = int(len(ss) * split)
            cache[key] = (ss[:cut], ss[cut:])
        train, test = cache[key]
        params = {"anchor_utc": c["anchor_utc"], "range_minutes": c["range_minutes"],
                  "entry_window_minutes": entry_window, "flat_by_hours": flat_by}
        tr = summarize(run_rule(train, params, cfg, c["stop_rule"], c["target_r"], c["min_range_pct"], max_chase))
        te = summarize(run_rule(test, params, cfg, c["stop_rule"], c["target_r"], c["min_range_pct"], max_chase))
        results.append({"params": c, "train": tr, "test": te, "sessions": (len(train), len(test))})
    return results


def fmt(c, r):
    return "%5s %3dmin %-6s %4.1fR faixa>=%.1f%% | %3d trades, R total %+6.2f, R médio %s, acerto %s%%, DD %+.2f" % (
        c["anchor_utc"], c["range_minutes"], c["stop_rule"], c["target_r"], c["min_range_pct"],
        r["trades"], r["sum_r"], "%+.2f" % r["avg_r"] if r["avg_r"] is not None else "  -  ",
        r["win_pct"] if r["win_pct"] is not None else "-", r["max_dd_r"])


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["run"])
    ap.add_argument("symbol")
    ap.add_argument("--months", type=int, default=12)
    ap.add_argument("--split", type=float, default=0.7, help="fração das sessões para treino")
    ap.add_argument("--anchors", default="00:00,13:00")
    ap.add_argument("--ranges", default="30,60")
    ap.add_argument("--stops", default="or-mid,or-low")
    ap.add_argument("--targets", default="1,1.5,2,3")
    ap.add_argument("--min-ranges", default="0.5,1.0,1.5")
    ap.add_argument("--top", type=int, default=5)
    ap.add_argument("--fixture")
    ap.add_argument("--now")
    ap.add_argument("--config")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    cfg = core.load_config(a.config)
    sym = a.symbol.upper()
    now = core.now_ms(a.now)
    try:
        if a.fixture:
            bars = core.closed_only(core.load_klines_file(a.fixture), now)
        else:
            got, missing = history.fetch(sym, a.months, now, log=lambda m: print(m, file=sys.stderr))
            bars = history.load(sym, now, a.months)
    except core.ApiError as e:
        print("Erro: %s" % e)
        return 1
    if len(bars) < 20 * 288:
        print("Erro: só %d candles (menos de 20 dias). Baixe mais meses." % len(bars))
        return 1
    combos = list(grid(a.anchors.split(","), [int(x) for x in a.ranges.split(",")], a.stops.split(","),
                       [float(x) for x in a.targets.split(",")], [float(x) for x in a.min_ranges.split(",")]))
    res = evaluate(bars, cfg, combos, a.split, cfg["entry_window_minutes"], cfg["flat_by_hours"], cfg["max_chase_pct"])
    if a.json:
        print(json.dumps(res, indent=2))
        return 0
    days = (bars[-1]["t"] - bars[0]["t"]) / 86400000
    print("%s | %d candles de 5m (%.0f dias) | %d combinações | custos %.2f%% + %.2f%% por lado" % (
        sym, len(bars), days, len(res), cfg["fee_pct"], cfg["slippage_pct"]))
    ranked = sorted([r for r in res if r["train"]["trades"] >= 20], key=lambda r: -r["train"]["sum_r"])
    if not ranked:
        print("Nenhuma combinação disparou 20 vezes no treino. Pouco dado ou filtros rígidos demais.")
        return 0
    print("\nMelhores no TREINO (%d sessões):" % ranked[0]["sessions"][0])
    for r in ranked[:a.top]:
        print("  " + fmt(r["params"], r["train"]))
    print("\nAs mesmas, no TESTE (%d sessões que elas nunca viram):" % ranked[0]["sessions"][1])
    for r in ranked[:a.top]:
        print("  " + fmt(r["params"], r["test"]))
    pos = sum(1 for r in ranked[:a.top] if r["test"]["sum_r"] > 0)
    print("\n%d de %d melhores do treino seguiram positivas no teste." % (pos, min(a.top, len(ranked))))
    if pos <= len(ranked[:a.top]) // 2:
        print("Isso é o que acontece quando a regra não tem vantagem real depois das taxas: o treino escolhe ruído.")
    allpos = sum(1 for r in res if r["test"]["trades"] >= 10 and r["test"]["sum_r"] > 0)
    alln = sum(1 for r in res if r["test"]["trades"] >= 10)
    print("De todas as combinações com 10+ trades no teste, %d de %d deram R total positivo." % (allpos, alln))
    print("Um backtest em um par e um ano não prova nada sozinho. Repita em outros pares e períodos.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
