#!/usr/bin/env python3
"""core.py - helpers compartilhados pelos scripts de day trade na Binance (spot).

So biblioteca padrao do Python. Dados de mercado vem do endpoint publico
data-api.binance.vision (sem chave). Ordens so existem no broker.py.
"""
import gzip
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from decimal import Decimal, ROUND_DOWN, ROUND_UP

DATA_HOST = "https://data-api.binance.vision"
LIVE_HOST = "https://api.binance.com"
TEST_HOST = "https://testnet.binance.vision"
UA = "binance-daytrade/1.0"
IV = 300000  # candles de 5 minutos, em ms
INTERVAL = "5m"

DEFAULTS = {
    "paper": True,                  # testnet por padrao
    "quote": "USDT",
    "anchor_utc": "13:00",          # inicio da sessao (13:00 UTC = 10:00 Brasilia)
    "range_minutes": 60,            # faixa inicial: primeira hora da sessao
    "entry_window_minutes": 240,    # quanto tempo depois da faixa ainda vale entrar
    "flat_by_hours": 8,             # zerar 8h depois do inicio da sessao
    "min_quote_volume": 20000000,   # volume minimo 24h (em USDT) para entrar no scanner
    "min_range_pct": 1.0,           # faixa menor que isso nao paga as taxas
    "universe_cache_minutes": 30,   # guarda a lista de pares por esse tempo
    "exclude_bases": [],            # ex.: ["SNDKB", "INTCB"] (ações tokenizadas têm horário de mercado)
    "max_chase_pct": 1.0,           # nao persegue o que ja subiu mais que isso acima da faixa
    "account": 1000,                # capital em USDT
    "max_loss_per_trade": 10,
    "max_position_pct": 50,
    "daily_loss_limit": 30,         # soma do risco maximo das ordens enviadas no dia
    "max_trades_per_day": 3,
    "min_reward_risk": 1.0,
    "fee_pct": 0.1,                 # por lado (0.075 se pagar taxa com BNB)
    "fee_in_bnb": False,            # true se a conta paga taxa em BNB (aí a quantidade comprada fica inteira)
    "entry_mode": "otoco",          # otoco = compra FOK + alvo + stop atômicos; two-step = IOC e depois OCO
    "slippage_pct": 0.05,           # por lado
    "entry_buffer_pct": 0.1,        # limite de compra acima do preco do sinal
    "stop_limit_buffer_pct": 0.3,   # limite do stop abaixo do gatilho
    "max_signal_age_minutes": 15,
    "display_tz": "America/Sao_Paulo",
}


class TraderError(Exception):
    pass


class ApiError(Exception):
    pass


# ---------------------------------------------------------------- arquivos

def trader_dir():
    return os.environ.get("TRADER_DIR", "trader")


def path_in(name):
    return os.path.join(trader_dir(), name)


def read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def write_json(path, obj):
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, sort_keys=True)
    os.replace(tmp, path)


def load_config(path=None):
    cfg = dict(DEFAULTS)
    user = read_json(path or path_in("config.json"), {}) or {}
    cfg.update({k: v for k, v in user.items() if not k.startswith("_")})
    return cfg


def fingerprint(obj):
    raw = json.dumps(obj, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()[:12]


# ---------------------------------------------------------------- HTTP

def _retry_after(e):
    try:
        return min(int(e.headers.get("Retry-After", "2")), 30)
    except (TypeError, ValueError):
        return 2


WEIGHT_LIMIT_1M = 6000          # REQUEST_WEIGHT padrão da Binance por IP (confira em exchangeInfo.rateLimits)
WEIGHT_WARN_PCT = 70
_weight_state = {"used": 0}


def used_weight():
    """Último X-MBX-USED-WEIGHT-1M visto (peso por IP no minuto corrente)."""
    return _weight_state["used"]


def _note_weight(headers):
    try:
        used = int(headers.get("X-MBX-USED-WEIGHT-1M", _weight_state["used"]))
    except (TypeError, ValueError):
        return
    _weight_state["used"] = used
    if used >= WEIGHT_LIMIT_1M * WEIGHT_WARN_PCT / 100:
        print("  (atenção: %d de %d de peso usado neste minuto; vá devagar ou a Binance bloqueia o IP)"
              % (used, WEIGHT_LIMIT_1M), file=sys.stderr)


def http_json_full(url, params=None, headers=None, data=None, method=None, timeout=20, retries=2):
    """Devolve (json, cabeçalhos). 418 = IP banido: não insiste. 429 = espera o Retry-After uma vez."""
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    hdrs = {"User-Agent": UA, "Accept": "application/json", "Accept-Encoding": "gzip"}
    hdrs.update(headers or {})
    last = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                _note_weight(r.headers)
                return json.loads(raw.decode("utf-8")), dict(r.headers)
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:300]
            if e.code == 418:
                raise ApiError("HTTP 418: a Binance baniu este IP por %ss por excesso de pedidos. Pare e espere."
                               % e.headers.get("Retry-After", "?"))
            if e.code == 429 and attempt < retries:
                wait = _retry_after(e)
                print("  (Binance pediu pra esperar: HTTP 429, aguardando %ds)" % wait, file=sys.stderr)
                time.sleep(wait)
                continue
            raise ApiError("HTTP %d em %s: %s" % (e.code, url.split("?")[0], body))
        except (urllib.error.URLError, OSError) as e:
            last = e
            if attempt < retries:
                print("  (falha de rede em %s: %s; tentando de novo)" % (url.split("?")[0].split(".vision")[-1], e),
                      file=sys.stderr)
                time.sleep(1 + attempt)
                continue
    raise ApiError("sem acesso a %s: %s" % (url.split("?")[0], last))


def http_json(url, params=None, headers=None, data=None, method=None, timeout=20, retries=2):
    return http_json_full(url, params, headers, data, method, timeout, retries)[0]


def market_get(path, params=None):
    return http_json(DATA_HOST + path, params)


# ---------------------------------------------------------------- candles

def norm_ts(t):
    """Timestamps em microssegundos (arquivos mensais da Binance desde 2025) viram milissegundos."""
    t = int(t)
    return t // 1000 if t > 10 ** 14 else t


def parse_klines(rows):
    out = []
    for r in rows:
        out.append({"t": norm_ts(r[0]), "o": float(r[1]), "h": float(r[2]), "l": float(r[3]),
                    "c": float(r[4]), "v": float(r[7]) if len(r) > 7 else float(r[5])})
    out.sort(key=lambda b: b["t"])
    return out


def closed_only(bars, now_ms):
    return [b for b in bars if b["t"] + IV <= now_ms]


def get_klines(symbol, limit=320, start=None, end=None):
    p = {"symbol": symbol, "interval": INTERVAL, "limit": limit}
    if start is not None:
        p["startTime"] = int(start)
    if end is not None:
        p["endTime"] = int(end)
    return parse_klines(market_get("/api/v3/klines", p))


def get_klines_range(symbol, start_ms, end_ms):
    out, cur = [], int(start_ms)
    while cur < end_ms:
        chunk = get_klines(symbol, 1000, start=cur, end=end_ms)
        if not chunk:
            break
        out.extend(chunk)
        nxt = chunk[-1]["t"] + IV
        if nxt <= cur:
            break
        cur = nxt
    return out


def get_session_bars(symbol, now_ms_, cfg):
    """Candles fechados da sessão atual (só do início dela em diante: poucas dezenas, não 300)."""
    s = session_start(now_ms_, cfg["anchor_utc"])
    return closed_only(get_klines(symbol, 1000, start=s), now_ms_)


def parse_klines_csv(text):
    rows = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("open_time"):
            continue
        rows.append(line.split(","))
    return parse_klines(rows)


def load_klines_file(path):
    """JSON (lista da API ou de dicts), .json.gz, .csv ou .zip mensal de data.binance.vision."""
    if path.endswith(".zip"):
        import io
        import zipfile
        with zipfile.ZipFile(path) as z:
            name = [n for n in z.namelist() if n.endswith(".csv")][0]
            return parse_klines_csv(io.TextIOWrapper(z.open(name), encoding="utf-8").read())
    if path.endswith(".csv"):
        with open(path, "r", encoding="utf-8") as f:
            return parse_klines_csv(f.read())
    op = gzip.open if path.endswith(".gz") else open
    with op(path, "rt", encoding="utf-8") as f:
        rows = json.load(f)
    if rows and isinstance(rows[0], dict):
        return sorted(rows, key=lambda b: b["t"])
    return parse_klines(rows)


# ---------------------------------------------------------------- tempo

def parse_hhmm(s):
    h, m = str(s).split(":")
    return int(h) * 60 + int(m)


def session_start(ts_ms, anchor):
    day = ts_ms // 86400000 * 86400000
    a = day + parse_hhmm(anchor) * 60000
    return a if ts_ms >= a else a - 86400000


def utc_ms(text):
    """'2026-11-02 13:05' (UTC) -> ms"""
    dt = datetime.strptime(text.strip(), "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def now_ms(arg=None):
    return utc_ms(arg) if arg else int(time.time() * 1000)


def today_utc(ms):
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%d")


def fmt_ts(ms, tz="America/Sao_Paulo"):
    dt = datetime.fromtimestamp(ms / 1000, timezone.utc)
    try:
        from zoneinfo import ZoneInfo
        dt = dt.astimezone(ZoneInfo(tz))
        label = "BRT" if tz == "America/Sao_Paulo" else tz
    except Exception:
        label = "UTC"
    return dt.strftime("%d/%m %H:%M") + " " + label


# ---------------------------------------------------------------- sinal

def orb_signal(bars, now_ms_, cfg, session=None):
    """Rompimento da faixa inicial da sessao (long only, spot).

    bars: candles de 5m FECHADOS, em ordem. Devolve um dict com 'status':
    forming | nodata | waiting | triggered | expired.
    """
    s = session if session is not None else session_start(now_ms_, cfg["anchor_utc"])
    rng_end = s + int(cfg["range_minutes"]) * 60000
    win_end = rng_end + int(cfg["entry_window_minutes"]) * 60000
    flat = s + int(float(cfg["flat_by_hours"]) * 3600000)
    out = {"status": None, "session_start": s, "range_end": rng_end,
           "window_end": win_end, "flat_by": flat, "trigger": None}
    if now_ms_ < rng_end:
        out["status"] = "forming"
        return out
    n_rng = int(cfg["range_minutes"]) * 60000 // IV
    rb = [b for b in bars if s <= b["t"] < rng_end]
    if len(rb) < n_rng:
        out["status"] = "nodata"
        return out
    hi = max(b["h"] for b in rb)
    lo = min(b["l"] for b in rb)
    out.update(range_high=hi, range_low=lo, range_mid=(hi + lo) / 2, range_pct=(hi - lo) / lo * 100)
    limit = min(win_end, flat)
    for b in bars:
        if b["t"] < rng_end or b["t"] >= limit:
            continue
        if b["t"] + IV > now_ms_:
            break
        if b["c"] > hi:
            out["trigger"] = {"time": b["t"] + IV, "bar_t": b["t"], "slot": (b["t"] - s) // IV,
                              "close": b["c"], "pct_over": (b["c"] - hi) / hi * 100}
            out["status"] = "triggered"
            return out
    out["status"] = "expired" if now_ms_ >= limit else "waiting"
    return out


def stop_price(sig, rule):
    if rule == "or-mid":
        return sig["range_mid"]
    if rule == "or-low":
        return sig["range_low"]
    raise TraderError("regra de stop desconhecida: %s (use or-mid ou or-low)" % rule)


def parse_target_r(text):
    m = re.fullmatch(r"\s*([0-9]*\.?[0-9]+)\s*[rR]?\s*", str(text))
    if not m or float(m.group(1)) <= 0:
        raise TraderError("alvo invalido: %r (use por exemplo 1R ou 1.5R)" % text)
    return float(m.group(1))


# ---------------------------------------------------------------- custos e arredondamento

def round_trip_cost(entry, exit_, fee_pct, slip_pct):
    """Custo (taxa + slippage) de comprar em entry e vender em exit_, por unidade."""
    return (entry + exit_) * (fee_pct + slip_pct) / 100.0


def net_r(entry, exit_, stop, fee_pct, slip_pct):
    risk = entry - stop
    return (exit_ - entry - round_trip_cost(entry, exit_, fee_pct, slip_pct)) / risk


def loss_per_unit(entry, stop, fee_pct, slip_pct):
    return (entry - stop) + round_trip_cost(entry, stop, fee_pct, slip_pct)


def D(x):
    return Decimal(str(x))


def floor_step(x, step):
    s = D(step)
    return (D(x) / s).to_integral_value(ROUND_DOWN) * s


def ceil_step(x, step):
    s = D(step)
    return (D(x) / s).to_integral_value(ROUND_UP) * s


def dstr(d):
    return format(Decimal(d).normalize(), "f")
