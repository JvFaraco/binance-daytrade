#!/usr/bin/env python3
"""research.py - testa nos seus dados as hipoteses que a literatura aponta como as unicas
que sobrevivem a taxa em cripto. Tudo com custo, treino/teste por walk-forward, varios pares.

  research.py hours  BTCUSDT [--months 12]           retorno medio por hora UTC (efeito de horario)
  research.py season BTCUSDT --buy 21 --sell 23       compra as 21:00 UTC, vende as 23:00, todo dia
  research.py trend  BTCUSDT [--lookbacks 10,20,40]   Donchian diario: compra no maximo de N dias,
                                                      sai no minimo de N/2 dias; so comprado
  research.py all    BTCUSDT,SOLUSDT,ETHUSDT          roda tudo e resume

Fontes: Padysak & Vojtko 2022 (seasonality/trend/MR em BTC horario); Concretum 2025
(Donchian ensemble em cripto, net of fees); arXiv 2606.00060 (walk-forward em BTC horario:
so sobrevive quem opera pouco e so com sinal maior que o custo).

Custos: taxa + slippage do config, por lado. Posicoes so compradas (spot).
Walk-forward: a serie e dividida em blocos de 3 meses; cada bloco e avaliado com os
parametros que foram melhores nos blocos ANTERIORES. O numero que vale e o "fora da amostra".
"""
import argparse
import math
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import core  # noqa: E402
import history  # noqa: E402

HOUR = 3600000
DAY = 86400000


# ---------------------------------------------------------------- agregação

def to_hourly(bars5m):
    """Candles de 5m -> horários (UTC)."""
    out, cur = [], None
    for b in bars5m:
        h = b["t"] // HOUR * HOUR
        if cur is None or cur["t"] != h:
            if cur:
                out.append(cur)
            cur = {"t": h, "o": b["o"], "h": b["h"], "l": b["l"], "c": b["c"], "v": b["v"], "n": 1}
        else:
            cur["h"] = max(cur["h"], b["h"])
            cur["l"] = min(cur["l"], b["l"])
            cur["c"] = b["c"]
            cur["v"] += b["v"]
            cur["n"] += 1
    if cur:
        out.append(cur)
    return [h for h in out if h["n"] >= 10]   # hora com buraco grande sai


def to_daily(bars, anchor_hour=0):
    out, cur = [], None
    for b in bars:
        d = (b["t"] - anchor_hour * HOUR) // DAY * DAY + anchor_hour * HOUR
        if cur is None or cur["t"] != d:
            if cur:
                out.append(cur)
            cur = {"t": d, "o": b["o"], "h": b["h"], "l": b["l"], "c": b["c"], "v": b["v"], "n": 1}
        else:
            cur["h"] = max(cur["h"], b["h"])
            cur["l"] = min(cur["l"], b["l"])
            cur["c"] = b["c"]
            cur["v"] += b["v"]
            cur["n"] += 1
    if cur:
        out.append(cur)
    return out


def cost_rt(cfg):
    """Custo de ida e volta como fração (0.003 para 0.10+0.05 por lado)."""
    return 2 * (cfg["fee_pct"] + cfg["slippage_pct"]) / 100.0


# ---------------------------------------------------------------- métricas

def summarize(rets, periods_per_year):
    """rets: lista de retornos por período (já líquidos). Equity composta."""
    if not rets:
        return {"n": 0, "total": 0.0, "cagr": None, "sharpe": None, "max_dd": 0.0, "win_pct": None}
    eq, peak, dd = 1.0, 1.0, 0.0
    for r in rets:
        eq *= 1 + r
        peak = max(peak, eq)
        dd = min(dd, eq / peak - 1)
    n = len(rets)
    years = n / periods_per_year
    mean = sum(rets) / n
    var = sum((r - mean) ** 2 for r in rets) / max(1, n - 1)
    sd = math.sqrt(var)
    sharpe = (mean / sd * math.sqrt(periods_per_year)) if sd > 0 else None
    wins = [r for r in rets if r != 0]
    return {"n": n, "total": round((eq - 1) * 100, 2),
            "cagr": round((eq ** (1 / years) - 1) * 100, 2) if years > 0 and eq > 0 else None,
            "sharpe": round(sharpe, 2) if sharpe is not None else None,
            "max_dd": round(dd * 100, 2),
            "win_pct": round(sum(1 for r in wins if r > 0) / len(wins) * 100, 1) if wins else None}


def buy_hold(bars):
    return [(bars[i]["c"] / bars[i - 1]["c"] - 1) for i in range(1, len(bars))]


# ---------------------------------------------------------------- 1. efeito de horário

def hour_profile(hourly):
    """Retorno médio (bps) por hora UTC, com erro-padrão e t. Sem custo: é diagnóstico."""
    by = {h: [] for h in range(24)}
    for i in range(1, len(hourly)):
        prev, cur = hourly[i - 1], hourly[i]
        if cur["t"] - prev["t"] != HOUR:
            continue
        hr = datetime.fromtimestamp(cur["t"] / 1000, timezone.utc).hour
        by[hr].append(cur["c"] / prev["c"] - 1)
    rows = []
    for h in range(24):
        xs = by[h]
        if len(xs) < 20:
            rows.append((h, len(xs), None, None, None))
            continue
        m = sum(xs) / len(xs)
        sd = math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))
        se = sd / math.sqrt(len(xs))
        rows.append((h, len(xs), m * 1e4, se * 1e4, m / se if se > 0 else None))
    return rows


# ---------------------------------------------------------------- 2. seasonality

def season_returns(hourly, buy_h, sell_h, cfg):
    """Compra no fechamento da hora buy_h-1 (= abertura de buy_h), vende no fechamento de sell_h-1.
    Um trade por dia, retorno líquido do custo de ida e volta."""
    by_day = {}
    for h in hourly:
        d = h["t"] // DAY
        hr = datetime.fromtimestamp(h["t"] / 1000, timezone.utc).hour
        by_day.setdefault(d, {})[hr] = h
    rets = []
    c = cost_rt(cfg)
    for d in sorted(by_day):
        hs = by_day[d]
        if buy_h not in hs or (sell_h - 1) not in hs:
            continue
        entry = hs[buy_h]["o"]
        exit_ = hs[sell_h - 1]["c"]
        rets.append(exit_ / entry - 1 - c)
    return rets


# ---------------------------------------------------------------- 3. trend Donchian diário

def donchian_returns(daily, lookback, cfg, exit_frac=0.5):
    """Só comprado. Entra quando o fechamento é o maior dos últimos `lookback` dias;
    sai quando é o menor dos últimos lookback*exit_frac dias. Executa no fechamento
    do dia do sinal. Retorno diário líquido (custo cobrado na entrada e na saída)."""
    ex_lb = max(2, int(lookback * exit_frac))
    rets, pos = [], 0
    c_side = (cfg["fee_pct"] + cfg["slippage_pct"]) / 100.0
    for i in range(lookback, len(daily)):
        prev_c, cur_c = daily[i - 1]["c"], daily[i]["c"]
        r = (cur_c / prev_c - 1) if pos else 0.0
        hi = max(d["c"] for d in daily[i - lookback:i])
        lo = min(d["c"] for d in daily[i - ex_lb:i])
        if pos and cur_c <= lo:
            pos = 0
            r -= c_side
        elif not pos and cur_c >= hi:
            pos = 1
            r -= c_side
        rets.append(r)
    return rets


def trades_count(rets, cfg):
    """Conta entradas pelos descontos de custo (aproximação suficiente pra relatório)."""
    c_side = (cfg["fee_pct"] + cfg["slippage_pct"]) / 100.0
    return sum(1 for r in rets if abs(r + c_side) < 1e-12 or (r != 0 and False))


# ---------------------------------------------------------------- walk-forward

def walk_forward(series_fn, params_list, n_blocks, metric="total"):
    """series_fn(params) -> lista de retornos por período, alinhada no tempo entre params.
    Divide em n_blocks; no bloco k usa os params que maximizaram `metric` nos blocos < k.
    Devolve (retornos fora da amostra concatenados, params escolhidos por bloco)."""
    all_rets = {tuple(sorted(p.items())): series_fn(p) for p in params_list}
    L = min(len(v) for v in all_rets.values())
    if L < n_blocks * 10:
        return [], []
    size = L // n_blocks
    oos, chosen = [], []
    for k in range(1, n_blocks):
        best, best_v = None, None
        for key, rets in all_rets.items():
            train = rets[-L:][: k * size]
            v = summarize(train, 1)[metric] if train else None
            if v is not None and (best_v is None or v > best_v):
                best, best_v = key, v
        if best is None:
            continue
        test = all_rets[best][-L:][k * size: (k + 1) * size]
        oos.extend(test)
        chosen.append(dict(best))
    return oos, chosen


# ---------------------------------------------------------------- relatório

def fmt(s):
    if not s["n"]:
        return "sem dados"
    return "total %+.1f%% | CAGR %s | Sharpe %s | DD máx %.1f%% | %d períodos%s" % (
        s["total"], ("%+.1f%%" % s["cagr"]) if s["cagr"] is not None else "-",
        ("%.2f" % s["sharpe"]) if s["sharpe"] is not None else "-", s["max_dd"], s["n"],
        (" | acerto %.0f%%" % s["win_pct"]) if s["win_pct"] is not None else "")


def run_symbol(sym, bars, cfg, lookbacks, buy_h, sell_h, out):
    hourly = to_hourly(bars)
    daily = to_daily(bars)
    out("\n=== %s | %d horas, %d dias | custo ida+volta %.2f%% ===" % (sym, len(hourly), len(daily), cost_rt(cfg) * 100))
    bh_d = buy_hold(daily)
    out("Comprar e segurar: " + fmt(summarize(bh_d, 365)))

    # 1. horário
    out("\n[1] Retorno médio por hora UTC (bps, sem custo; |t|>2 marcado):")
    rows = hour_profile(hourly)
    line = []
    for h, n, m, se, t in rows:
        if m is None:
            line.append("%02d:  -  " % h)
        else:
            line.append("%02d:%+5.1f%s" % (h, m, "*" if t is not None and abs(t) > 2 else " "))
        if len(line) == 6:
            out("   " + "  ".join(line))
            line = []
    sig = [(h, m, t) for h, n, m, se, t in rows if t is not None and abs(t) > 2]
    cost_bps = cost_rt(cfg) * 1e4
    if sig:
        out("   horas com |t|>2: " + ", ".join("%02dh %+.1f bps" % (h, m) for h, m, t in sig))
    else:
        out("   nenhuma hora com |t|>2 neste período")
    out("   o custo de ida e volta é %.0f bps: uma janela de 2h precisa de média > ~%.0f bps/h só pra empatar"
        % (cost_bps, cost_bps / 2))

    # 2. seasonality
    out("\n[2] Seasonality: compra %02d:00 UTC, vende %02d:00 UTC, todo dia (líquido):" % (buy_h, sell_h))
    sr = season_returns(hourly, buy_h, sell_h, cfg)
    out("   " + fmt(summarize(sr, 365)))
    gross = [r + cost_rt(cfg) for r in sr]
    out("   bruto (sem custo), só pra ver o tamanho do efeito: " + fmt(summarize(gross, 365)))

    # 3. trend Donchian, fixo por lookback
    out("\n[3] Trend Donchian diário, só comprado (líquido), por lookback:")
    for lb in lookbacks:
        dr = donchian_returns(daily, lb, cfg)
        n_tr = sum(1 for i in range(1, len(dr)) if dr[i] != 0 and dr[i - 1] == 0) + (1 if dr and dr[0] != 0 else 0)
        out("   N=%-3d %s | ~%d entradas" % (lb, fmt(summarize(dr, 365)), n_tr))

    # 3b. walk-forward escolhendo o lookback
    params = [{"lookback": lb} for lb in lookbacks]
    oos, chosen = walk_forward(lambda p: donchian_returns(daily, p["lookback"], cfg), params, n_blocks=4)
    if oos:
        out("   walk-forward (lookback escolhido só com o passado): " + fmt(summarize(oos, 365)))
        out("   lookbacks escolhidos por bloco: " + ", ".join(str(c["lookback"]) for c in chosen))
        bh_oos = bh_d[-len(oos):]
        out("   comprar e segurar no mesmo trecho:                  " + fmt(summarize(bh_oos, 365)))
    else:
        out("   walk-forward: dados insuficientes")
    return {"season": summarize(sr, 365), "trend_wf": summarize(oos, 365) if oos else None,
            "bh": summarize(bh_d, 365)}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["hours", "season", "trend", "all"])
    ap.add_argument("symbols", help="um ou mais pares separados por vírgula")
    ap.add_argument("--months", type=int, default=12)
    ap.add_argument("--buy", type=int, default=21)
    ap.add_argument("--sell", type=int, default=23)
    ap.add_argument("--lookbacks", default="10,20,30,40,55")
    ap.add_argument("--fixture", help="offline: arquivo de candles (um símbolo só)")
    ap.add_argument("--now")
    ap.add_argument("--config")
    a = ap.parse_args(argv)
    cfg = core.load_config(a.config)
    now = core.now_ms(a.now)
    lookbacks = [int(x) for x in a.lookbacks.split(",")]
    results = {}
    for sym in [s.strip().upper() for s in a.symbols.split(",") if s.strip()]:
        try:
            if a.fixture:
                bars = core.closed_only(core.load_klines_file(a.fixture), now)
            else:
                history.fetch(sym, a.months, now, log=lambda m: print(m, file=sys.stderr))
                bars = history.load(sym, now, a.months)
        except core.ApiError as e:
            print("Erro em %s: %s" % (sym, e))
            continue
        if len(bars) < 60 * 288:
            print("%s: só %d candles (menos de 60 dias). Baixe mais meses." % (sym, len(bars)))
            continue
        if a.cmd == "hours":
            hourly = to_hourly(bars)
            print("%s: retorno médio por hora UTC (bps), n, t" % sym)
            for h, n, m, se, t in hour_profile(hourly):
                print("  %02d  n=%4d  %s" % (h, n, ("%+6.1f  t=%+.2f" % (m, t)) if m is not None else "-"))
            continue
        if a.cmd == "season":
            sr = season_returns(to_hourly(bars), a.buy, a.sell, cfg)
            print("%s compra %02d vende %02d UTC: %s" % (sym, a.buy, a.sell, fmt(summarize(sr, 365))))
            continue
        if a.cmd == "trend":
            daily = to_daily(bars)
            for lb in lookbacks:
                print("%s N=%d: %s" % (sym, lb, fmt(summarize(donchian_returns(daily, lb, cfg), 365))))
            continue
        results[sym] = run_symbol(sym, bars, cfg, lookbacks, a.buy, a.sell, print)
    if a.cmd == "all" and results:
        print("\n=== Resumo ===")
        print("%-10s %-28s %-28s %-28s" % ("par", "comprar e segurar", "seasonality líquida", "trend walk-forward"))
        for sym, r in results.items():
            def short(s):
                if not s or not s["n"]:
                    return "-"
                return "%+.0f%% Sh %s DD %.0f%%" % (s["total"], ("%.2f" % s["sharpe"]) if s["sharpe"] is not None else "-", s["max_dd"])
            print("%-10s %-28s %-28s %-28s" % (sym, short(r["bh"]), short(r["season"]), short(r["trend_wf"])))
        print("\nComo ler: o que importa é o walk-forward e a comparação com comprar e segurar no MESMO trecho.")
        print("Um ano é pouco. Se algo parecer bom, rode com --months 24 ou 36 antes de acreditar.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
