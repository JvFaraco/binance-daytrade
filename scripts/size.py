#!/usr/bin/env python3
"""size.py - tamanho da posicao a partir do plano e do prejuizo maximo por trade.

  size.py [--write] [--rules ARQUIVO.json]      le trader/plan.json, grava trader/orders.json

Quantidade = prejuizo maximo / perda por unidade no stop, ja contando taxa e
slippage, arredondada pro passo do par (LOT_SIZE) e limitada pelo tamanho maximo
da posicao. Preco de compra = limite IOC levemente acima do sinal: se o preco ja
fugiu, a ordem simplesmente nao executa.
"""
import argparse
import os
import sys
from decimal import Decimal

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import core  # noqa: E402


def parse_rules(info, symbol):
    """Regras do par, direto do exchangeInfo (fonte: binance-spot-api-docs, filters.md)."""
    syms = [x for x in info.get("symbols", []) if x.get("symbol") == symbol]
    if not syms:
        raise core.TraderError("par %s não encontrado em exchangeInfo" % symbol)
    s = syms[0]
    if s.get("status") != "TRADING":
        raise core.TraderError("%s não está em TRADING (status: %s)" % (symbol, s.get("status")))
    if s.get("isSpotTradingAllowed") is False:
        raise core.TraderError("%s não permite spot (isSpotTradingAllowed=false)" % symbol)
    types = set(s.get("orderTypes") or [])
    need = {"LIMIT", "LIMIT_MAKER", "STOP_LOSS_LIMIT", "MARKET"}
    if types and not need <= types:
        raise core.TraderError("%s não aceita os tipos de ordem necessários: faltam %s"
                               % (symbol, ", ".join(sorted(need - types))))
    f = {x["filterType"]: x for x in s.get("filters", [])}
    notional = f.get("NOTIONAL") or f.get("MIN_NOTIONAL") or {}
    pps = f.get("PERCENT_PRICE_BY_SIDE") or {}
    mls = f.get("MARKET_LOT_SIZE") or {}
    try:
        return {
            "base": s["baseAsset"], "quote": s["quoteAsset"],
            "tick": f["PRICE_FILTER"]["tickSize"], "step": f["LOT_SIZE"]["stepSize"],
            "min_qty": f["LOT_SIZE"]["minQty"], "max_qty": f["LOT_SIZE"].get("maxQty", "0"),
            "min_notional": notional.get("minNotional", "0"), "max_notional": notional.get("maxNotional", "0"),
            "market_min_qty": mls.get("minQty", "0"), "market_max_qty": mls.get("maxQty", "0"),
            "market_step": mls.get("stepSize", "0"),
            "bid_mult_up": float(pps.get("bidMultiplierUp", 0) or 0),
            "ask_mult_down": float(pps.get("askMultiplierDown", 0) or 0),
            "oco_allowed": bool(s.get("ocoAllowed", True)), "oto_allowed": bool(s.get("otoAllowed", False)),
            "max_algo_orders": int((f.get("MAX_NUM_ALGO_ORDERS") or {}).get("maxNumAlgoOrders", 0) or 0),
        }
    except KeyError as e:
        raise core.TraderError("exchangeInfo sem o filtro %s" % e)


def check_percent_price(rules, avg_price, entry_limit, stop_limit):
    """PERCENT_PRICE_BY_SIDE: compra <= média*bidMultiplierUp; venda >= média*askMultiplierDown.
    A Binance recusa a ordem (ou o stop nunca vira ordem válida) se isso falhar."""
    if not avg_price:
        return []
    probs = []
    if rules["bid_mult_up"] and entry_limit > avg_price * rules["bid_mult_up"]:
        probs.append("limite de compra %g acima do permitido (%g x %g)" % (entry_limit, avg_price, rules["bid_mult_up"]))
    if rules["ask_mult_down"] and stop_limit < avg_price * rules["ask_mult_down"]:
        probs.append("limite do stop %g abaixo do permitido (%g x %g): a venda do stop seria recusada"
                     % (stop_limit, avg_price, rules["ask_mult_down"]))
    return probs


def size_order(plan, cfg, rules, avg_price=None):
    tick, step = rules["tick"], rules["step"]
    stop = core.floor_step(plan["stop"], tick)
    target = core.ceil_step(plan["target"], tick)
    entry_limit = core.ceil_step(plan["entry"] * (1 + cfg["entry_buffer_pct"] / 100.0), tick)
    stop_limit = core.floor_step(float(stop) * (1 - cfg["stop_limit_buffer_pct"] / 100.0), tick)
    e, s, t = float(entry_limit), float(stop), float(target)
    if not s < e < t:
        raise core.TraderError("preços incoerentes depois de arredondar: stop %s, entrada %s, alvo %s" % (s, e, t))
    probs = check_percent_price(rules, avg_price, e, float(stop_limit))
    if probs:
        raise core.TraderError("; ".join(probs))
    lpu = core.loss_per_unit(e, s, cfg["fee_pct"], cfg["slippage_pct"])
    qty = core.floor_step(cfg["max_loss_per_trade"] / lpu, step)
    cap = core.floor_step(cfg["account"] * cfg["max_position_pct"] / 100.0 / e, step)
    qty = min(qty, cap)
    if Decimal(rules["max_qty"]) > 0:
        qty = min(qty, core.floor_step(rules["max_qty"], step))
    if Decimal(rules["max_notional"]) > 0:
        qty = min(qty, core.floor_step(float(rules["max_notional"]) / e, step))
    if qty < Decimal(rules["min_qty"]):
        raise core.TraderError("quantidade %s abaixo do mínimo %s: o risco permitido é pequeno demais pra esse stop"
                               % (core.dstr(qty), rules["min_qty"]))
    notional = float(qty) * e
    if notional < float(rules["min_notional"]):
        raise core.TraderError("valor da ordem %.2f abaixo do mínimo %s da Binance" % (notional, rules["min_notional"]))
    # A comissão de uma compra é cobrada na moeda comprada (salvo pagando em BNB), então a
    # quantidade vendável fica menor que a comprada. As pernas de saída vendem só o que sobra.
    if cfg.get("fee_in_bnb"):
        sell_qty = qty
    else:
        sell_qty = core.floor_step(float(qty) * (1 - cfg["fee_pct"] / 100.0), step)
    if sell_qty < Decimal(rules["min_qty"]) or float(sell_qty) * s < float(rules["min_notional"]):
        raise core.TraderError("a quantidade vendável depois da taxa (%s) fica abaixo do mínimo do par" % core.dstr(sell_qty))
    mode = "otoco" if (rules["oto_allowed"] and cfg.get("entry_mode", "otoco") == "otoco") else "two-step"
    win = t - e - core.round_trip_cost(e, t, cfg["fee_pct"], cfg["slippage_pct"])
    order = {
        "symbol": plan["symbol"], "base": rules["base"], "quote": rules["quote"], "mode": mode,
        "entry": {"side": "BUY", "type": "LIMIT", "timeInForce": "FOK" if mode == "otoco" else "IOC",
                  "quantity": core.dstr(qty), "price": core.dstr(entry_limit)},
        "exit": {"side": "SELL", "kind": "OCO", "quantity": core.dstr(sell_qty), "target": core.dstr(target),
                 "stop": core.dstr(stop), "stop_limit": core.dstr(stop_limit)},
        "qty": core.dstr(qty), "step": str(rules["step"]), "market_step": str(rules["market_step"]),
        "notional": round(notional, 2),
        "max_loss": round(float(qty) * lpu, 2), "reward_at_target": round(float(qty) * win, 2),
        "reward_risk": round(win / lpu, 3), "paper": bool(cfg["paper"]),
        "plan_fingerprint": core.fingerprint(plan),
    }
    return order


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--plan")
    ap.add_argument("--rules", help="resposta salva de /api/v3/exchangeInfo?symbol=...")
    ap.add_argument("--avg", type=float, help="preço médio (offline); online usa /api/v3/avgPrice")
    ap.add_argument("--config")
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args(argv)
    cfg = core.load_config(a.config)
    plan = core.read_json(a.plan or core.path_in("plan.json"))
    if not plan:
        print("Erro: sem plano. Rode plan.py plan SYMBOL --write antes.")
        return 1
    try:
        info = core.read_json(a.rules) if a.rules else core.market_get(
            "/api/v3/exchangeInfo", {"symbol": plan["symbol"]})
        avg = a.avg
        if avg is None and not a.rules:
            avg = float(core.market_get("/api/v3/avgPrice", {"symbol": plan["symbol"]})["price"])
        order = size_order(plan, cfg, parse_rules(info, plan["symbol"]), avg)
    except (core.TraderError, core.ApiError) as e:
        print("Erro: %s" % e)
        return 1
    e, x = order["entry"], order["exit"]
    print("Comprar %s %s a no máximo %s (LIMIT %s), valor %.2f %s" % (
        e["quantity"], order["base"], e["price"], e["timeInForce"], order["notional"], order["quote"]))
    print("Saída OCO: vender %s, alvo %s, stop %s (limite %s)" % (x["quantity"], x["target"], x["stop"], x["stop_limit"]))
    print("Modo: %s" % ("OTOCO (compra FOK + alvo + stop numa ordem só)" if order["mode"] == "otoco"
                        else "dois passos (compra IOC, depois OCO)"))
    print("Perda máxima no stop: %.2f | ganho no alvo: %.2f | retorno/risco %.2f (tudo com taxas)" % (
        order["max_loss"], order["reward_at_target"], order["reward_risk"]))
    if a.write:
        core.write_json(core.path_in("orders.json"), order)
        print("Salvo em %s" % core.path_in("orders.json"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
