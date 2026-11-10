#!/usr/bin/env python3
"""history.py - candles de 5m de meses atras, dos arquivos publicos da Binance.

  history.py fetch BTCUSDT --months 12       baixa os zips mensais em trader/history/BTCUSDT/
  history.py info BTCUSDT                    o que ja esta baixado

Fonte: https://data.binance.vision/data/spot/monthly/klines/<PAR>/5m/<PAR>-5m-AAAA-MM.zip
(repositorio binance/binance-public-data). Sem chave. O mes corrente ainda nao tem
arquivo mensal, entao o resto vem da API de klines. Desde 2025 os arquivos trazem
timestamps em microssegundos; core.parse_klines normaliza.
"""
import argparse
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import core  # noqa: E402

VISION = "https://data.binance.vision/data/spot/monthly/klines/%s/5m/%s-5m-%04d-%02d.zip"


def month_list(now_ms, months):
    """(ano, mês) dos últimos `months` meses fechados, do mais antigo pro mais novo."""
    d = datetime.fromtimestamp(now_ms / 1000, timezone.utc)
    y, m = d.year, d.month
    out = []
    for _ in range(months):
        m -= 1
        if m == 0:
            y, m = y - 1, 12
        out.append((y, m))
    return list(reversed(out))


def history_dir(symbol):
    return core.path_in(os.path.join("history", symbol))


def zip_path(symbol, y, m):
    return os.path.join(history_dir(symbol), "%s-5m-%04d-%02d.zip" % (symbol, y, m))


def download(url, dest, timeout=60):
    tmp = dest + ".part"
    req = urllib.request.Request(url, headers={"User-Agent": core.UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r, open(tmp, "wb") as f:
            while True:
                chunk = r.read(1 << 16)
                if not chunk:
                    break
                f.write(chunk)
    except urllib.error.HTTPError as e:
        if os.path.exists(tmp):
            os.remove(tmp)
        if e.code == 404:
            return False
        raise core.ApiError("HTTP %d em %s" % (e.code, url))
    except (urllib.error.URLError, OSError) as e:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise core.ApiError("sem acesso a %s: %s" % (url, e))
    os.replace(tmp, dest)
    return True


def fetch(symbol, months, now_ms, log=print):
    os.makedirs(history_dir(symbol), exist_ok=True)
    got, missing = [], []
    for y, m in month_list(now_ms, months):
        dest = zip_path(symbol, y, m)
        if os.path.exists(dest):
            got.append(dest)
            continue
        url = VISION % (symbol, symbol, y, m)
        log("baixando %04d-%02d..." % (y, m))
        if download(url, dest):
            got.append(dest)
        else:
            missing.append("%04d-%02d" % (y, m))
    return got, missing


def load(symbol, now_ms, months=None, fill_recent=True):
    """Candles fechados: zips baixados (+ API para o que falta do mês corrente)."""
    d = history_dir(symbol)
    bars = []
    files = sorted(f for f in os.listdir(d)) if os.path.isdir(d) else []
    if months:
        keep = {"%s-5m-%04d-%02d.zip" % (symbol, y, m) for y, m in month_list(now_ms, months)}
        files = [f for f in files if f in keep]
    for f in files:
        if f.endswith(".zip"):
            bars.extend(core.load_klines_file(os.path.join(d, f)))
    if fill_recent:
        start = bars[-1]["t"] + core.IV if bars else now_ms - 60 * 86400000
        if start < now_ms:
            bars.extend(core.get_klines_range(symbol, start, now_ms))
    seen, out = set(), []
    for b in sorted(bars, key=lambda b: b["t"]):
        if b["t"] not in seen:
            seen.add(b["t"])
            out.append(b)
    return core.closed_only(out, now_ms)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["fetch", "info"])
    ap.add_argument("symbol")
    ap.add_argument("--months", type=int, default=12)
    ap.add_argument("--now")
    a = ap.parse_args(argv)
    sym = a.symbol.upper()
    now = core.now_ms(a.now)
    if a.cmd == "fetch":
        try:
            got, missing = fetch(sym, a.months, now)
        except core.ApiError as e:
            print("Erro: %s" % e)
            return 1
        print("%d meses em %s" % (len(got), history_dir(sym)))
        if missing:
            print("Sem arquivo (par novo ou mês ainda não publicado): %s" % ", ".join(missing))
        return 0
    d = history_dir(sym)
    files = sorted(f for f in os.listdir(d) if f.endswith(".zip")) if os.path.isdir(d) else []
    if not files:
        print("Nada baixado para %s. Rode: history.py fetch %s --months 12" % (sym, sym))
        return 0
    for f in files:
        print(" ", f, "%.1f MB" % (os.path.getsize(os.path.join(d, f)) / 1e6))
    return 0


if __name__ == "__main__":
    sys.exit(main())
