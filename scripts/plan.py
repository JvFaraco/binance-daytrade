#!/usr/bin/env python3
"""plan.py - estado do sinal e plano de entrada/stop/alvo de um par.

  plan.py check SYMBOL                      esperando / rompeu / expirou
  plan.py watch SYMBOL --every 30           repete o check até rompir ou expirar
  plan.py plan SYMBOL --stop or-mid --target 1.5R --write     -> trader/plan.json
  plan.py testplan SYMBOL --stop-pct 1 --write   so em paper: plano de teste de tubulacao, nao e setup
Opções: --now "AAAA-MM-DD HH:MM" (UTC), --fixture ARQUIVO (candles de 5m salvos)
"""
import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import core  # noqa: E402


def get_signal(symbol, cfg, now, fixture=None):
    if fixture:
        bars = core.closed_only(core.load_klines_file(fixture), now)
    else:
        bars = core.get_session_bars(symbol, now, cfg)
    return core.orb_signal(bars, now, cfg)


def build_plan(symbol, sig, cfg, stop_rule, target_r, entry=None, now=None):
    if sig["status"] != "triggered" and entry is None:
        raise core.TraderError("sem rompimento (status: %s). Não há plano pra montar." % sig["status"])
    if "range_high" not in sig:
        raise core.TraderError("faixa inicial ainda não existe (status: %s)" % sig["status"])
    t = sig["trigger"]
    entry = float(entry) if entry is not None else t["close"]
    stop = core.stop_price(sig, stop_rule)
    if not stop < entry:
        raise core.TraderError("o stop (%g) precisa ficar abaixo da entrada (%g)" % (stop, entry))
    if entry > sig["range_high"] * (1 + float(cfg["max_chase_pct"]) / 100.0):
        raise core.TraderError("entrada %g está %.1f%% acima do topo da faixa (%g); o máximo é %.1f%%. "
                               "Isso não é mais um rompimento." % (entry, (entry / sig["range_high"] - 1) * 100,
                                                                  sig["range_high"], cfg["max_chase_pct"]))
    risk = entry - stop
    return {
        "symbol": symbol.upper(), "side": "BUY",
        "session_start": sig["session_start"], "window_end": sig["window_end"], "flat_by": sig["flat_by"],
        "range_high": sig["range_high"], "range_low": sig["range_low"], "range_mid": sig["range_mid"],
        "range_pct": sig["range_pct"],
        "entry": entry, "entry_time": t["time"] if t else None,
        "entry_slot": t["slot"] if t else (now - sig["session_start"]) // core.IV - 1,
        "stop": stop, "stop_rule": stop_rule, "target_r": target_r,
        "target": entry + target_r * risk, "risk_per_unit": risk,
        "params": {"anchor_utc": cfg["anchor_utc"], "range_minutes": cfg["range_minutes"],
                   "entry_window_minutes": cfg["entry_window_minutes"], "flat_by_hours": cfg["flat_by_hours"]},
    }


def build_testplan(symbol, price, cfg, stop_pct, target_r, now):
    """Plano de TESTE DE TUBULAÇÃO: stop a stop_pct abaixo do preço atual, alvo em R. Só em paper.
    Não é um setup. Serve pra exercitar size/risk/broker na testnet quando não há rompimento."""
    if not cfg["paper"]:
        raise core.TraderError("testplan só existe em modo paper (testnet)")
    s = core.session_start(now, cfg["anchor_utc"])
    entry = float(price)
    stop = entry * (1 - stop_pct / 100.0)
    risk = entry - stop
    return {
        "symbol": symbol.upper(), "side": "BUY", "test_plan": True,
        "session_start": s, "window_end": now + 3600000, "flat_by": s + int(float(cfg["flat_by_hours"]) * 3600000),
        "range_high": entry, "range_low": stop, "range_mid": (entry + stop) / 2, "range_pct": stop_pct,
        "entry": entry, "entry_time": now, "entry_slot": (now - s) // core.IV - 1,
        "stop": stop, "stop_rule": "pct-%g" % stop_pct, "target_r": target_r,
        "target": entry + target_r * risk, "risk_per_unit": risk,
        "params": {"anchor_utc": cfg["anchor_utc"], "range_minutes": cfg["range_minutes"],
                   "entry_window_minutes": cfg["entry_window_minutes"], "flat_by_hours": cfg["flat_by_hours"]},
    }


def describe(sig, cfg):
    tz = cfg["display_tz"]
    s = sig["status"]
    lines = ["Sessão desde %s | faixa até %s | janela de entrada até %s | zerar até %s" % (
        core.fmt_ts(sig["session_start"], tz), core.fmt_ts(sig["range_end"], tz),
        core.fmt_ts(sig["window_end"], tz), core.fmt_ts(sig["flat_by"], tz))]
    if "range_high" in sig:
        lines.append("Faixa: %g a %g (%.2f%% de largura, meio %g)" % (
            sig["range_low"], sig["range_high"], sig["range_pct"], sig["range_mid"]))
    label = {"forming": "FORMANDO: a faixa inicial ainda não fechou",
             "nodata": "SEM DADOS: faltam candles da faixa",
             "waiting": "ESPERANDO: nenhum candle de 5m fechou acima do topo da faixa",
             "expired": "EXPIROU: a janela de entrada acabou sem rompimento",
             "triggered": "ROMPEU"}[s]
    lines.append(label)
    if sig["trigger"]:
        t = sig["trigger"]
        lines.append("Primeiro fechamento acima do topo: %g às %s (%.2f%% acima)" % (
            t["close"], core.fmt_ts(t["time"], tz), t["pct_over"]))
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["check", "watch", "plan", "testplan"])
    ap.add_argument("symbol")
    ap.add_argument("--stop", default="or-mid")
    ap.add_argument("--target", default="1.5R")
    ap.add_argument("--entry", type=float, help="entrada manual (ignora o preço do rompimento)")
    ap.add_argument("--stop-pct", type=float, default=1.0, help="testplan: stop a esse %% abaixo do preço atual")
    ap.add_argument("--price", type=float, help="testplan: preço atual (offline); online lê da testnet")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--every", type=int, default=30)
    ap.add_argument("--now")
    ap.add_argument("--fixture")
    ap.add_argument("--config")
    a = ap.parse_args(argv)
    cfg = core.load_config(a.config)
    try:
        if a.cmd == "watch":
            while True:
                sig = get_signal(a.symbol.upper(), cfg, core.now_ms(a.now), a.fixture)
                print(time.strftime("%H:%M:%S"), sig["status"])
                if sig["status"] in ("triggered", "expired") or a.now or a.fixture:
                    print(describe(sig, cfg))
                    return 0
                time.sleep(max(a.every, 5))
        now = core.now_ms(a.now)
        if a.cmd == "testplan":
            price = a.price
            if price is None:
                price = float(core.http_json(core.TEST_HOST + "/api/v3/ticker/price",
                                             {"symbol": a.symbol.upper()})["price"])
            plan = build_testplan(a.symbol, price, cfg, a.stop_pct, core.parse_target_r(a.target), now)
            print("PLANO DE TESTE (não é setup): %s entrada %g, stop %g (%.1f%% abaixo), alvo %g (%gR)" % (
                plan["symbol"], plan["entry"], plan["stop"], a.stop_pct, plan["target"], plan["target_r"]))
            if a.write:
                core.write_json(core.path_in("plan.json"), plan)
                print("Salvo em %s" % core.path_in("plan.json"))
            return 0
        sig = get_signal(a.symbol.upper(), cfg, now, a.fixture)
        if a.cmd == "check":
            print(describe(sig, cfg))
            return 0
        plan = build_plan(a.symbol, sig, cfg, a.stop, core.parse_target_r(a.target), a.entry, now)
    except (core.TraderError, core.ApiError) as e:
        print("Erro: %s" % e)
        return 1
    print("%s: entrada %g, stop %g (%s), alvo %g (%gR), risco %g por unidade" % (
        plan["symbol"], plan["entry"], plan["stop"], plan["stop_rule"], plan["target"],
        plan["target_r"], plan["risk_per_unit"]))
    if a.write:
        core.write_json(core.path_in("plan.json"), plan)
        print("Salvo em %s" % core.path_in("plan.json"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
