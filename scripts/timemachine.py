#!/usr/bin/env python3
"""timemachine.py - reexecuta o plano 10.000 vezes e em cada sessao passada.

  timemachine.py run [--days 60] [--replays 10000] [--seed 19] [--write] [--json]
  timemachine.py run --months 12 --write                   historico de history.py em vez de 60 dias
  timemachine.py run --fixture candles-60d-5m.json[.gz] --now "2026-11-02 14:20"

Simulacao com candles de 5m do proprio par, sorteados do mesmo horario da sessao
(+- janela). NAO e previsao. Custos (taxa + slippage) entram no R.
Roda tambem o modo em blocos (bootstrap estacionario: trechos seguidos de sessoes
reais), que mantem a sequencia de calmaria e agitacao; os dois aparecem lado a lado.
"""
import argparse
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import core  # noqa: E402
import history  # noqa: E402


def full_sessions(bars, params, before_ms):
    """Sessões passadas com todos os candles de 5m entre o início e o horário de zerar."""
    n = int(float(params["flat_by_hours"]) * 12)
    by = {}
    for b in bars:
        s = core.session_start(b["t"], params["anchor_utc"])
        slot = (b["t"] - s) // core.IV
        if slot < n:
            by.setdefault(s, {})[slot] = b
    out = []
    for s in sorted(by):
        if s < before_ms and len(by[s]) == n:
            out.append((s, [by[s][i] for i in range(n)]))
    return out


def build_pool(sessions, n, window):
    ratios = [[] for _ in range(n)]
    for _, bars in sessions:
        for i in range(1, n):
            pc = bars[i - 1]["c"]
            b = bars[i]
            ratios[i].append((b["o"] / pc, b["h"] / pc, b["l"] / pc, b["c"] / pc))
    merged = []
    for i in range(n):
        m = []
        for k in range(max(1, i - window), min(n - 1, i + window) + 1):
            m.extend(ratios[k])
        merged.append(m)
    return merged


def percentile(sorted_vals, p):
    if not sorted_vals:
        return None
    i = min(len(sorted_vals) - 1, max(0, int(round(p / 100.0 * (len(sorted_vals) - 1)))))
    return sorted_vals[i]


def run_mc(plan, sessions, cfg, replays, seed, window):
    params = plan["params"]
    n = int(float(params["flat_by_hours"]) * 12)
    pool = build_pool(sessions, n, window)
    rng = random.Random(seed)
    entry, stop, target = plan["entry"], plan["stop"], plan["target"]
    e = int(plan["entry_slot"])
    counts = {"target": 0, "stop": 0, "open": 0}
    rs, open_prices, green = [], [], 0
    for _ in range(replays):
        price = entry
        outcome, exit_p = "open", None
        for slot in range(e + 1, n):
            _, h, l, c = rng.choice(pool[slot])
            if price * l <= stop:           # toca nos dois no mesmo candle: conta como stop
                outcome, exit_p = "stop", stop
                break
            if price * h >= target:
                outcome, exit_p = "target", target
                break
            price *= c
        if outcome == "open":
            exit_p = price
            open_prices.append(price)
        counts[outcome] += 1
        if outcome == "target" or (outcome == "open" and price > entry):
            green += 1
        rs.append(core.net_r(entry, exit_p, stop, cfg["fee_pct"], cfg["slippage_pct"]))
    open_prices.sort()
    return {"replays": replays, "seed": seed, "counts": counts,
            "pct": {k: v / replays * 100 for k, v in counts.items()},
            "green_pct": green / replays * 100, "avg_net_r": sum(rs) / len(rs),
            "open_p5": percentile(open_prices, 5), "open_p50": percentile(open_prices, 50),
            "open_p95": percentile(open_prices, 95)}


def block_length(n_sessions, n):
    """Comprimento médio do bloco no modo em blocos: a raiz cúbica do número de candles do
    histórico (regra usual para o bootstrap estacionário), no mínimo 2."""
    return max(2, int(round((n_sessions * n) ** (1 / 3.0))))


def run_mc_blocks(plan, sessions, cfg, replays, seed, mean_block=None):
    """Bootstrap estacionário (Politis & Romano, 1994): em vez de sortear cada candle solto,
    copia TRECHOS SEGUIDOS de sessões reais, no mesmo horário. A cada candle, com chance
    1/bloco_médio troca de sessão; senão continua na mesma. Mantém a sequência de calmaria e
    agitação dentro do trecho, que o sorteio solto perde. Mesmo resultado que run_mc devolve."""
    params = plan["params"]
    n = int(float(params["flat_by_hours"]) * 12)
    L = mean_block or block_length(len(sessions), n)
    p_new = 1.0 / L
    rng = random.Random(seed)
    entry, stop, target = plan["entry"], plan["stop"], plan["target"]
    e = int(plan["entry_slot"])
    counts = {"target": 0, "stop": 0, "open": 0}
    rs, open_prices, green = [], [], 0
    for _ in range(replays):
        price = entry
        outcome, exit_p = "open", None
        k = rng.randrange(len(sessions))
        for slot in range(e + 1, n):
            if slot > e + 1 and rng.random() < p_new:
                k = rng.randrange(len(sessions))
            bars = sessions[k][1]
            pc, b = bars[slot - 1]["c"], bars[slot]
            if price * b["l"] / pc <= stop:      # toca nos dois no mesmo candle: conta como stop
                outcome, exit_p = "stop", stop
                break
            if price * b["h"] / pc >= target:
                outcome, exit_p = "target", target
                break
            price *= b["c"] / pc
        if outcome == "open":
            exit_p = price
            open_prices.append(price)
        counts[outcome] += 1
        if outcome == "target" or (outcome == "open" and price > entry):
            green += 1
        rs.append(core.net_r(entry, exit_p, stop, cfg["fee_pct"], cfg["slippage_pct"]))
    open_prices.sort()
    return {"replays": replays, "seed": seed, "mean_block": L, "counts": counts,
            "pct": {k2: v / replays * 100 for k2, v in counts.items()},
            "green_pct": green / replays * 100, "avg_net_r": sum(rs) / len(rs),
            "open_p5": percentile(open_prices, 5), "open_p50": percentile(open_prices, 50),
            "open_p95": percentile(open_prices, 95)}


def run_history(plan, sessions, cfg):
    params = plan["params"]
    rule, r = plan["stop_rule"], plan["target_r"]
    out = {"sessions": len(sessions), "fired": 0, "target": 0, "stop": 0, "open": 0, "net_r": []}
    for s, bars in sessions:
        sig = core.orb_signal(bars, s + int(float(params["flat_by_hours"]) * 3600000), params, session=s)
        if sig["status"] != "triggered":
            continue
        t = sig["trigger"]
        entry = t["close"]
        stop = core.stop_price(sig, rule)
        target = entry + r * (entry - stop)
        outcome, exit_p = "open", bars[-1]["c"]
        for b in bars[t["slot"] + 1:]:
            if b["l"] <= stop:
                outcome, exit_p = "stop", stop
                break
            if b["h"] >= target:
                outcome, exit_p = "target", target
                break
        out["fired"] += 1
        out[outcome] += 1
        out["net_r"].append(core.net_r(entry, exit_p, stop, cfg["fee_pct"], cfg["slippage_pct"]))
    nr = out.pop("net_r")
    out["avg_net_r"] = sum(nr) / len(nr) if nr else None
    return out


def verdict(mc, plan, cfg):
    """Uma linha honesta. Olha só os replays que bateram em um dos lados."""
    c = mc["counts"]
    sides = c["target"] + c["stop"]
    if sides == 0:
        return "Sem dados suficientes: nenhum replay bateu no alvo nem no stop."
    r = plan["target_r"]
    entry, stop, target = plan["entry"], plan["stop"], plan["target"]
    risk = entry - stop
    cw = core.round_trip_cost(entry, target, cfg["fee_pct"], cfg["slippage_pct"]) / risk
    cl = core.round_trip_cost(entry, stop, cfg["fee_pct"], cfg["slippage_pct"]) / risk
    if r - cw <= 0:
        return ("Impossível empatar: taxa e slippage de ida e volta custam %.2fR, mais que o ganho do alvo (%gR). "
                "A faixa é estreita demais pro custo." % (cw, r))
    breakeven = (1 + cl) / (r - cw + 1 + cl)
    p = c["target"] / sides
    d = (p - breakeven) * 100
    base = "alvo veio primeiro em %.0f%% dos que bateram num lado; precisa de %.0f%% para empatar depois das taxas" % (
        p * 100, breakeven * 100)
    if abs(d) < 5:
        return "Perto de empate: " + base
    if d > 0:
        return ("Pende para o alvo: " if d < 15 else "Forte para o alvo: ") + base
    return ("Pende para o stop: " if d > -15 else "Forte para o stop: ") + base


def render(plan, mc, hist, verdict_txt, cfg, mc_b=None):
    pc, c = mc["pct"], mc["counts"]
    L = ["%s | entrada %g, stop %g, alvo %g (%gR) | %d replays, seed %d" % (
        plan["symbol"], plan["entry"], plan["stop"], plan["target"], plan["target_r"], mc["replays"], mc["seed"])]
    L.append("Alvo primeiro %.1f%% | stop primeiro %.1f%% | nenhum dos dois até zerar %.1f%%"
             % (pc["target"], pc["stop"], pc["open"]))
    if mc["open_p50"] is not None:
        L.append("Preço ao zerar (nos que ficaram abertos): mediana %g, faixa 5-95%%: %g a %g"
                 % (mc["open_p50"], mc["open_p5"], mc["open_p95"]))
    L.append("R médio líquido (já com taxa %.2f%% e slippage %.2f%% por lado): %+.2f"
             % (cfg["fee_pct"], cfg["slippage_pct"], mc["avg_net_r"]))
    if mc_b:
        pb = mc_b["pct"]
        L.append("Em blocos (trechos seguidos de sessões reais, bloco médio de %d candles): alvo %.1f%% | stop %.1f%% | "
                 "aberto %.1f%% | R médio líquido %+.2f" % (mc_b["mean_block"], pb["target"], pb["stop"], pb["open"], mc_b["avg_net_r"]))
    if hist["fired"]:
        L.append("Histórico real (%d sessões): a regra disparou %d vezes, %d no alvo, %d no stop, %d abertas; R médio líquido %+.2f"
                 % (hist["sessions"], hist["fired"], hist["target"], hist["stop"], hist["open"], hist["avg_net_r"]))
        if hist["fired"] < 30:
            L.append("Atenção: só %d disparos no histórico, amostra pequena demais pra concluir." % hist["fired"])
    else:
        L.append("Histórico real: a regra não disparou em nenhuma das %d sessões." % hist["sessions"])
    L.append("Veredito: " + verdict_txt)
    L.append("Isso é simulação com os candles recentes do próprio par, não previsão.")
    return "\n".join(L)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["run"])
    ap.add_argument("--plan")
    ap.add_argument("--days", type=int, default=60)
    ap.add_argument("--months", type=int, help="usa o histórico baixado por history.py (meses) em vez de --days")
    ap.add_argument("--replays", type=int, default=10000)
    ap.add_argument("--seed", type=int, default=19)
    ap.add_argument("--window", type=int, default=2)
    ap.add_argument("--fixture")
    ap.add_argument("--now")
    ap.add_argument("--config")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    cfg = core.load_config(a.config)
    plan = core.read_json(a.plan or core.path_in("plan.json"))
    if not plan:
        print("Erro: sem plano. Rode plan.py plan SYMBOL --write antes.")
        return 1
    try:
        now = core.now_ms(a.now)
        if a.fixture:
            bars = core.load_klines_file(a.fixture)
        elif a.months:
            history.fetch(plan["symbol"], a.months, now, log=lambda m: print(m, file=sys.stderr))
            bars = history.load(plan["symbol"], now, a.months)
        else:
            bars = core.get_klines_range(plan["symbol"], now - a.days * 86400000, now)
        bars = core.closed_only(bars, now)
        sessions = full_sessions(bars, plan["params"], plan["session_start"])
        if len(sessions) < 20:
            print("Erro: só %d sessões completas no histórico (mínimo 20). Aumente --days." % len(sessions))
            return 1
        mc = run_mc(plan, sessions, cfg, a.replays, a.seed, a.window)
        mc_b = run_mc_blocks(plan, sessions, cfg, a.replays, a.seed)
        hist = run_history(plan, sessions, cfg)
    except (core.TraderError, core.ApiError) as e:
        print("Erro: %s" % e)
        return 1
    v = verdict(mc, plan, cfg)
    result = {"plan": plan, "mc": mc, "mc_blocos": mc_b, "history": hist, "verdict": v}
    if a.write:
        core.write_json(core.path_in("timemachine.json"), result)
    print(json.dumps(result, indent=2) if a.json else render(plan, mc, hist, v, cfg, mc_b))
    return 0


if __name__ == "__main__":
    sys.exit(main())
