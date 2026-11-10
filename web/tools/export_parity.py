#!/usr/bin/env python3
"""export_parity.py - exporta candles sintéticos e as saídas do motor Python para JSON.

  python3 web/tools/export_parity.py SAIDA.json

Os candles vêm dos geradores de tests/test_all.py (make_bars, session_with_breakout,
TestTimeMachine.history, TestResearch.synth). Cada caso guarda a entrada e o que o Python
devolveu; os testes Vitest de web/tests/ exigem o mesmo resultado do porte em TypeScript.

Só lê e chama o motor: não muda nada em scripts/. broker.py não é exercitado aqui.
"""
import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
sys.path.insert(0, os.path.join(ROOT, "tests"))

import core  # noqa: E402
import scan  # noqa: E402
import plan as planmod  # noqa: E402
import timemachine  # noqa: E402
import size  # noqa: E402
import risk  # noqa: E402
import backtest  # noqa: E402
import research  # noqa: E402
import test_all as T  # noqa: E402

IV = core.IV
CFG = core.load_config("/nonexistent.json")
S = T.S


def err(fn, *a, **k):
    """Resultado ou a mensagem do TraderError."""
    try:
        return {"ok": fn(*a, **k)}
    except core.TraderError as e:
        return {"error": str(e)}


# ---------------------------------------------------------------- números e RNG

def case_rng():
    out = []
    for seed in (19, 7, 0, 1, 2 ** 32 + 5, 2 ** 40 + 12345):
        r = random.Random(seed)
        floats = [r.random() for _ in range(6)]
        bits = [r.getrandbits(k) for k in (1, 5, 13, 32, 31, 8)]
        r2 = random.Random(seed)
        choices = {str(n): [r2.choice(range(n)) for _ in range(40)] for n in (1, 2, 3, 7, 96, 1000, 4096, 100003)}
        out.append({"seed": seed, "random": floats, "bits": bits, "choices": choices})
    return out


def case_numbers():
    rng = random.Random(123)
    xs = [0.125, 0.375, 2.5, 0.5, 1.5, -0.125, -2.5, 1.005, 2.675, 0.045, 1e-7, 123456.789, 1e16, 1e-5, 0.0001,
          100.0, 99.995, 0.3 - 0.1, 1 / 3, 101.5, 76962.61 * 0.99, 999999.5, 1234567.0, 0.00012345678, -0.004, 0.0]
    for _ in range(300):
        mag = 10 ** rng.uniform(-6, 7)
        xs.append(rng.uniform(-1, 1) * mag)
    rows = []
    for x in xs:
        rows.append({"x": x, "r0": round(x), "r1": round(x, 1), "r2": round(x, 2), "r3": round(x, 3),
                     "g": "%g" % x, "f2": "%.2f" % x, "f1": "%.1f" % x, "f0": "%.0f" % x, "pf2": "%+.2f" % x,
                     "repr": repr(x)})
    sums = []
    for _ in range(40):
        n = rng.randint(1, 400)
        vals = [rng.gauss(0, 1) * 10 ** rng.randint(-8, 8) for _ in range(n)]
        sums.append({"vals": vals, "sum": sum(vals)})
    sums.append({"vals": [], "sum": 0})
    sums.append({"vals": [1e16, 1.0, -1e16], "sum": sum([1e16, 1.0, -1e16])})
    steps = []
    for x, st in [(0.123456, "0.001"), (101.231, "0.01"), (12, "1"), (101.6015, "0.01"), (0.09842519685039371, "0.00001"),
                  (4.92003, "0.00001"), (76192.9839, "0.01"), (1e-7, "0.00000001"), (0.29999999999999999, "0.1"),
                  (1234.5, "0.5"), (1234.5, "5"), (99.99999999, "0.00010000"), (0.0, "0.01")]:
        steps.append({"x": x, "step": st, "floor": core.dstr(core.floor_step(x, st)), "ceil": core.dstr(core.ceil_step(x, st)),
                      "floor_f": float(core.floor_step(x, st)), "ceil_f": float(core.ceil_step(x, st))})
    for _ in range(200):
        x = rng.uniform(0, 1) * 10 ** rng.randint(-6, 6)
        st = rng.choice(["0.00000001", "0.00001", "0.001", "0.01", "0.1", "1", "0.05", "10", "0.00025"])
        steps.append({"x": x, "step": st, "floor": core.dstr(core.floor_step(x, st)), "ceil": core.dstr(core.ceil_step(x, st)),
                      "floor_f": float(core.floor_step(x, st)), "ceil_f": float(core.ceil_step(x, st))})
    return {"fmt": rows, "sums": sums, "steps": steps}


# ---------------------------------------------------------------- core / scan / plan

def case_core():
    bars = T.session_with_breakout(S)
    flat = [dict(b, c=100, h=100.4) for b in bars]
    late = T.session_with_breakout(S, trig_slot=80)
    short = bars[:8]
    sigs = []
    for name, bs, now in [("forming", bars, S + 30 * 60000), ("waiting", bars, S + 14 * IV), ("triggered", bars, S + 15 * IV),
                          ("expired", flat, S + 6 * 3600000), ("late", late, S + 7 * 3600000), ("nodata", short, S + 2 * 3600000),
                          ("triggered_later", bars, S + 5 * 3600000)]:
        closed = core.closed_only(bs, now)
        sigs.append({"name": name, "bars": bs, "now": now, "n_closed": len(closed), "sig": core.orb_signal(closed, now, CFG)})
    at_top = T.session_with_breakout(S, close=101.0)   # fecha exatamente no topo: não rompe
    sigs.append({"name": "at-top", "bars": at_top, "now": S + 7 * 3600000, "n_closed": len(core.closed_only(at_top, S + 7 * 3600000)),
                 "sig": core.orb_signal(core.closed_only(at_top, S + 7 * 3600000), S + 7 * 3600000, CFG)})
    rnd = T.make_bars(S, 96, 100, seed=42, vol=0.004)
    for anchor, rm in [("13:00", 60), ("13:00", 30), ("00:00", 60)]:
        cfg = dict(CFG, anchor_utc=anchor, range_minutes=rm)
        for now in (S + 40 * 60000, S + 3 * 3600000, S + 9 * 3600000):
            sigs.append({"name": "rnd-%s-%d" % (anchor, rm), "bars": rnd, "now": now, "cfg": {"anchor_utc": anchor, "range_minutes": rm},
                         "n_closed": len(core.closed_only(rnd, now)),
                         "sig": core.orb_signal(core.closed_only(rnd, now), now, cfg)})
    ss = [{"ts": ts, "anchor": a, "out": core.session_start(ts, a)}
          for ts, a in [(core.utc_ms("2026-11-02 14:00"), "13:00"), (core.utc_ms("2026-11-02 02:00"), "13:00"),
                        (core.utc_ms("2026-11-02 00:00"), "00:00"), (core.utc_ms("2026-11-02 13:00"), "13:00"),
                        (core.utc_ms("2026-03-01 23:59"), "21:30")]]
    costs = []
    for e, x, st in [(100, 101, 99), (100, 99, 99), (101.61, 103.75, 100.0), (0.3179, 0.3188, 0.3173), (76962.61, 77500.0, 76192.98)]:
        for fee, slip in [(0.1, 0.05), (0, 0), (0.075, 0.05), (0.2, 0.0)]:
            costs.append({"entry": e, "exit": x, "stop": st, "fee": fee, "slip": slip,
                          "rt": core.round_trip_cost(e, x, fee, slip), "net_r": core.net_r(e, x, st, fee, slip),
                          "lpu": core.loss_per_unit(e, st, fee, slip)})
    rows = [[S, "1", "2", "0.5", "1.5", "10", S + IV - 1, "15", 3, "0", "0", "0"],
            [(S - IV) * 1000, "1.1", "2.2", "0.4", "1.6", "11", (S - 1) * 1000, "16.5", 3, "0", "0", "0"]]
    targets = [{"text": t, "out": err(core.parse_target_r, t)} for t in ["1.5R", "2", " 3r ", "abc", "0", ".5R", "-1"]]
    fmt = [{"ms": ms, "tz": tz, "out": core.fmt_ts(ms, tz)} for ms, tz in
           [(S, "America/Sao_Paulo"), (S + 15 * IV, "America/Sao_Paulo"), (core.utc_ms("2026-01-01 01:30"), "America/Sao_Paulo"),
            (S, "UTC")]]
    return {"defaults": CFG, "signals": sigs, "session_start": ss, "costs": costs,
            "klines": {"rows": rows, "out": core.parse_klines(rows)}, "targets": targets, "fmt_ts": fmt,
            "today": [{"ms": S, "out": core.today_utc(S)}, {"ms": core.utc_ms("2026-12-31 23:59"), "out": core.today_utc(core.utc_ms("2026-12-31 23:59"))}],
            "utc_ms": [{"text": "2026-11-02 13:00", "out": S}, {"text": "2025-01-01 00:00", "out": core.utc_ms("2025-01-01 00:00")}]}


def case_scan():
    tick = [
        {"symbol": "BTCUSDT", "quoteVolume": "900000000", "priceChangePercent": "1"},
        {"symbol": "USDCUSDT", "quoteVolume": "800000000"},
        {"symbol": "ETHUSDT", "quoteVolume": "400000000", "priceChangePercent": "0.5"},
        {"symbol": "LOWUSDT", "quoteVolume": "100"},
        {"symbol": "ETHBTC", "quoteVolume": "999999999"},
        {"symbol": "UUSDT", "openPrice": "1.0000", "lastPrice": "0.9999", "quoteVolume": "60000000"},
        {"symbol": "SNDKBUSDT", "quoteVolume": "90000000", "lastPrice": "40", "priceChangePercent": "3"},
        {"symbol": "SOLUSDT", "quoteVolume": "150000000", "lastPrice": "170", "openPrice": "173.8", "priceChangePercent": ""},
        {"symbol": "BADUSDT", "quoteVolume": None, "lastPrice": "1"},
        {"symbol": "DOGEUSDT", "quoteVolume": "150000000", "lastPrice": "0.21", "openPrice": "0.2"},
        {"symbol": "USDT", "quoteVolume": "150000000"},
    ]
    uni = []
    for cfg_over, top in [({}, 10), ({"exclude_bases": ["SNDKB"]}, 10), ({}, 2), ({"min_quote_volume": 50}, 40)]:
        uni.append({"cfg": cfg_over, "top": top, "out": scan.pick_universe(tick, dict(CFG, **cfg_over), top)})
    now = S + 15 * IV
    data = {"AAAUSDT": T.session_with_breakout(S), "BBBUSDT": T.session_with_breakout(S, hi=100.2, lo=100.0),
            "CCCUSDT": T.session_with_breakout(S, close=103.5), "DDDUSDT": [dict(b, c=100, h=100.4) for b in T.session_with_breakout(S)],
            "EEEUSDT": T.session_with_breakout(S)[:6], "FFFUSDT": T.session_with_breakout(S, trig_slot=13, close=101.2)}
    universe = [{"symbol": k, "quote_volume": 1e8 + i} for i, k in enumerate(data)]
    res = scan.scan_orb(universe, now, CFG, lambda s: core.closed_only(data[s], now))
    return {"tickers": tick, "universe": uni,
            "orb": {"now": now, "data": data, "universe": universe, "results": res, "hits": scan.filter_hits(res, CFG),
                    "explain": scan.explain_filtered(res, CFG), "counts": scan._counts(res)}}


def base_plan(stop_rule="or-mid", target_r=1.5, symbol="BTCUSDT"):
    now = S + 15 * IV + 60000
    sig = core.orb_signal(core.closed_only(T.session_with_breakout(S), now), now, CFG)
    return now, sig, planmod.build_plan(symbol, sig, CFG, stop_rule, target_r, now=now)


def case_plan():
    now, sig, _ = base_plan()
    waiting = dict(sig, status="waiting", trigger=None)
    cases = []
    for name, s, rule, r, entry in [("mid15", sig, "or-mid", 1.5, None), ("low2", sig, "or-low", 2.0, None),
                                    ("manual", waiting, "or-mid", 1.0, 101.2), ("no-trigger", waiting, "or-mid", 1.0, None),
                                    ("far", waiting, "or-mid", 1.0, 110.0), ("stop-above", waiting, "or-mid", 1.0, 99.5),
                                    ("bad-rule", sig, "or-top", 1.0, None)]:
        cases.append({"name": name, "symbol": "btcusdt", "sig": s, "stop_rule": rule, "target_r": r, "entry": entry, "now": now,
                      "out": err(planmod.build_plan, "btcusdt", s, CFG, rule, r, entry, now)})
    forming = core.orb_signal([], S + 60000, CFG)
    cases.append({"name": "forming", "symbol": "x", "sig": forming, "stop_rule": "or-mid", "target_r": 1.0, "entry": 100.0,
                  "now": S + 60000, "out": err(planmod.build_plan, "x", forming, CFG, "or-mid", 1.0, 100.0, S + 60000)})
    desc = [{"sig": s, "out": planmod.describe(s, CFG)} for s in (sig, forming, dict(sig, status="expired", trigger=None))]
    return {"cases": cases, "describe": desc}


# ---------------------------------------------------------------- time machine

def case_timemachine():
    _, _, plan = base_plan()
    bars = T.TestTimeMachine.history(None, 30)
    holed = list(bars)
    del holed[100]
    sessions = timemachine.full_sessions(bars, plan["params"], S)
    pool = timemachine.build_pool(sessions, 96, 2)
    mc = []
    for replays, seed, window, cfg_over in [(2000, 19, 2, {}), (2000, 7, 2, {}), (3000, 19, 2, {"fee_pct": 0, "slippage_pct": 0}),
                                           (10000, 19, 2, {}), (500, 3, 0, {}), (1500, 11, 5, {"fee_pct": 0.075})]:
        mc.append({"replays": replays, "seed": seed, "window": window, "cfg": cfg_over,
                   "out": timemachine.run_mc(plan, sessions, dict(CFG, **cfg_over), replays, seed, window)})
    # plano com alvo e stop mais apertados (mais replays batem num dos lados) e stop no fundo da faixa
    _, _, plan_low = base_plan("or-low", 1.0)
    tight = dict(plan, stop=101.0, target=102.0, target_r=1.0)
    mc_other = [{"plan": p, "replays": 4000, "seed": 19, "window": 2, "out": timemachine.run_mc(p, sessions, CFG, 4000, 19, 2)}
                for p in (plan_low, tight)]
    wide = []
    for d in range(25):
        s = S - (25 - d) * 86400000
        day = [{"t": s + i * IV, "o": 100, "h": 100, "l": 100, "c": 100, "v": 1} for i in range(96)]
        for i in range(15, 96):
            day[i] = {"t": s + i * IV, "o": 100, "h": 110, "l": 90, "c": 100, "v": 1}
        wide += day
    wide_ss = timemachine.full_sessions(wide, plan["params"], S)
    known = []
    for d in range(20):
        s = S - (20 - d) * 86400000
        day = T.session_with_breakout(s)
        for i in range(20, 30):
            day[i] = {"t": s + i * IV, "o": 101.5, "h": 104, "l": 101.4, "c": 103.5, "v": 1}
        known += day
    known_ss = timemachine.full_sessions(known, plan["params"], S)
    # empates exatos: mínima igual ao stop e máxima igual ao alvo contam como toque
    ties = []
    for name, hi, lo in [("stop", 100, 50), ("target", 400, 100), ("both", 400, 50), ("none", 399.99, 50.01)]:
        tb = []
        for d in range(22):
            s = S - (22 - d) * 86400000
            tb += [{"t": s + i * IV, "o": 100, "h": hi if i >= 15 else 100, "l": lo if i >= 15 else 100, "c": 100, "v": 1} for i in range(96)]
        tplan = dict(plan, entry=100.0, stop=50.0, target=400.0, target_r=6.0)
        tss = timemachine.full_sessions(tb, plan["params"], S)
        ties.append({"name": name, "bars": tb, "plan": tplan, "out": timemachine.run_mc(tplan, tss, CFG, 300, 19, 1)})
    known_tie = []
    for d in range(20):
        s = S - (20 - d) * 86400000
        day = T.session_with_breakout(s)
        day[20] = {"t": s + 20 * IV, "o": 101.5, "h": 103.75, "l": 101.4, "c": 103.5, "v": 1}   # máxima = alvo de 1.5R
        day[40] = {"t": s + 40 * IV, "o": 101.5, "h": 102, "l": 99.0, "c": 100, "v": 1}         # mínima = fundo da faixa
        known_tie += day
    tie_ss = timemachine.full_sessions(known_tie, plan["params"], S)
    verdicts = []
    for counts in [{"target": 40, "stop": 60, "open": 0}, {"target": 48, "stop": 52, "open": 0}, {"target": 90, "stop": 10, "open": 0},
                   {"target": 10, "stop": 90, "open": 0}, {"target": 60, "stop": 40, "open": 5}, {"target": 0, "stop": 0, "open": 9}]:
        verdicts.append({"counts": counts, "plan": plan, "out": timemachine.verdict({"counts": counts}, plan, CFG)})
    imp = dict(plan, entry=0.3179, stop=0.3173, target=0.3188, target_r=1.5)
    verdicts.append({"counts": {"target": 31, "stop": 68, "open": 1}, "plan": imp,
                     "out": timemachine.verdict({"counts": {"target": 31, "stop": 68, "open": 1}}, imp, CFG)})
    pct = [{"vals": v, "p": p, "out": timemachine.percentile(v, p)} for v, p in
           [([], 5), ([1.0], 50), ([1.0, 2.0, 3.0, 4.0], 50), ([1.0, 2.0, 3.0, 4.0, 5.0, 6.0], 50), (list(map(float, range(11))), 5),
            (list(map(float, range(11))), 95), (list(map(float, range(102))), 5), (list(map(float, range(102))), 50)]]
    return {"plan": plan, "bars": bars, "before": S,
            "sessions": [s for s, _ in sessions], "sessions_holed": len(timemachine.full_sessions(holed, plan["params"], S)),
            "pool_lens": [len(p) for p in pool], "pool_sample": {"slot": 40, "first": list(pool[40][0]), "last": list(pool[40][-1])},
            "mc": mc, "mc_other": mc_other, "history": timemachine.run_history(plan, sessions, CFG),
            "wide": {"bars": wide, "window": 0, "replays": 200, "seed": 19,
                     "out": timemachine.run_mc(plan, wide_ss, CFG, 200, 19, 0)},
            "known": {"bars": known, "history": timemachine.run_history(plan, known_ss, CFG),
                      "history_low": timemachine.run_history(plan_low, known_ss, dict(CFG, fee_pct=0.075))},
            "ties": ties,
            "known_tie": {"bars": known_tie, "history": timemachine.run_history(plan, tie_ss, CFG),
                          "history_low": timemachine.run_history(dict(plan_low, target_r=5.0), tie_ss, CFG),
                          "combos": [{"anchor_utc": "13:00", "range_minutes": 60, "stop_rule": sr, "target_r": tr, "min_range_pct": 1.0}
                                     for sr in ("or-mid", "or-low") for tr in (1.0, 1.5, 5.0)],
                          "backtest": backtest.evaluate(known_tie, dict(CFG, entry_buffer_pct=0), [
                              {"anchor_utc": "13:00", "range_minutes": 60, "stop_rule": sr, "target_r": tr, "min_range_pct": 1.0}
                              for sr in ("or-mid", "or-low") for tr in (1.0, 1.5, 5.0)], 0.5, 240, 8, 1.0)},
            "verdicts": verdicts, "percentile": pct}


# ---------------------------------------------------------------- size / risk

INFO_MIN = {"symbols": [{"symbol": "BTCUSDT", "status": "TRADING", "baseAsset": "BTC", "quoteAsset": "USDT",
                         "filters": [{"filterType": "PRICE_FILTER", "tickSize": "0.01"},
                                     {"filterType": "LOT_SIZE", "minQty": "0.00001", "stepSize": "0.00001"},
                                     {"filterType": "NOTIONAL", "minNotional": "5.00"}]}]}


def strip_fp(o):
    """A impressão digital do plano só serve ao broker.py, que não é portado."""
    if "ok" in o:
        o["ok"] = {k: v for k, v in o["ok"].items() if k != "plan_fingerprint"}
    return o


def case_size_risk():
    now, sig, plan = base_plan()
    _, _, plan_low = base_plan("or-low", 2.0)
    rules_cases = []
    infos = {"full": T.INFO, "min": INFO_MIN,
             "break": {"symbols": [dict(T.INFO["symbols"][0], status="BREAK")]},
             "nospot": {"symbols": [dict(T.INFO["symbols"][0], isSpotTradingAllowed=False)]},
             "types": {"symbols": [dict(T.INFO["symbols"][0], orderTypes=["LIMIT", "MARKET"])]},
             "nofilter": {"symbols": [dict(T.INFO["symbols"][0], filters=[{"filterType": "PRICE_FILTER", "tickSize": "0.01"}])]},
             "missing": {"symbols": []}}
    for name, info in infos.items():
        rules_cases.append({"name": name, "info": info, "out": err(size.parse_rules, info, "BTCUSDT")})
    rules = size.parse_rules(T.INFO, "BTCUSDT")
    rules_min = size.parse_rules(INFO_MIN, "BTCUSDT")
    orders = []
    for name, p, cfg_over, r, avg in [
            ("default-min", plan, {}, rules_min, None), ("default-full", plan, {}, rules, 101.5),
            ("big-account", plan, {"account": 100000}, rules_min, None), ("tiny-loss", plan, {"max_loss_per_trade": 0.0001}, rules_min, None),
            ("bnb", plan, {"fee_in_bnb": True}, rules, 101.5), ("two-step", plan, {"entry_mode": "two-step"}, rules, 101.5),
            ("avg-low", plan, {}, rules, 10.0), ("avg-high", plan, {}, rules, 1000.0),
            ("max-notional", plan, {}, dict(rules, max_notional="200"), 101.5), ("max-qty", plan, {"account": 100000}, dict(rules, max_qty="1.5"), 101.5),
            ("or-low-2R", plan_low, {"fee_pct": 0.075, "slippage_pct": 0.02}, rules, 101.5),
            ("min-notional", plan, {"max_loss_per_trade": 0.05}, rules, 101.5),
            ("incoherent", dict(plan, target=101.6), {}, rules, 101.5),
            ("zero-qty", plan, {"max_loss_per_trade": 0.00001}, rules, 101.5),
            ("sell-below-min", plan, {"max_loss_per_trade": 0.11}, dict(rules, min_notional="5.5"), 101.5),
            ("coarse-step", plan, {"account": 250}, dict(rules, step="0.5", min_qty="0.5"), 101.5)]:
        orders.append({"name": name, "plan": p, "cfg": cfg_over, "rules": r, "avg": avg,
                       "out": strip_fp(err(size.size_order, p, dict(CFG, **cfg_over), r, avg))})
    real = size.size_order(plan, CFG, rules_min)
    del real["plan_fingerprint"]
    o = dict(real, reward_risk=1.2)
    t = now + 2 * 60000
    tm_ok = {"verdict": "Pende para o alvo: x", "mc": {"avg_net_r": 0.123}}
    tm_bad = {"verdict": "Forte para o stop: y", "mc": {"avg_net_r": -0.5}}
    tm_neg = {"verdict": "Perto de empate: z", "mc": {"avg_net_r": -0.01}}
    checks = []
    for name, p, od, cfg_over, state, when, tm in [
            ("real", plan, real, {}, {"orders": []}, t, None), ("rr-ok", plan, o, {}, {"orders": []}, t, None),
            ("daily", plan, o, {}, {"orders": [{"date": core.today_utc(t), "status": "protected", "max_loss": 25}]}, t, None),
            ("many", plan, o, {}, {"orders": [{"date": core.today_utc(t), "status": "flattened", "max_loss": 1}] * 3}, t, None),
            ("other-day", plan, o, {}, {"orders": [{"date": "2026-11-01", "status": "protected", "max_loss": 25},
                                                    {"date": core.today_utc(t), "status": "rejected", "max_loss": 25}]}, t, None),
            ("old", plan, o, {}, {"orders": []}, t + 30 * 60000, None), ("late", plan, o, {}, {"orders": []}, plan["window_end"] + 1, None),
            ("flat", plan, o, {}, {"orders": []}, plan["flat_by"], None), ("next-day", plan, o, {}, {"orders": []}, t + 86400000, None),
            ("big-loss", plan, dict(o, max_loss=50), {}, {"orders": []}, t, None),
            ("narrow", dict(plan, range_pct=0.42), o, {}, {"orders": []}, t, None),
            ("live", plan, dict(o, paper=False), {"max_position_pct": 12.5}, {"orders": []}, t, tm_ok),
            ("tm-bad", plan, o, {}, {"orders": []}, t, tm_bad), ("tm-neg", plan, o, {}, {"orders": []}, t, tm_neg)]:
        checks.append({"name": name, "plan": p, "order": od, "cfg": cfg_over, "state": state, "now": when, "tm": tm,
                       "out": risk.run_checks(p, od, dict(CFG, **cfg_over), state, when, tm)})
    pp = [{"avg": a, "entry": e, "stop": s, "out": size.check_percent_price(rules, a, e, s)}
          for a, e, s in [(None, 1, 1), (101.5, 101.61, 99.7), (10.0, 101.61, 99.7), (1000.0, 101.61, 99.7)]]
    return {"rules": rules_cases, "orders": orders, "checks": checks, "percent_price": pp}


# ---------------------------------------------------------------- backtest / research

def case_backtest():
    planted = []
    for d in range(60):
        s = S - (60 - d) * 86400000
        sess = T.session_with_breakout(s)
        for i in range(20, 30):
            sess[i] = {"t": s + i * IV, "o": 101.5, "h": 106, "l": 101.4, "c": 105, "v": 1}
        planted += sess
    one = [{"anchor_utc": "13:00", "range_minutes": 60, "stop_rule": "or-mid", "target_r": 1.5, "min_range_pct": 1.0}]
    rnd = []
    for d in range(120):
        s = S - (120 - d) * 86400000
        rnd += T.make_bars(s, 288, 100, seed=500 + d, vol=0.003)
    combos = list(backtest.grid(["00:00", "13:00"], [30, 60], ["or-mid", "or-low"], [1.0, 1.5, 2.0, 3.0], [0.5, 1.0, 1.5]))
    wild = []
    for d in range(90):
        s = S - (90 - d) * 86400000
        wild += T.make_bars(s, 288, 100, seed=900 + d, vol=0.006, drift=0.00002)
    del wild[5000:5003]   # buraco: uma sessão fica incompleta
    sums = [{"rs": rs, "out": backtest.summarize(rs)} for rs in
            [[], [1.0], [-1.003, 1.4955, -1.003, -0.2, 0.7], [0.125, 0.125, 0.005], [-0.5] * 7, [0.3349999, -0.3350001, 1e-9]]]
    return {"planted": {"bars": planted, "combos": one, "out": backtest.evaluate(planted, CFG, one, 0.7, 240, 8, 1.0)},
            "random": {"bars": rnd, "combos": combos, "out": backtest.evaluate(rnd, CFG, combos, 0.7, 240, 8, 1.0)},
            "wild": {"bars": wild, "combos": combos, "cfg": {"fee_pct": 0.075, "slippage_pct": 0.02}, "split": 0.6,
                     "out": backtest.evaluate(wild, dict(CFG, fee_pct=0.075, slippage_pct=0.02), combos, 0.6, 240, 8, 1.0),
                     "free": backtest.evaluate(wild, dict(CFG, fee_pct=0, slippage_pct=0), combos, 0.6, 240, 8, 1.0)},
            "sessions": {"anchor": "13:00", "flat": 8, "random": [s for s, _ in backtest.sessions_for(rnd, "13:00", 8)],
                         "wild": [s for s, _ in backtest.sessions_for(wild, "00:00", 8)]},
            "summarize": sums}


def research_one(bars, cfg, lookbacks, buy_h, sell_h):
    hourly = research.to_hourly(bars)
    daily = research.to_daily(bars)
    sr = research.season_returns(hourly, buy_h, sell_h, cfg)
    don = {str(lb): research.donchian_returns(daily, lb, cfg) for lb in lookbacks}
    oos, chosen = research.walk_forward(lambda p: research.donchian_returns(daily, p["lookback"], cfg),
                                        [{"lookback": lb} for lb in lookbacks], n_blocks=4)
    bh = research.buy_hold(daily)
    lines = []
    summary = research.run_symbol("FAKE", bars, cfg, lookbacks, buy_h, sell_h, lines.append)
    return {"hourly_n": len(hourly), "daily_n": len(daily), "hourly_head": hourly[:3], "hourly_tail": hourly[-2:],
            "daily_head": daily[:2], "daily_tail": daily[-2:],
            "hour_profile": [list(r) for r in research.hour_profile(hourly)],
            "season": sr, "season_sum": research.summarize(sr, 365),
            "season_gross_sum": research.summarize([r + research.cost_rt(cfg) for r in sr], 365),
            "donchian": don, "donchian_sum": {k: research.summarize(v, 365) for k, v in don.items()},
            "wf_oos": oos, "wf_chosen": chosen, "wf_sum": research.summarize(oos, 365) if oos else None,
            "bh": bh, "bh_sum": research.summarize(bh, 365),
            "bh_oos_sum": research.summarize(bh[-len(oos):], 365) if oos else None,
            "cost_rt": research.cost_rt(cfg), "run_symbol": summary, "report": lines}


def case_research():
    synth = T.TestResearch.synth
    series = {"trend": synth(None, 400, trend=True), "edge": synth(None, 300, hour_edge_bps=8.0), "flat": synth(None, 150, seed=11)}
    holed = list(series["flat"])
    del holed[300:309]      # uma hora fica com 3 candles e sai do horário
    del holed[2000:2001]
    series["holed"] = holed
    out = {}
    for name, bars in series.items():
        lbs = [10, 20, 30, 40, 55] if name == "trend" else [3, 5, 10, 20] if name == "flat" else [10, 20]
        cfg = dict(CFG, fee_pct=0.075, slippage_pct=0.02) if name == "flat" else CFG
        out[name] = {"bars": bars, "lookbacks": lbs, "buy": 21, "sell": 23,
                     "cfg": {"fee_pct": cfg["fee_pct"], "slippage_pct": cfg["slippage_pct"]},
                     "out": research_one(bars, cfg, lbs, 21, 23)}
    wf_series = {5: [0.01] * 40 + [-0.02] * 40, 7: [-0.01] * 40 + [0.02] * 40}
    oos, chosen = research.walk_forward(lambda p: wf_series[p["k"]], [{"k": 5}, {"k": 7}], n_blocks=4)
    sums = [{"rets": r, "ppy": p, "out": research.summarize(r, p)} for r, p in
            [([], 365), ([0.01] * 365, 365), ([0.1, -0.5, 0.1], 365), ([0.0, 0.0, 0.0], 365), ([-1.0, 0.5], 365),
             ([0.002, -0.001, 0.0, 0.004, -0.003] * 20, 1)]]
    return {"series": out, "wf_toy": {"series": {str(k): v for k, v in wf_series.items()}, "oos": oos, "chosen": chosen},
            "summarize": sums}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        print(__doc__)
        return 1
    data = {"meta": {"python": list(sys.version_info[:3]), "iv": IV, "S": S},
            "rng": case_rng(), "numbers": case_numbers(), "core": case_core(), "scan": case_scan(), "plan": case_plan(),
            "timemachine": case_timemachine(), "size_risk": case_size_risk(), "backtest": case_backtest(),
            "research": case_research()}
    d = os.path.dirname(os.path.abspath(argv[0]))
    os.makedirs(d, exist_ok=True)
    with open(argv[0], "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))
    print("paridade: %s (%.1f MB, Python %s)" % (argv[0], os.path.getsize(argv[0]) / 1e6, sys.version.split()[0]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
