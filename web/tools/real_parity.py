#!/usr/bin/env python3
"""real_parity.py - o mesmo que export_parity.py, mas com candles REAIS da Binance.

  python3 web/tools/real_parity.py SYMBOL DIAS SAIDA.json

Baixa os candles de 5m pelo endpoint público (core.get_klines_range, sem chave), roda o motor
Python neles e grava entradas e saídas. O teste web/tests/real.test.ts compara com o TypeScript:

  REAL_FIXTURE=/caminho/SAIDA.json npx vitest run tests/real.test.ts

Precisa de rede, por isso não roda no CI; é uma conferência manual da paridade com dado de verdade.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import backtest  # noqa: E402
import core  # noqa: E402
import plan as planmod  # noqa: E402
import research  # noqa: E402
import timemachine  # noqa: E402


def main(argv):
    if len(argv) != 3:
        print(__doc__)
        return 1
    symbol, days, out = argv[0].upper(), int(argv[1]), argv[2]
    cfg = core.load_config("/nonexistent.json")
    now = core.now_ms() // core.IV * core.IV
    bars = core.closed_only(core.get_klines_range(symbol, now - days * 86400000, now), now)
    # plano: o último rompimento do período com as regras padrão (or-mid, 1.5R)
    sessions = backtest.sessions_for(bars, cfg["anchor_utc"], cfg["flat_by_hours"])
    plan = None
    for s, sb in reversed(sessions):
        sig = core.orb_signal(sb, s + int(cfg["flat_by_hours"] * 3600000), cfg, session=s)
        if sig["status"] != "triggered":
            continue
        try:
            plan = planmod.build_plan(symbol, sig, cfg, "or-mid", 1.5, now=sig["trigger"]["time"])
            break
        except core.TraderError:
            continue
    data = {"symbol": symbol, "days": days, "now": now, "n": len(bars), "bars": bars, "python": list(sys.version_info[:3])}
    if plan:
        tm_now = plan["entry_time"]
        window = core.closed_only([b for b in bars if b["t"] >= tm_now - 60 * 86400000], tm_now)
        ss = timemachine.full_sessions(window, plan["params"], plan["session_start"])
        mc = timemachine.run_mc(plan, ss, cfg, 10000, 19, 2)
        data["tm"] = {"plan": plan, "tm_now": tm_now, "sessions": len(ss), "mc": mc,
                      "history": timemachine.run_history(plan, ss, cfg), "verdict": timemachine.verdict(mc, plan, cfg)}
    combos = list(backtest.grid(["00:00", "13:00"], [30, 60], ["or-mid", "or-low"], [1.0, 1.5, 2.0, 3.0], [0.5, 1.0, 1.5]))
    data["grid"] = backtest.evaluate(bars, cfg, combos, 0.7, cfg["entry_window_minutes"], cfg["flat_by_hours"], cfg["max_chase_pct"])
    lines = []
    data["research"] = research.run_symbol(symbol, bars, cfg, [10, 20, 30, 40, 55], 21, 23, lines.append)
    data["report"] = lines
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))
    print("%s: %d candles reais (%d dias), plano: %s" % (symbol, len(bars), days, "sim" if plan else "não"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
