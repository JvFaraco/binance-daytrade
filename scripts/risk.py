#!/usr/bin/env python3
"""risk.py - confere a ordem contra os seus limites. PASS ou BLOCK, com o motivo.

  risk.py [--now "AAAA-MM-DD HH:MM"]     le plan.json, orders.json, state.json; grava risk.json

So o broker.py consulta o resultado (por impressao digital da ordem).
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import core  # noqa: E402

COMMITTED = ("approved", "entry_unfilled", "entry_filled", "protected", "flattened")


def run_checks(plan, order, cfg, state, now, tm=None):
    checks = []

    def add(name, level, text):
        checks.append({"name": name, "level": level, "text": text})

    today = core.today_utc(now)
    day = [r for r in state.get("orders", []) if r.get("date") == today and r.get("status") in COMMITTED]
    ml = order["max_loss"]
    add("perda máxima", "ok" if ml <= cfg["max_loss_per_trade"] * 1.0001 else "block",
        "%.2f de perda no stop, limite %.2f" % (ml, cfg["max_loss_per_trade"]))
    committed = sum(float(r.get("max_loss", 0)) for r in day)
    add("limite do dia", "ok" if committed + ml <= cfg["daily_loss_limit"] * 1.0001 else "block",
        "%.2f já comprometido hoje + %.2f desta ordem, limite %.2f" % (committed, ml, cfg["daily_loss_limit"]))
    add("trades no dia", "ok" if len(day) < cfg["max_trades_per_day"] else "block",
        "%d hoje, máximo %d" % (len(day), cfg["max_trades_per_day"]))
    add("retorno/risco", "ok" if order["reward_risk"] >= cfg["min_reward_risk"] else "block",
        "%.2f depois das taxas, mínimo %.2f" % (order["reward_risk"], cfg["min_reward_risk"]))
    cap = cfg["account"] * cfg["max_position_pct"] / 100.0
    add("tamanho da posição", "ok" if order["notional"] <= cap * 1.0001 else "block",
        "%.2f %s, máximo %.2f (%g%% do capital)" % (order["notional"], order["quote"], cap, cfg["max_position_pct"]))
    add("faixa larga o bastante", "ok" if plan["range_pct"] >= cfg["min_range_pct"] else "block",
        "faixa de %.2f%%, mínimo %.2f%% (abaixo disso as taxas comem o trade)" % (plan["range_pct"], cfg["min_range_pct"]))
    cur = core.session_start(now, plan["params"]["anchor_utc"])
    add("plano é da sessão atual", "ok" if plan["session_start"] == cur else "block",
        "plano de %s, sessão atual %s" % (core.fmt_ts(plan["session_start"], cfg["display_tz"]),
                                         core.fmt_ts(cur, cfg["display_tz"])))
    add("janela de entrada", "ok" if now <= plan["window_end"] else "block",
        "agora %s, janela até %s" % (core.fmt_ts(now, cfg["display_tz"]), core.fmt_ts(plan["window_end"], cfg["display_tz"])))
    add("antes do horário de zerar", "ok" if now < plan["flat_by"] else "block",
        "zerar às %s" % core.fmt_ts(plan["flat_by"], cfg["display_tz"]))
    if plan.get("entry_time"):
        age = (now - plan["entry_time"]) / 60000.0
        add("sinal fresco", "ok" if age <= cfg["max_signal_age_minutes"] else "block",
            "sinal tem %.0f min, máximo %d" % (age, cfg["max_signal_age_minutes"]))
    if tm is None:
        add("time machine", "warn", "não rodou: você não viu as odds desse plano")
    else:
        v = tm.get("verdict", "")
        add("time machine", "warn" if v.startswith(("Pende para o stop", "Forte para o stop")) or
            (tm["mc"]["avg_net_r"] < 0) else "ok", v + " | R médio líquido %+.2f" % tm["mc"]["avg_net_r"])
    add("modo", "ok" if order["paper"] else "warn",
        "paper (testnet)" if order["paper"] else "DINHEIRO REAL")
    return checks


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--now")
    ap.add_argument("--config")
    ap.add_argument("--force", action="store_true",
                    help="só em paper: rebaixa os bloqueios de horário/sinal/faixa pra AVISO (teste de tubulação)")
    a = ap.parse_args(argv)
    cfg = core.load_config(a.config)
    plan = core.read_json(core.path_in("plan.json"))
    order = core.read_json(core.path_in("orders.json"))
    if not plan or not order:
        print("Erro: faltam plan.json ou orders.json (rode plan.py e size.py com --write).")
        return 1
    now = core.now_ms(a.now)
    state = core.read_json(core.path_in("state.json"), {"orders": []})
    tm = core.read_json(core.path_in("timemachine.json"))
    if tm and tm.get("plan", {}).get("entry") != plan["entry"]:
        tm = None  # time machine de outro plano
    checks = run_checks(plan, order, cfg, state, now, tm)
    if a.force or plan.get("test_plan"):
        if not cfg["paper"]:
            print("Erro: --force e planos de teste só valem em modo paper.")
            return 1
        soft = {"janela de entrada", "sinal fresco", "faixa larga o bastante", "retorno/risco", "plano é da sessão atual"}
        for c in checks:
            if c["name"] in soft and c["level"] == "block":
                c["level"] = "warn"
                c["text"] += "  [rebaixado: teste de tubulação na testnet]"
        checks.insert(0, {"name": "TESTE DE TUBULAÇÃO", "level": "warn",
                          "text": "este plano não é um setup; só pra exercitar a corretora na testnet"})
    verdict = "BLOCK" if any(c["level"] == "block" for c in checks) else "PASS"
    for c in checks:
        mark = {"ok": "ok   ", "warn": "AVISO", "block": "BLOCK"}[c["level"]]
        print("[%s] %s: %s" % (mark, c["name"], c["text"]))
    print("\n%s %s" % (verdict, order["symbol"]))
    core.write_json(core.path_in("risk.json"), {
        "fingerprint": core.fingerprint(order), "verdict": verdict, "checked_at": now,
        "date": core.today_utc(now), "checks": checks})
    return 0 if verdict == "PASS" else 2


if __name__ == "__main__":
    sys.exit(main())
