#!/usr/bin/env python3
"""lab.py - laboratorio de estrategias: as populares e as da literatura na MESMA regua.

  lab.py fetch                                baixa 5m dos 5 pares e o diario do universo da rotacao
  lab.py run [--out web/public/cemiterio.json] roda tudo e grava o resultado
  lab.py show [--file ...]                    resumo do resultado no console

Regua (igual para todas):
- custo por lado c (taxa + slippage), cobrado como fator (1 - c) a cada lado negociado,
  na proporcao do patrimonio que girou; o resultado sai para 41 custos, de 0 a 0,20%;
- so comprado, spot, posicao cheia (ou fracoes, no grid e na rotacao);
- 36 meses fechados, 5 pares; os 7 meses anteriores so aquecem os indicadores;
- walk-forward em blocos de 3 meses: cada bloco usa a variante com melhor Sharpe nos
  blocos ANTERIORES; o primeiro bloco so treina. So o trecho fora da amostra conta;
- comparacao com comprar e segurar e com DCA semanal no mesmo trecho;
- detector de sorte: Sharpe deflacionado (Bailey & Lopez de Prado, 2014) contando todas
  as variacoes testadas, e probabilidade de overfitting por CSCV (Bailey et al., 2017);
- custo de equilibrio: o custo por lado em que o lucro fora da amostra zera.

"Viva" = Sharpe liquido maior que o de comprar e segurar no mesmo trecho E Sharpe
deflacionado >= 0,95, em pelo menos 3 dos 5 pares. A rotacao e uma carteira: e julgada
contra comprar e segurar BTC.
"""
import argparse
import itertools
import json
import math
import os
import sys
from datetime import datetime, timezone
from statistics import NormalDist

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import core  # noqa: E402
import history  # noqa: E402
from research import to_daily, to_hourly  # noqa: E402

HOUR = 3600000
DAY = 86400000
PAIRS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"]
EVAL_MONTHS = 36
WARMUP_MONTHS = 7
BLOCK_MONTHS = 3
COSTS = [round(i * 0.005, 3) for i in range(41)]       # % por lado, os mesmos passos do controle do site
DEFAULT_COST = 0.15
ALIVE_DSR = 0.95
ALIVE_MIN_PAIRS = 3
ND = NormalDist()
EULER = 0.5772156649015329

# rotação: o que não é moeda volátil fica fora do universo
NOT_COINS = {"USDC", "FDUSD", "TUSD", "USDP", "DAI", "BUSD", "EUR", "AEUR", "EURI", "USDE", "USD1", "BFUSD",
             "XUSD", "PYUSD", "RLUSD", "USDS", "U", "WBTC", "WBETH", "BETH", "PAXG", "XAUT", "BNSOL"}
ROT_CANDIDATES = 40
ROT_UNIVERSE = 20
ROT_HOLD = 5


# ---------------------------------------------------------------- tempo

def month_start(y, m):
    return int(datetime(y, m, 1, tzinfo=timezone.utc).timestamp() * 1000)


def add_months(y, m, k):
    i = y * 12 + (m - 1) + k
    return i // 12, i % 12 + 1


def window(now_ms):
    """(início dos dados, início da avaliação, fim) em ms: meses fechados antes de now."""
    d = datetime.fromtimestamp(now_ms / 1000, timezone.utc)
    end = month_start(d.year, d.month)
    ey, em = add_months(d.year, d.month, -EVAL_MONTHS)
    dy, dm = add_months(d.year, d.month, -(EVAL_MONTHS + WARMUP_MONTHS))
    return month_start(dy, dm), month_start(ey, em), end


def blocks_for(eval_start, end):
    """Índices de dia [início, fim) de cada bloco de BLOCK_MONTHS meses."""
    d = datetime.fromtimestamp(eval_start / 1000, timezone.utc)
    y, m = d.year, d.month
    d0, out = eval_start // DAY, []
    cur = eval_start
    while cur < end:
        y, m = add_months(y, m, BLOCK_MONTHS)
        nxt = min(month_start(y, m), end)
        out.append((cur // DAY - d0, nxt // DAY - d0))
        cur = nxt
    return out


def weekday(t):
    """0 = segunda ... 6 = domingo (UTC)."""
    return (t // DAY + 3) % 7


def ymd(t):
    return datetime.fromtimestamp(t / 1000, timezone.utc).strftime("%Y-%m-%d")


# ---------------------------------------------------------------- séries diárias

def new_series(nd):
    """G: multiplicador bruto do dia; T: giro (lados, em fração do patrimônio); E: entradas;
    X: fração do dia exposta."""
    return {"G": [1.0] * nd, "T": [0.0] * nd, "E": [0] * nd, "X": [0.0] * nd}


def from_positions(bars, pos, d0, nd):
    """pos[i] é decidida no fechamento da barra i e vale para a barra i+1.
    Retorno da barra i+1 = pos[i] x variação; o giro entra no dia da decisão."""
    s = new_series(nd)
    cnt = [0] * nd
    prev = 0.0
    for i, b in enumerate(bars):
        d = b["t"] // DAY - d0
        if 0 <= d < nd:
            if i > 0:
                if prev:
                    s["G"][d] *= 1 + prev * (b["c"] / bars[i - 1]["c"] - 1)
                s["X"][d] += prev
                cnt[d] += 1
            p = pos[i]
            s["T"][d] += abs(p - prev)
            if p > prev:
                s["E"][d] += 1
        prev = pos[i]
    for d in range(nd):
        if cnt[d]:
            s["X"][d] /= cnt[d]
    return s


def net_returns(s, c):
    """Retornos diários líquidos com custo c (fração por lado)."""
    k = 1 - c
    return [g * (k ** t) - 1 if t else g - 1 for g, t in zip(s["G"], s["T"])]


# ---------------------------------------------------------------- indicadores

def sma(xs, n):
    out, acc = [None] * len(xs), 0.0
    for i, x in enumerate(xs):
        acc += x
        if i >= n:
            acc -= xs[i - n]
        if i >= n - 1:
            out[i] = acc / n
    return out


def ema(xs, n):
    """Média exponencial com semente = média simples dos n primeiros valores definidos."""
    out = [None] * len(xs)
    a = 2.0 / (n + 1)
    vals, prev = [], None
    for i, x in enumerate(xs):
        if x is None:
            continue
        if prev is None:
            vals.append(x)
            if len(vals) == n:
                prev = sum(vals) / n
                out[i] = prev
            continue
        prev = a * x + (1 - a) * prev
        out[i] = prev
    return out


def rsi(closes, n=14):
    """RSI de Wilder."""
    out = [None] * len(closes)
    if len(closes) <= n:
        return out
    gains = losses = 0.0
    for i in range(1, n + 1):
        ch = closes[i] - closes[i - 1]
        gains += max(ch, 0)
        losses += max(-ch, 0)
    ag, al = gains / n, losses / n

    def val(g, l):
        return 100.0 if l == 0 else 100 - 100 / (1 + g / l)
    out[n] = val(ag, al)
    for i in range(n + 1, len(closes)):
        ch = closes[i] - closes[i - 1]
        ag = (ag * (n - 1) + max(ch, 0)) / n
        al = (al * (n - 1) + max(-ch, 0)) / n
        out[i] = val(ag, al)
    return out


def atr(bars, n):
    """ATR de Wilder (semente = média simples dos n primeiros true ranges)."""
    out = [None] * len(bars)
    trs = []
    prev = None
    for i, b in enumerate(bars):
        tr = b["h"] - b["l"] if i == 0 else max(b["h"] - b["l"], abs(b["h"] - bars[i - 1]["c"]), abs(b["l"] - bars[i - 1]["c"]))
        if prev is None:
            trs.append(tr)
            if len(trs) == n:
                prev = sum(trs) / n
                out[i] = prev
            continue
        prev = (prev * (n - 1) + tr) / n
        out[i] = prev
    return out


def rolling(xs, n, fn):
    return [fn(xs[i - n + 1:i + 1]) if i >= n - 1 else None for i in range(len(xs))]


# ---------------------------------------------------------------- regras de posição (0 ou 1)

def pos_ma_cross(bars, fast, slow, kind):
    cl = [b["c"] for b in bars]
    f = (ema if kind == "ema" else sma)(cl, fast)
    s = (ema if kind == "ema" else sma)(cl, slow)
    return [1.0 if (a is not None and b is not None and a > b) else 0.0 for a, b in zip(f, s)]


def pos_rsi(bars, n=14, lo=30, hi=70):
    r = rsi([b["c"] for b in bars], n)
    out, p = [], 0.0
    for v in r:
        if v is not None:
            if not p and v < lo:
                p = 1.0
            elif p and v > hi:
                p = 0.0
        out.append(p)
    return out


def pos_macd(bars, fast=12, slow=26, sig=9):
    cl = [b["c"] for b in bars]
    ef, es = ema(cl, fast), ema(cl, slow)
    line = [a - b if a is not None and b is not None else None for a, b in zip(ef, es)]
    sl = ema(line, sig)
    return [1.0 if (m is not None and s is not None and m > s) else 0.0 for m, s in zip(line, sl)]


def pos_bollinger(bars, n=20, k=2.0):
    """Volta à média, só comprado: compra fechando abaixo da banda de baixo, sai acima da média."""
    cl = [b["c"] for b in bars]
    out, p = [], 0.0
    for i in range(len(cl)):
        if i >= n - 1:
            w = cl[i - n + 1:i + 1]
            m = sum(w) / n
            sd = math.sqrt(sum((x - m) ** 2 for x in w) / n)
            if not p and cl[i] < m - k * sd:
                p = 1.0
            elif p and cl[i] > m:
                p = 0.0
        out.append(p)
    return out


def pos_supertrend(bars, n=10, mult=3.0):
    a = atr(bars, n)
    out, fub, flb, trend = [], None, None, 1
    for i, b in enumerate(bars):
        if a[i] is None:
            out.append(0.0)
            continue
        hl2 = (b["h"] + b["l"]) / 2
        ub, lb = hl2 + mult * a[i], hl2 - mult * a[i]
        pc = bars[i - 1]["c"] if i else b["c"]
        fub = ub if fub is None or ub < fub or pc > fub else fub
        flb = lb if flb is None or lb > flb or pc < flb else flb
        if trend == 1 and b["c"] < flb:
            trend = -1
        elif trend == -1 and b["c"] > fub:
            trend = 1
        out.append(1.0 if trend == 1 else 0.0)
    return out


def pos_ichimoku(bars, t=9, k=26, s=52):
    """Comprado com o fechamento acima da nuvem (traçada 26 períodos antes) e Tenkan acima de Kijun."""
    hi, lo = [b["h"] for b in bars], [b["l"] for b in bars]
    mid = lambda n: [((max(hi[i - n + 1:i + 1]) + min(lo[i - n + 1:i + 1])) / 2) if i >= n - 1 else None for i in range(len(bars))]
    ten, kij, sb = mid(t), mid(k), mid(s)
    out = []
    for i, b in enumerate(bars):
        j = i - k
        if j < 0 or ten[i] is None or kij[i] is None or ten[j] is None or kij[j] is None or sb[j] is None:
            out.append(0.0)
            continue
        cloud = max((ten[j] + kij[j]) / 2, sb[j])
        out.append(1.0 if b["c"] > cloud and ten[i] > kij[i] else 0.0)
    return out


def pos_ts_momentum(bars, lookback):
    """Revisão no fechamento de domingo (UTC): comprado na semana seguinte se o retorno de
    `lookback` dias for positivo."""
    out, p = [], 0.0
    for i, b in enumerate(bars):
        if weekday(b["t"]) == 6 and i >= lookback:
            p = 1.0 if b["c"] > bars[i - lookback]["c"] else 0.0
        out.append(p)
    return out


def pos_trend_filter(bars, n):
    m = sma([b["c"] for b in bars], n)
    return [1.0 if v is not None and b["c"] > v else 0.0 for b, v in zip(bars, m)]


def pos_donchian(bars, lookback):
    """Como no research.py: entra no maior fechamento de N dias, sai no menor de N/2."""
    ex = max(2, int(lookback * 0.5))
    out, p = [], 0.0
    for i, b in enumerate(bars):
        if i >= lookback:
            if p and b["c"] <= min(x["c"] for x in bars[i - ex:i]):
                p = 0.0
            elif not p and b["c"] >= max(x["c"] for x in bars[i - lookback:i]):
                p = 1.0
        out.append(p)
    return out


def pos_weekend(bars):
    """Barras diárias: comprado no sábado e no domingo (decide no fechamento de sexta)."""
    return [1.0 if weekday(b["t"]) in (4, 5) else 0.0 for b in bars]


def pos_season(hourly, buy_h=21, sell_h=23):
    """Comprado nas horas buy_h..sell_h-1 UTC (decide no fechamento da hora anterior)."""
    out = []
    for i in range(len(hourly)):
        nxt = hourly[i + 1]["t"] if i + 1 < len(hourly) else hourly[i]["t"] + HOUR
        h = nxt // HOUR % 24
        out.append(1.0 if buy_h <= h < sell_h else 0.0)
    return out


# ---------------------------------------------------------------- estratégias por operação

def orb_series(m5, d0, nd, cfg, stop_rule, target_r):
    """O rompimento do projeto (scan.py/plan.py) em cada sessão, posição cheia, sem buffer."""
    from backtest import sessions_for
    params = {"anchor_utc": cfg["anchor_utc"], "range_minutes": cfg["range_minutes"],
              "entry_window_minutes": cfg["entry_window_minutes"], "flat_by_hours": cfg["flat_by_hours"]}
    flat_ms = int(float(cfg["flat_by_hours"]) * HOUR)
    s = new_series(nd)
    for start, bars in sessions_for(m5, cfg["anchor_utc"], cfg["flat_by_hours"]):
        d = start // DAY - d0
        if not 0 <= d < nd:
            continue
        sig = core.orb_signal(bars, start + flat_ms, params, session=start)
        if sig["status"] != "triggered":
            continue
        if sig["range_pct"] < cfg["min_range_pct"] or sig["trigger"]["pct_over"] > cfg["max_chase_pct"]:
            continue
        t = sig["trigger"]
        entry = t["close"]
        stop = core.stop_price(sig, stop_rule)
        if stop >= entry:
            continue
        target = entry + target_r * (entry - stop)
        exit_p, held = bars[-1]["c"], len(bars) - t["slot"] - 1
        for j, b in enumerate(bars[t["slot"] + 1:]):
            if b["l"] <= stop:
                exit_p, held = stop, j + 1
                break
            if b["h"] >= target:
                exit_p, held = target, j + 1
                break
        s["G"][d] *= exit_p / entry
        s["T"][d] += 2
        s["E"][d] += 1
        s["X"][d] += held / 288.0
    return s


def by_day(bars):
    out = {}
    for b in bars:
        out.setdefault(b["t"] // DAY, []).append(b)
    return out


def dual_thrust_series(m5, daily, d0, nd, n=4, k=0.5):
    """Dual Thrust só comprado: compra quando o preço passa da abertura + k x faixa dos N dias
    anteriores; sai na abertura - k x faixa ou no fim do dia. Uma entrada por dia."""
    s = new_series(nd)
    idx = {b["t"] // DAY: i for i, b in enumerate(daily)}
    for day, bars in by_day(m5).items():
        d = day - d0
        i = idx.get(day)
        if not 0 <= d < nd or i is None or i < n:
            continue
        prev = daily[i - n:i]
        hh, ll = max(x["h"] for x in prev), min(x["l"] for x in prev)
        hc, lc = max(x["c"] for x in prev), min(x["c"] for x in prev)
        rng = max(hh - lc, hc - ll)
        op = bars[0]["o"]
        up, dn = op + k * rng, op - k * rng
        entry, exit_p, held = None, None, 0
        for b in bars:
            if entry is None:
                if b["h"] >= up:
                    entry = max(up, b["o"])
                continue
            held += 1
            if b["l"] <= dn:
                exit_p = min(dn, b["o"])
                break
        if entry is None:
            continue
        if exit_p is None:
            exit_p = bars[-1]["c"]
        s["G"][d] *= exit_p / entry
        s["T"][d] += 2
        s["E"][d] += 1
        s["X"][d] += held / 288.0
    return s


def grid_series(hourly, d0, nd, levels, width=0.10):
    """Grid como o Spot Grid da Binance: faixa geométrica de ±width em torno do preço de
    abertura do mês, `levels` degraus, capital dividido igual. Degrau acima do preço é
    comprado no início; os outros compram quando o preço PASSA abaixo do degrau e vendem
    quando PASSA acima do degrau de cima (ordem limite: só executa se o preço atravessa).
    Uma barra não compra e vende o mesmo degrau. No fim do mês vende tudo e recomeça."""
    s = new_series(nd)
    months = {}
    for b in hourly:
        d = datetime.fromtimestamp(b["t"] / 1000, timezone.utc)
        months.setdefault((d.year, d.month), []).append(b)
    eq = 1.0
    last_day, day_start_eq = None, None
    for key in sorted(months):
        bars = months[key]
        p0 = bars[0]["o"]
        lo, hi = p0 * (1 - width), p0 * (1 + width)
        lv = [lo * (hi / lo) ** (j / levels) for j in range(levels + 1)]
        q = eq / levels
        cash = [0.0] * levels
        coin = [0.0] * levels
        turnover0 = 0.0
        for j in range(levels):
            if lv[j] >= p0:
                coin[j] = q / p0
                turnover0 += q
            else:
                cash[j] = q
        for bi, b in enumerate(bars):
            day = b["t"] // DAY
            d = day - d0
            if day != last_day:
                if last_day is not None and 0 <= last_day - d0 < nd:
                    s["G"][last_day - d0] *= eq / day_start_eq
                last_day, day_start_eq = day, eq
            turn = turnover0 if bi == 0 else 0.0
            for j in range(levels):
                if cash[j] > 0 and b["l"] < lv[j]:
                    coin[j] = cash[j] / lv[j]
                    turn += cash[j]
                    cash[j] = 0.0
                    if 0 <= d < nd:
                        s["E"][d] += 1
                elif coin[j] > 0 and b["h"] > lv[j + 1]:      # elif: não compra e vende na mesma barra
                    cash[j] = coin[j] * lv[j + 1]
                    turn += cash[j]
                    coin[j] = 0.0
            held = sum(coin) * b["c"]
            eq_now = sum(cash) + held
            if bi == len(bars) - 1:          # fim do mês: vende o que sobrou
                turn += held
                cash = [eq_now / levels] * levels
                coin = [0.0] * levels
            if 0 <= d < nd:
                s["T"][d] += turn / eq_now if eq_now > 0 else 0.0
                s["X"][d] += (held / eq_now if eq_now > 0 else 0.0) / 24.0
            eq = eq_now
    if last_day is not None and 0 <= last_day - d0 < nd:
        s["G"][last_day - d0] *= eq / day_start_eq
    return s


def rotation_series(universe, d0, nd, lookback):
    """Carteira semanal: no fechamento de domingo, entre as ROT_UNIVERSE moedas de maior volume
    nos 30 dias anteriores, compra em pesos iguais as ROT_HOLD de maior alta em `lookback` dias
    (só as que subiram; o resto fica em caixa)."""
    s = new_series(nd)
    syms = sorted(universe)
    closes = {k: {b["t"] // DAY: b["c"] for b in v} for k, v in universe.items()}
    vols = {k: {b["t"] // DAY: b["v"] for b in v} for k, v in universe.items()}
    days = sorted({d for v in closes.values() for d in v})
    w = {}
    for idx, day in enumerate(days):
        d = day - d0
        if w:
            r = 0.0
            for k, wk in list(w.items()):
                c1, c0 = closes[k].get(day), closes[k].get(day - 1)
                rk = (c1 / c0 - 1) if c1 and c0 else 0.0
                r += wk * rk
                w[k] = wk * (1 + rk)
            tot = 1 + r
            for k in w:
                w[k] /= tot
            if 0 <= d < nd:
                s["G"][d] *= tot
                s["X"][d] = sum(w.values())
        if weekday(day * DAY) == 6 and idx >= 30:
            live = [k for k in syms if day in closes[k] and (day - lookback) in closes[k]
                    and sum(1 for x in range(day - 29, day + 1) if x in vols[k]) >= 25]
            live.sort(key=lambda k: -sum(vols[k].get(x, 0.0) for x in range(day - 29, day + 1)))
            uni = live[:ROT_UNIVERSE]
            mom = sorted(((closes[k][day] / closes[k][day - lookback] - 1, k) for k in uni), reverse=True)
            pick = [k for m, k in mom[:ROT_HOLD] if m > 0]
            target = {k: 1.0 / ROT_HOLD for k in pick}
            turn = sum(abs(target.get(k, 0.0) - w.get(k, 0.0)) for k in set(target) | set(w))
            if 0 <= d < nd:
                s["T"][d] += turn
                s["E"][d] += sum(1 for k in pick if k not in w)
            w = target
    return s


# ---------------------------------------------------------------- catálogo

def _pos(bars_key, fn):
    return lambda ctx: from_positions(ctx[bars_key], fn(ctx[bars_key]), ctx["d0"], ctx["nd"])


STRATEGIES = [
    {"key": "ma", "name": "Cruzamento de médias", "group": "varejo",
     "rule": "Comprado com a média rápida acima da lenta.",
     "variants": [("EMA 9/21 · 1h", _pos("h1", lambda b: pos_ma_cross(b, 9, 21, "ema"))),
                  ("SMA 50/200 · diário", _pos("d1", lambda b: pos_ma_cross(b, 50, 200, "sma")))]},
    {"key": "rsi", "name": "RSI 30/70", "group": "varejo",
     "rule": "RSI(14): compra abaixo de 30, vende acima de 70.",
     "variants": [("1h", _pos("h1", pos_rsi)), ("diário", _pos("d1", pos_rsi))]},
    {"key": "macd", "name": "MACD", "group": "varejo",
     "rule": "MACD(12, 26, 9): comprado com a linha acima do sinal.",
     "variants": [("1h", _pos("h1", pos_macd)), ("diário", _pos("d1", pos_macd))]},
    {"key": "boll", "name": "Bandas de Bollinger", "group": "varejo",
     "rule": "Bollinger(20, 2): compra abaixo da banda de baixo, sai acima da média.",
     "variants": [("1h", _pos("h1", pos_bollinger)), ("diário", _pos("d1", pos_bollinger))]},
    {"key": "st", "name": "SuperTrend", "group": "varejo",
     "rule": "SuperTrend(10, 3): comprado com a tendência para cima.",
     "variants": [("1h", _pos("h1", pos_supertrend)), ("diário", _pos("d1", pos_supertrend))]},
    {"key": "ichi", "name": "Ichimoku", "group": "varejo",
     "rule": "Ichimoku(9, 26, 52): comprado acima da nuvem com Tenkan acima de Kijun.",
     "variants": [("diário", _pos("d1", pos_ichimoku))]},
    {"key": "grid", "name": "Grid (robô da Binance)", "group": "varejo",
     "rule": "Faixa de ±10% em torno da abertura do mês, compra e vende em degraus; recomeça todo mês.",
     "variants": [("10 degraus", lambda c: grid_series(c["h1"], c["d0"], c["nd"], 10)),
                  ("20 degraus", lambda c: grid_series(c["h1"], c["d0"], c["nd"], 20))]},
    {"key": "mom", "name": "Momentum de tendência", "group": "literatura",
     "rule": "Revisão semanal: comprado se o retorno dos últimos N dias for positivo.",
     "variants": [("%d dias" % n, _pos("d1", (lambda n: lambda b: pos_ts_momentum(b, n))(n))) for n in (20, 60, 120)]},
    {"key": "tf", "name": "Comprar e segurar com filtro", "group": "literatura",
     "rule": "Comprado só com o preço acima da média de N dias.",
     "variants": [("média de %d dias" % n, _pos("d1", (lambda n: lambda b: pos_trend_filter(b, n))(n))) for n in (100, 200)]},
    {"key": "dt", "name": "Dual Thrust", "group": "literatura",
     "rule": "Compra quando passa da abertura + k × faixa dos 4 dias anteriores; sai no fim do dia.",
     "variants": [("k = %.1f" % k, (lambda k: lambda c: dual_thrust_series(c["m5"], c["d1"], c["d0"], c["nd"], 4, k))(k)) for k in (0.5, 0.7)]},
    {"key": "wknd", "name": "Fim de semana", "group": "literatura",
     "rule": "Comprado de sábado 00h a segunda 00h UTC.",
     "variants": [("sáb e dom", _pos("d1", pos_weekend))]},
    {"key": "orb", "name": "Rompimento da faixa inicial", "group": "referencia",
     "rule": "A regra do projeto: primeira hora a partir das 13h UTC, compra no rompimento do topo.",
     "variants": [("stop %s · alvo %sR" % (st, tg), (lambda st, tg: lambda c: orb_series(c["m5"], c["d0"], c["nd"], c["cfg"], st, tg))(st, tg))
                  for st in ("or-mid", "or-low") for tg in (1.5, 2.0)]},
    {"key": "season", "name": "Horário 21–23h UTC", "group": "referencia",
     "rule": "Compra às 21h UTC e vende às 23h, todo dia.",
     "variants": [("21–23h", _pos("h1", pos_season))]},
    {"key": "don", "name": "Donchian", "group": "referencia",
     "rule": "Compra no maior fechamento de N dias, sai no menor de N/2.",
     "variants": [("N = %d" % n, _pos("d1", (lambda n: lambda b: pos_donchian(b, n))(n))) for n in (10, 20, 30, 40, 55)]},
]
ROTATION = {"key": "rot", "name": "Rotação entre as maiores", "group": "literatura",
            "rule": "Toda semana, entre as 20 moedas de maior volume, compra as 5 que mais subiram (só as que subiram).",
            "variants": [("%d dias" % n, n) for n in (7, 28)]}


def n_trials():
    return sum(len(s["variants"]) for s in STRATEGIES) + len(ROTATION["variants"])


# ---------------------------------------------------------------- métricas

class Prefix:
    """Somas acumuladas para Sharpe de qualquer trecho em O(1)."""

    def __init__(self, r):
        self.s, self.q = [0.0], [0.0]
        for x in r:
            self.s.append(self.s[-1] + x)
            self.q.append(self.q[-1] + x * x)

    def sharpe(self, a, b):
        n = b - a
        if n < 2:
            return None
        m = (self.s[b] - self.s[a]) / n
        var = (self.q[b] - self.q[a] - n * m * m) / (n - 1)
        return m / math.sqrt(var) if var > 1e-18 else None


def moments(r):
    n = len(r)
    m = sum(r) / n
    var = sum((x - m) ** 2 for x in r) / n
    if var <= 1e-18:
        return m, 0.0, 0.0, 3.0
    sd = math.sqrt(var)
    skew = sum((x - m) ** 3 for x in r) / n / sd ** 3
    kurt = sum((x - m) ** 4 for x in r) / n / var ** 2
    return m, sd, skew, kurt


def stats(r, entries=None, exposure=None):
    eq, peak, dd = 1.0, 1.0, 0.0
    for x in r:
        eq *= 1 + x
        peak = max(peak, eq)
        dd = min(dd, eq / peak - 1)
    n = len(r)
    m = sum(r) / n
    var = sum((x - m) ** 2 for x in r) / (n - 1) if n > 1 else 0.0
    sd = math.sqrt(var)
    sr = m / sd if sd > 1e-12 else None
    return {"total": (eq - 1) * 100, "sr": sr, "sharpe": sr * math.sqrt(365) if sr is not None else None,
            "dd": dd * 100, "trades": sum(entries) if entries is not None else None,
            "exposure": (sum(exposure) / n * 100) if exposure is not None and n else None}


def luck_hurdle(trials, var_sr):
    """O Sharpe (por dia) que a melhor de `trials` tentativas SEM habilidade nenhuma atinge,
    em média, só por sorte (Bailey & López de Prado, 2014)."""
    if trials <= 1 or var_sr <= 0:
        return 0.0
    return math.sqrt(var_sr) * ((1 - EULER) * ND.inv_cdf(1 - 1.0 / trials) + EULER * ND.inv_cdf(1 - 1.0 / (trials * math.e)))


def null_var(t):
    """Variância do Sharpe estimado em t dias quando o Sharpe verdadeiro é zero.
    Usar a variância observada entre as tentativas faria as estratégias desastrosas
    (Sharpe muito negativo) subirem a barra de todas; a hipótese a vencer é 'ninguém
    tem habilidade', e nela a dispersão entre tentativas é só a do erro de estimação."""
    return 1.0 / (t - 1) if t > 1 else 0.0


def deflated_sharpe(sr, t, skew, kurt, trials, var_sr):
    """Probabilidade de o Sharpe (por dia) ser maior que o melhor que a sorte daria
    em `trials` tentativas com variância `var_sr` entre elas (Bailey & López de Prado, 2014)."""
    if sr is None or t < 3:
        return None
    sr0 = luck_hurdle(trials, var_sr)
    den = 1 - skew * sr + (kurt - 1) / 4.0 * sr * sr
    if den <= 0:
        return None
    return ND.cdf((sr - sr0) * math.sqrt(t - 1) / math.sqrt(den))


def pbo_cscv(mat, s=8):
    """Probabilidade de overfitting (CSCV): em quantas divisões treino/teste a variante
    campeã do treino fica na metade de baixo do teste. None com menos de 2 variantes."""
    p = len(mat)
    if p < 2:
        return None
    L = len(mat[0])
    size = L // s
    if size < 5:
        return None
    sums = [[sum(row[i * size:(i + 1) * size]) for i in range(s)] for row in mat]
    sqs = [[sum(x * x for x in row[i * size:(i + 1) * size]) for i in range(s)] for row in mat]

    def sr(v, blocks):
        n = size * len(blocks)
        a = sum(sums[v][b] for b in blocks)
        q = sum(sqs[v][b] for b in blocks)
        m = a / n
        var = (q - n * m * m) / (n - 1)
        return m / math.sqrt(var) if var > 1e-18 else -1e9
    below, total = 0, 0
    for ins in itertools.combinations(range(s), s // 2):
        outs = [b for b in range(s) if b not in ins]
        is_sr = [sr(v, ins) for v in range(p)]
        best = max(range(p), key=lambda v: is_sr[v])
        os_sr = [sr(v, outs) for v in range(p)]
        rank = 1 + sum(1 for v in range(p) if os_sr[v] < os_sr[best])
        w = rank / (p + 1.0)
        below += 1 if math.log(w / (1 - w)) <= 0 else 0
        total += 1
    return below / total


# ---------------------------------------------------------------- walk-forward

def walk_forward(variants, c, blocks):
    """variants: lista de séries. Devolve (retornos fora da amostra, entradas, exposição,
    índice da variante escolhida em cada bloco)."""
    nets = [net_returns(v, c) for v in variants]
    pre = [Prefix(r) for r in nets]
    oos, ent, exp_, chosen = [], [], [], []
    for a, b in blocks[1:]:
        best, best_v = 0, None
        for i, p in enumerate(pre):
            v = p.sharpe(0, a)
            v = -1e9 if v is None else v
            if best_v is None or v > best_v:
                best, best_v = i, v
        oos.extend(nets[best][a:b])
        ent.extend(variants[best]["E"][a:b])
        exp_.extend(variants[best]["X"][a:b])
        chosen.append(best)
    return oos, ent, exp_, chosen


def breakeven(variants, blocks, hi=0.02, iters=30):
    """Custo por lado (%) em que o retorno total fora da amostra zera. None: não dá lucro nem
    de graça; hi*100 com '>': ainda dá lucro com custo de 2%."""
    def f(c):
        r = walk_forward(variants, c, blocks)[0]
        eq = 1.0
        for x in r:
            eq *= 1 + x
        return eq - 1
    if f(0.0) <= 0:
        return None
    if f(hi) > 0:
        return {"gt": hi * 100}
    lo, up = 0.0, hi
    for _ in range(iters):
        mid = (lo + up) / 2
        if f(mid) > 0:
            lo = mid
        else:
            up = mid
    return round(lo * 100, 4)


def buy_hold_oos(daily, d0, nd, a, c):
    closes = {b["t"] // DAY - d0: b["c"] for b in daily}
    r = []
    for d in range(a, nd):
        c1, c0 = closes.get(d), closes.get(d - 1)
        r.append((c1 / c0 - 1) if c1 and c0 else 0.0)
    if r:
        r[0] = (1 + r[0]) * (1 - c) - 1
    return r


def dca_oos(daily, d0, nd, a, c):
    """Compra 1 unidade de dinheiro toda segunda no fechamento de domingo; % sobre o investido."""
    closes = {b["t"] // DAY - d0: b["c"] for b in daily}
    units = invested = 0.0
    last = None
    for d in range(a, nd):
        if d in closes:
            last = closes[d]
        if weekday((d + d0) * DAY) == 6 and d in closes:
            units += (1 - c) / closes[d]
            invested += 1
    return (units * last / invested - 1) * 100 if invested and last else None


# ---------------------------------------------------------------- dados

def lab_dir():
    return core.path_in("lab")


def load_pair(sym, now_ms, data_start, end):
    bars = history.load(sym, now_ms, EVAL_MONTHS + WARMUP_MONTHS, fill_recent=False)
    return [b for b in bars if data_start <= b["t"] < end]


def universe_path():
    return os.path.join(lab_dir(), "universo.json")


def fetch_universe(data_start, end, log=print):
    """Candidatas = as ROT_CANDIDATES moedas com USDT de maior volume hoje (viés de sobrevivência:
    quem morreu no caminho não entra), com candles diários desde o início dos dados."""
    tick = core.market_get("/api/v3/ticker/24hr", {"type": "MINI"})
    rows = []
    for t in tick:
        s = t.get("symbol", "")
        if not s.endswith("USDT"):
            continue
        base = s[:-4]
        if base in NOT_COINS or base.endswith(("UP", "DOWN", "BULL", "BEAR")):
            continue
        rows.append((float(t.get("quoteVolume") or 0), s))
    rows.sort(reverse=True)
    out = {}
    for _, s in rows:
        if len(out) >= ROT_CANDIDATES:
            break
        bars, cur = [], data_start
        while cur < end:
            chunk = core.market_get("/api/v3/klines", {"symbol": s, "interval": "1d", "startTime": cur, "endTime": end - 1, "limit": 1000})
            if not chunk:
                break
            bars.extend(core.parse_klines(chunk))
            cur = bars[-1]["t"] + DAY
            if len(chunk) < 1000:
                break
        if bars and bars[0]["t"] <= data_start:
            out[s] = bars
            log("  %s: %d dias" % (s, len(bars)))
        else:
            log("  %s: fora (não tem o período inteiro)" % s)
    os.makedirs(lab_dir(), exist_ok=True)
    core.write_json(universe_path(), {"fetched": ymd(core.now_ms()), "start": ymd(data_start), "end": ymd(end - 1),
                                      "symbols": out})
    return out


# ---------------------------------------------------------------- pesquisa

def pair_context(sym, now_ms, cfg):
    data_start, eval_start, end = window(now_ms)
    m5 = load_pair(sym, now_ms, data_start, end)
    d0 = eval_start // DAY
    nd = end // DAY - d0
    return {"sym": sym, "m5": m5, "h1": to_hourly(m5), "d1": to_daily(m5), "d0": d0, "nd": nd, "cfg": cfg}


def r4(x, nd=2):
    return None if x is None else round(x, nd)


def evaluate(ctxs, universe, now_ms, log=print):
    data_start, eval_start, end = window(now_ms)
    blocks = blocks_for(eval_start, end)
    a = blocks[1][0]
    d0 = eval_start // DAY
    nd = end // DAY - d0
    trials = n_trials()
    log("Janela: %s a %s · fora da amostra a partir de %s · %d variações" % (ymd(eval_start), ymd(end - 1), ymd((d0 + a) * DAY), trials))

    series = {}       # (key, sym) -> [séries]
    for ctx in ctxs:
        for st in STRATEGIES:
            log("  %s · %s" % (ctx["sym"], st["name"]))
            series[(st["key"], ctx["sym"])] = [fn(ctx) for _, fn in st["variants"]]
    rot = [rotation_series(universe, d0, nd, n) for _, n in ROTATION["variants"]] if universe else []

    cols = ["ret", "sharpe", "dd", "trades", "exposure", "dsr", "beats_bh", "alive"]
    out = {"version": 1, "engine": "scripts/lab.py", "generated": ymd(core.now_ms()),
           "window": {"start": ymd(eval_start), "end": ymd(end - 1), "oos_start": ymd((d0 + a) * DAY),
                      "oos_days": nd - a, "blocks": len(blocks), "block_months": BLOCK_MONTHS, "warmup_months": WARMUP_MONTHS},
           "pairs": [c["sym"] for c in ctxs], "costs": COSTS, "default_cost": DEFAULT_COST, "trials": trials,
           "criterion": {"dsr": ALIVE_DSR, "min_pairs": ALIVE_MIN_PAIRS,
                         "luck_sharpe": round(luck_hurdle(trials, null_var(nd - a)) * math.sqrt(365), 2)}, "cols": cols,
           "baselines": {}, "strategies": [], "notes": [
               "Custo cobrado como fator (1 - custo) a cada lado negociado, na proporção do patrimônio que girou.",
               "Grid simulado em candles de 1h: ordem limite só executa se o preço atravessa o degrau; um degrau não compra e vende na mesma hora.",
               "Rotação: candidatas são as moedas de maior volume hoje, com o período inteiro de dados (viés de sobrevivência a favor da estratégia).",
               "Indicadores com os parâmetros populares, declarados antes; nenhum ajuste depois de ver o resultado.",
               "Com custo maior, o walk-forward pode trocar para a variante que gira menos; por isso uma estratégia às vezes melhora quando o custo sobe.",
               "Barra da sorte: o Sharpe que a melhor de todas as variações testadas atingiria, em média, sem habilidade nenhuma (variância do Sharpe sob a hipótese nula)."]}
    if universe:
        out["universe"] = sorted(universe)

    # réguas
    bh = {}
    for ctx in ctxs:
        rows_bh, rows_dca = [], []
        for c in COSTS:
            s = stats(buy_hold_oos(ctx["d1"], d0, nd, a, c / 100))
            rows_bh.append([r4(s["total"]), r4(s["sharpe"]), r4(s["dd"], 1)])
            rows_dca.append(r4(dca_oos(ctx["d1"], d0, nd, a, c / 100)))
        bh[ctx["sym"]] = rows_bh
        out["baselines"][ctx["sym"]] = {"bh": rows_bh, "dca": rows_dca}

    def judge(variants, bh_rows, ci):
        c = COSTS[ci] / 100
        r, ent, exp_, chosen = walk_forward(variants, c, blocks)
        s = stats(r, ent, exp_)
        _, _, sk, ku = moments(r)
        dsr = deflated_sharpe(s["sr"], len(r), sk, ku, trials, null_var(len(r)))
        beats = s["sharpe"] is not None and bh_rows[ci][1] is not None and s["sharpe"] > bh_rows[ci][1]
        alive = bool(beats and dsr is not None and dsr >= ALIVE_DSR)
        row = [r4(s["total"]), r4(s["sharpe"]), r4(s["dd"], 1), s["trades"], r4(s["exposure"], 1), r4(dsr, 3), int(beats), int(alive)]
        return row, chosen

    di = COSTS.index(DEFAULT_COST)
    for st in STRATEGIES:
        log("Julgando %s" % st["name"])
        entry = {k: st[k] for k in ("key", "name", "group", "rule")}
        entry["variants"] = [lbl for lbl, _ in st["variants"]]
        entry["portfolio"] = False
        entry["by_pair"] = {}
        alive_n = [0] * len(COSTS)
        for ctx in ctxs:
            vs = series[(st["key"], ctx["sym"])]
            rows, chosen_default = [], None
            for ci in range(len(COSTS)):
                row, chosen = judge(vs, bh[ctx["sym"]], ci)
                rows.append(row)
                alive_n[ci] += row[7]
                if ci == di:
                    chosen_default = chosen
            mat = [net_returns(v, DEFAULT_COST / 100) for v in vs]
            entry["by_pair"][ctx["sym"]] = {"at": rows, "chosen": chosen_default,
                                            "breakeven": breakeven(vs, blocks), "pbo": r4(pbo_cscv(mat), 3)}
        entry["pairs_alive"] = alive_n
        entry["alive"] = [int(n >= ALIVE_MIN_PAIRS) for n in alive_n]
        out["strategies"].append(entry)

    if rot:
        log("Julgando %s" % ROTATION["name"])
        btc = bh.get("BTCUSDT") or next(iter(bh.values()))
        entry = {k: ROTATION[k] for k in ("key", "name", "group", "rule")}
        entry["variants"] = [lbl for lbl, _ in ROTATION["variants"]]
        entry["portfolio"] = True
        rows, chosen_default = [], None
        for ci in range(len(COSTS)):
            row, chosen = judge(rot, btc, ci)
            rows.append(row)
            if ci == di:
                chosen_default = chosen
        mat = [net_returns(v, DEFAULT_COST / 100) for v in rot]
        entry["by_pair"] = {"carteira": {"at": rows, "chosen": chosen_default, "breakeven": breakeven(rot, blocks),
                                         "pbo": r4(pbo_cscv(mat), 3), "vs": "BTCUSDT"}}
        entry["pairs_alive"] = [r[7] for r in rows]
        entry["alive"] = [r[7] for r in rows]
        out["strategies"].append(entry)

    out["survivors"] = [sum(s["alive"][ci] for s in out["strategies"]) for ci in range(len(COSTS))]
    return out


def show(res, out=print):
    ci = res["costs"].index(res["default_cost"])
    w = res["window"]
    out("Fora da amostra: %s a %s (%d dias) · custo %.3f%% por lado · %d variações testadas"
        % (w["oos_start"], w["end"], w["oos_days"], res["default_cost"], res["trials"]))
    out("Barra da sorte: com %d tentativas sem habilidade, a melhor chega a Sharpe anual ~%.2f"
        % (res["trials"], res["criterion"]["luck_sharpe"]))
    out("Comprar e segurar no mesmo trecho:")
    for sym, b in res["baselines"].items():
        out("  %-8s %+8.1f%%  Sharpe %s  queda máx %.1f%%  · DCA semanal %+.1f%% sobre o investido"
            % (sym, b["bh"][ci][0], b["bh"][ci][1], b["bh"][ci][2], b["dca"][ci] or 0))
    out("")
    for s in res["strategies"]:
        tag = "VIVA " if s["alive"][ci] else "morta"
        out("[%s] %-30s pares vivos %d/%d" % (tag, s["name"], s["pairs_alive"][ci], len(s["by_pair"])))
        for sym, p in s["by_pair"].items():
            r = p["at"][ci]
            be = p["breakeven"]
            be_txt = "nunca" if be is None else (">%.1f%%" % be["gt"] if isinstance(be, dict) else "%.3f%%" % be)
            out("     %-8s %+8.1f%%  Sharpe %5s  queda %6.1f%%  %4s ops  DSR %5s  equilíbrio %s%s"
                % (sym, r[0] or 0, r[1], r[2] or 0, r[3], r[5], be_txt,
                   ("  PBO %.2f" % p["pbo"]) if p.get("pbo") is not None else ""))
    out("\nSobrevivem a %.3f%%: %d de %d" % (res["default_cost"], res["survivors"][ci], len(res["strategies"])))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["fetch", "run", "show"])
    ap.add_argument("--now", help="padrão: início do mês corrente (UTC); só meses fechados entram")
    ap.add_argument("--out", default=os.path.join("web", "public", "cemiterio.json"))
    ap.add_argument("--file", default=os.path.join("web", "public", "cemiterio.json"))
    ap.add_argument("--pairs", default=",".join(PAIRS))
    ap.add_argument("--no-rotation", action="store_true")
    ap.add_argument("--config")
    a = ap.parse_args(argv)
    if a.cmd == "show":
        res = core.read_json(a.file)
        if not res:
            print("Sem resultado em %s. Rode: lab.py run" % a.file)
            return 1
        show(res)
        return 0
    cfg = core.load_config(a.config)
    now = core.utc_ms(a.now) if a.now else None
    if now is None:
        d = datetime.now(timezone.utc)
        now = month_start(d.year, d.month)
    data_start, eval_start, end = window(now)
    pairs = [p.strip().upper() for p in a.pairs.split(",") if p.strip()]
    log = lambda m: print(m, file=sys.stderr, flush=True)
    try:
        if a.cmd == "fetch":
            for sym in pairs:
                got, missing = history.fetch(sym, EVAL_MONTHS + WARMUP_MONTHS, now, log=log)
                print("%s: %d meses%s" % (sym, len(got), (" · faltam " + ", ".join(missing)) if missing else ""))
            if not a.no_rotation:
                u = fetch_universe(data_start, end, log=log)
                print("Rotação: %d moedas com o período inteiro" % len(u))
            return 0
        ctxs = []
        for sym in pairs:
            ctx = pair_context(sym, now, cfg)
            if len(ctx["d1"]) < (end - data_start) // DAY * 0.95:
                print("%s: dados incompletos (%d dias). Rode: lab.py fetch" % (sym, len(ctx["d1"])))
                return 1
            ctxs.append(ctx)
        universe = None
        if not a.no_rotation:
            u = core.read_json(universe_path())
            if not u or u.get("start") != ymd(data_start):
                print("Sem o universo da rotação para esta janela. Rode: lab.py fetch")
                return 1
            universe = {k: v for k, v in u["symbols"].items()}
        res = evaluate(ctxs, universe, now, log=log)
    except core.ApiError as e:
        print("Erro: %s" % e)
        return 1
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, separators=(",", ":"))
    show(res)
    print("\nGravado em %s (%.0f KB)" % (a.out, os.path.getsize(a.out) / 1024))
    return 0


if __name__ == "__main__":
    sys.exit(main())
