#!/usr/bin/env python3
"""broker.py - unico script que fala com a conta da Binance. Testnet por padrao.

  broker.py check                             so leitura: chaves, relogio, saldo, comissao real
  broker.py show                              a ordem em palavras e o estado dela
  broker.py approve --reply "sim BTCUSDT"     registra o seu sim para ESTA ordem
  broker.py send entry [--dry-run]            modo otoco: compra FOK + alvo + stop numa ordem so
                                              modo two-step: compra IOC
  broker.py send exit  [--dry-run]            so no modo two-step: coloca o OCO no que foi comprado
  broker.py status                            consulta a lista de ordens na Binance
  broker.py flatten --reply "sim BTCUSDT"     cancela o par alvo/stop e vende a mercado
  broker.py log                               trades de hoje

Travas no codigo (alem do cartao "Permitir" do Claude): o risk.py precisa ter dado
PASS nesta ordem exata, ha menos de 15 min; tem que existir um 'sim' registrado pra
ela; modo real exige "paper": false no config E BN_LIVE=1 no ambiente. Chaves ficam
em variaveis de ambiente, nunca no chat.

  testnet: BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_API_SECRET
  real:    BINANCE_API_KEY / BINANCE_API_SECRET  (+ BN_LIVE=1)

Endpoints e parametros conferidos na documentacao oficial (binance-spot-api-docs,
rest-api.md): POST /api/v3/order, POST /api/v3/orderList/otoco, POST
/api/v3/orderList/oco, DELETE /api/v3/orderList, GET /api/v3/orderList,
GET /api/v3/account, GET /api/v3/account/commission, GET /api/v3/time.
O fluxo OTOCO + status + flatten foi executado com sucesso na testnet em 2026-11-02.
O modo two-step (IOC + OCO) so foi testado contra a corretora falsa dos testes.
"""
import argparse
import hashlib
import hmac
import os
import re
import sys
import time
import urllib.parse
from decimal import Decimal

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import core  # noqa: E402

RISK_MAX_AGE_MS = 15 * 60000
OPEN_STATES = ("entry_filled", "protected")


# ---------------------------------------------------------------- API assinada

def sign(query_string, secret):
    return hmac.new(secret.encode(), query_string.encode(), hashlib.sha256).hexdigest()


def endpoint(cfg, env=None):
    env = os.environ if env is None else env
    if cfg["paper"]:
        host, key, sec = core.TEST_HOST, env.get("BINANCE_TESTNET_API_KEY"), env.get("BINANCE_TESTNET_API_SECRET")
        names = "BINANCE_TESTNET_API_KEY e BINANCE_TESTNET_API_SECRET"
    else:
        if env.get("BN_LIVE") != "1":
            raise core.TraderError('modo real exige BN_LIVE=1 no ambiente (e "paper": false no config)')
        host, key, sec = core.LIVE_HOST, env.get("BINANCE_API_KEY"), env.get("BINANCE_API_SECRET")
        names = "BINANCE_API_KEY e BINANCE_API_SECRET"
    if not key or not sec:
        raise core.TraderError("defina %s no ambiente" % names)
    return host, key, sec


_clock = {"offset": None}


def clock_offset(host):
    """Diferença servidor - local, em ms. A Binance rejeita timestamp mais de 1s à frente do dela."""
    if _clock["offset"] is None:
        try:
            srv = core.http_json(host + "/api/v3/time", retries=1)["serverTime"]
            _clock["offset"] = int(srv) - int(time.time() * 1000)
        except (core.ApiError, KeyError, TypeError, ValueError):
            _clock["offset"] = 0
    return _clock["offset"]


def signed(method, host, path, params, key, secret, now_ms=None):
    p = [(k, str(v)) for k, v in params.items()]
    p.append(("recvWindow", "5000"))
    p.append(("timestamp", str(now_ms or int(time.time() * 1000) + clock_offset(host))))
    qs = urllib.parse.urlencode(p)
    qs += "&signature=" + sign(qs, secret)
    hdr = {"X-MBX-APIKEY": key}
    if method in ("GET", "DELETE"):
        return core.http_json(host + path + "?" + qs, headers=hdr, method=method, retries=0)
    hdr["Content-Type"] = "application/x-www-form-urlencoded"
    return core.http_json(host + path, headers=hdr, data=qs.encode(), method=method, retries=0)


# ---------------------------------------------------------------- regras

def parse_yes(reply, order):
    r = (reply or "").strip().lower()
    if not re.match(r"^(yes|sim)\b", r):
        return False, "a resposta precisa começar com 'sim' ou 'yes'"
    names = {order["symbol"].lower(), order["base"].lower()}
    if not any(re.search(r"\b%s\b" % re.escape(n), r) for n in names):
        return False, "cite o par na resposta, por exemplo 'sim %s'" % order["symbol"]
    return True, ""


def find_record(state, fp, today):
    for r in reversed(state.get("orders", [])):
        if r.get("fingerprint") == fp and r.get("date") == today:
            return r
    return None


def check_risk(order, risk, now):
    fp = core.fingerprint(order)
    if not risk or risk.get("fingerprint") != fp:
        raise core.TraderError("o risk.py não conferiu ESTA ordem. Rode risk.py de novo.")
    if risk.get("verdict") != "PASS":
        raise core.TraderError("o risk.py bloqueou esta ordem (BLOCK). Nada foi enviado.")
    if now - risk.get("checked_at", 0) > RISK_MAX_AGE_MS:
        raise core.TraderError("a checagem de risco tem mais de 15 minutos. Rode o risk.py de novo.")
    return fp


def sellable_qty(resp, base, step):
    """Quantidade vendável: executada menos a comissão paga na moeda base (quando não é BNB)."""
    ex = Decimal(str(resp.get("executedQty", "0")))
    fee = sum((Decimal(str(f["commission"])) for f in resp.get("fills", []) if f.get("commissionAsset") == base),
              Decimal(0))
    return core.floor_step(ex - fee, step)


def _cid(prefix, fp):
    # newClientOrderId repetido só é aceito depois que o anterior executa: um sufixo de tempo evita rejeição
    return "bnd-%s-%s-%d" % (fp, prefix, int(time.time()) % 100000)


def entry_params(order, fp):
    e = order["entry"]
    return {"symbol": order["symbol"], "side": "BUY", "type": "LIMIT", "timeInForce": "IOC",
            "quantity": e["quantity"], "price": e["price"], "newOrderRespType": "FULL",
            "newClientOrderId": _cid("e", fp)}


def oco_params(order, qty, fp):
    x = order["exit"]
    return {"symbol": order["symbol"], "side": "SELL", "quantity": core.dstr(qty),
            "aboveType": "LIMIT_MAKER", "abovePrice": x["target"],
            "belowType": "STOP_LOSS_LIMIT", "belowStopPrice": x["stop"], "belowPrice": x["stop_limit"],
            "belowTimeInForce": "GTC", "listClientOrderId": _cid("x", fp), "newOrderRespType": "FULL"}


def otoco_params(order, fp):
    """Uma lista só: compra LIMIT FOK (tudo ou nada); se executar, nascem alvo (LIMIT_MAKER) e
    stop (STOP_LOSS_LIMIT) como par OCO. Sem janela em que a posição fica sem stop."""
    e, x = order["entry"], order["exit"]
    return {"symbol": order["symbol"], "listClientOrderId": _cid("l", fp), "newOrderRespType": "FULL",
            "workingType": "LIMIT", "workingSide": "BUY", "workingPrice": e["price"],
            "workingQuantity": e["quantity"], "workingTimeInForce": "FOK",
            "pendingSide": "SELL", "pendingQuantity": x["quantity"],
            "pendingAboveType": "LIMIT_MAKER", "pendingAbovePrice": x["target"],
            "pendingBelowType": "STOP_LOSS_LIMIT", "pendingBelowStopPrice": x["stop"],
            "pendingBelowPrice": x["stop_limit"], "pendingBelowTimeInForce": "GTC"}


def market_sell_params(order, qty):
    step = order.get("market_step") or "0"
    if Decimal(step) > 0:
        qty = core.floor_step(qty, step)
    return {"symbol": order["symbol"], "side": "SELL", "type": "MARKET", "quantity": core.dstr(qty),
            "newOrderRespType": "FULL"}


def working_report(resp):
    """No OTOCO, o relatório da ordem de compra (a única com side BUY)."""
    for r in resp.get("orderReports", []):
        if r.get("side") == "BUY":
            return r
    return None


def exec_rule_warning(host, order):
    """Regra de faixa de preço (executionRules + referencePrice): um stop-limit abaixo da faixa
    não executa. Aviso, não bloqueio; símbolos sem a regra passam direto."""
    try:
        rules = core.http_json(host + "/api/v3/executionRules", {"symbol": order["symbol"]}, retries=0)
        pr = [r for sr in rules.get("symbolRules", []) for r in sr.get("rules", []) if r.get("ruleType") == "PRICE_RANGE"]
        if not pr or "askLimitMultDown" not in pr[0]:
            return None
        ref = core.http_json(host + "/api/v3/referencePrice", {"symbol": order["symbol"]}, retries=0)
        rp = float(ref.get("referencePrice") or 0)
        if not rp:
            return None
        floor = rp * float(pr[0]["askLimitMultDown"])
        if float(order["exit"]["stop_limit"]) < floor:
            return ("o limite do stop (%s) está abaixo da faixa de execução permitida agora (%.8g): "
                    "o stop pode não executar. Considere stop_limit_buffer_pct menor." % (order["exit"]["stop_limit"], floor))
    except core.ApiError:
        return None
    return None


# ---------------------------------------------------------------- comandos

def load_all(a):
    cfg = core.load_config(a.config)
    order = core.read_json(core.path_in("orders.json"))
    if not order:
        raise core.TraderError("sem orders.json (rode size.py --write)")
    state = core.read_json(core.path_in("state.json"), {"orders": []})
    now = core.now_ms(a.now)
    return cfg, order, state, now, core.today_utc(now)


def save(state):
    core.write_json(core.path_in("state.json"), state)


def cmd_check(a):
    cfg = core.load_config(a.config)
    host, key, sec = endpoint(cfg)
    print("Modo: %s (%s)" % ("PAPER (testnet)" if cfg["paper"] else "DINHEIRO REAL", host))
    try:
        off = clock_offset(host)
        print("Relógio: seu PC está %+d ms em relação à Binance (corrigido automaticamente; limite 1000 à frente)" % -off)
        if abs(off) > 2000:
            print("  Vale acertar o relógio do Windows (Configurações > Hora e idioma > Sincronizar agora).")
        acc = signed("GET", host, "/api/v3/account", {}, key, sec)
    except core.ApiError as e:
        print("Erro: %s" % e)
        return 1
    print("Chave e assinatura ok. Pode operar: %s" % acc.get("canTrade"))
    order = core.read_json(core.path_in("orders.json")) or {}
    sym = order.get("symbol") or "BTCUSDT"
    base = order.get("base") or sym.replace(cfg["quote"], "")
    bal = {b["asset"]: b for b in acc.get("balances", []) if float(b.get("free", 0)) > 0 or float(b.get("locked", 0)) > 0}
    first = [a for a in (cfg["quote"], base, "BNB") if a in bal]
    rest = sorted((a for a in bal if a not in first), key=lambda a: -float(bal[a]["free"]))
    for a_ in first + rest[:5]:
        b = bal[a_]
        print("  %-8s livre %s  travado %s" % (a_, b["free"], b["locked"]))
    if cfg["quote"] not in bal:
        print("  ATENÇÃO: sem saldo em %s, nenhuma compra vai executar." % cfg["quote"])
    if len(rest) > 5:
        print("  (+%d outras moedas)" % (len(rest) - 5))
    try:
        com = signed("GET", host, "/api/v3/account/commission", {"symbol": sym}, key, sec)
        taker = float(com["standardCommission"]["taker"]) * 100
        disc = com.get("discount", {})
        bnb = bool(disc.get("enabledForAccount")) and bool(disc.get("enabledForSymbol"))
        eff = taker * float(disc.get("discount", 1)) if bnb else taker
        if cfg["paper"]:
            print("Comissão em %s na testnet: %.4f%% (a testnet não cobra; o config fica com a taxa real, fee_pct=%.4f%%)"
                  % (sym, eff, cfg["fee_pct"]))
        else:
            print("Comissão taker em %s: %.4f%%%s. No config está fee_pct=%.4f%%%s" % (
                sym, taker, " (%.4f%% pagando em BNB, ativo na conta)" % eff if bnb else "",
                cfg["fee_pct"], "" if abs(eff - cfg["fee_pct"]) < 0.005 else " -> ajuste o config"))
            if bnb != bool(cfg.get("fee_in_bnb")):
                print("  fee_in_bnb no config (%s) não bate com a conta (%s): ajuste." % (bool(cfg.get("fee_in_bnb")), bnb))
    except (core.ApiError, KeyError, TypeError, ValueError) as e:
        print("Comissão: não consegui ler (%s)" % e)
    print("Peso usado neste minuto: %d de %d" % (core.used_weight(), core.WEIGHT_LIMIT_1M))
    return 0


def cmd_show(a):
    cfg, order, state, now, today = load_all(a)
    e, x = order["entry"], order["exit"]
    print("%s" % ("PAPER (testnet)" if cfg["paper"] else "DINHEIRO REAL"))
    if order.get("mode") == "otoco":
        print("Uma ordem só (OTOCO): comprar %s %s a no máximo %s %s, tudo ou nada (FOK)." % (
            e["quantity"], order["base"], e["price"], order["quote"]))
        print("Se executar, nascem juntos: alvo %s e stop %s (limite %s), vendendo %s." % (
            x["target"], x["stop"], x["stop_limit"], x["quantity"]))
    else:
        print("Comprar %s %s a no máximo %s %s (ordem limite IOC: se o preço fugiu, não executa)" % (
            e["quantity"], order["base"], e["price"], order["quote"]))
        print("Depois, OCO de venda: alvo %s, ou stop em %s (limite %s)" % (x["target"], x["stop"], x["stop_limit"]))
    print("Valor %.2f | perda máxima no stop %.2f | ganho no alvo %.2f | retorno/risco %.2f" % (
        order["notional"], order["max_loss"], order["reward_at_target"], order["reward_risk"]))
    print("Um stop é plano, não garantia: num gap abaixo do limite o stop pode nem executar.")
    risk = core.read_json(core.path_in("risk.json"))
    fp = core.fingerprint(order)
    ok = bool(risk and risk.get("fingerprint") == fp)
    print("Risco: %s" % (risk["verdict"] if ok else "não conferido para esta ordem"))
    rec = find_record(state, fp, today)
    print("Estado: %s" % (rec["status"] if rec else "sem sim registrado"))
    return 0


def cmd_approve(a):
    cfg, order, state, now, today = load_all(a)
    fp = check_risk(order, core.read_json(core.path_in("risk.json")), now)
    if find_record(state, fp, today):
        raise core.TraderError("esta ordem já tem registro hoje (use broker.py log)")
    ok, why = parse_yes(a.reply, order)
    if not ok:
        print("Não registrei: %s. Mostre o ticket de novo e pergunte ao usuário." % why)
        return 1
    state.setdefault("orders", []).append({
        "date": today, "at": now, "fingerprint": fp, "symbol": order["symbol"], "status": "approved",
        "mode": order.get("mode", "two-step"), "max_loss": order["max_loss"], "qty": order["qty"],
        "paper": order["paper"], "reply": a.reply})
    save(state)
    print("Sim registrado para %s %s. Agora: broker.py send entry" % (order["qty"], order["symbol"]))
    return 0


def _send_otoco(a, cfg, order, rec, fp, state):
    params, path = otoco_params(order, fp), "/api/v3/orderList/otoco"
    if a.dry_run:
        print("DRY-RUN POST %s %s" % (path, params))
        return 0
    host, key, sec = endpoint(cfg)
    warn = exec_rule_warning(host, order)
    if warn:
        print("AVISO: %s" % warn)
    try:
        resp = signed("POST", host, path, params, key, sec)
    except core.ApiError as e:
        rec["last_error"] = str(e)
        save(state)
        print("Erro: %s\nNada foi comprado (a Binance recusou a lista inteira)." % e)
        return 1
    rec["order_list_id"] = resp.get("orderListId")
    w = working_report(resp) or {}
    ex = Decimal(str(w.get("executedQty", "0")))
    if w.get("status") == "FILLED" and ex > 0:
        rec["status"] = "protected"
        rec["sellable_qty"] = order["exit"]["quantity"]
        rec["avg_price"] = float(w.get("cummulativeQuoteQty", 0)) / float(ex)
        print("Comprado %s %s a média %.8g. Alvo e stop já estão na Binance (lista %s)." % (
            core.dstr(ex), order["base"], rec["avg_price"], rec["order_list_id"]))
        print("Confira com broker.py status. Perto do horário de zerar: broker.py flatten.")
    elif w.get("status") in ("EXPIRED", "CANCELED", "REJECTED") or ex == 0:
        rec["status"] = "entry_unfilled"
        print("A compra FOK não executou (não havia %s %s até %s). Nada foi comprado, lista encerrada." % (
            order["entry"]["quantity"], order["base"], order["entry"]["price"]))
    else:
        rec["status"] = "entry_pending"
        print("Resposta inesperada (status %s). Rode broker.py status e confira na Binance." % w.get("status"))
    save(state)
    return 0


def _send_two_step(a, cfg, order, rec, fp, state):
    if a.what == "entry":
        params, path = entry_params(order, fp), "/api/v3/order"
    else:
        if rec["status"] != "entry_filled":
            raise core.TraderError("só dá pra proteger depois de uma compra executada (estado: %s)" % rec["status"])
        qty = min(Decimal(rec["sellable_qty"]), Decimal(order["exit"]["quantity"]))
        params, path = oco_params(order, qty, fp), "/api/v3/orderList/oco"
    if a.dry_run:
        print("DRY-RUN POST %s %s" % (path, params))
        return 0
    host, key, sec = endpoint(cfg)
    if a.what == "exit":
        warn = exec_rule_warning(host, order)
        if warn:
            print("AVISO: %s" % warn)
    try:
        resp = signed("POST", host, path, params, key, sec)
    except core.ApiError as e:
        rec["last_error"] = str(e)
        save(state)
        if a.what == "exit":
            print("ATENÇÃO: a posição está SEM stop. Rode broker.py flatten agora, ou ponha o stop à mão.")
        print("Erro: %s" % e)
        return 1
    if a.what == "entry":
        ex = Decimal(str(resp.get("executedQty", "0")))
        if ex == 0:
            rec["status"] = "entry_unfilled"
            print("A ordem IOC não executou (preço fugiu acima do limite). Nada foi comprado.")
        else:
            rec["status"] = "entry_filled"
            rec["sellable_qty"] = core.dstr(sellable_qty(resp, order["base"], order["step"]))
            rec["avg_price"] = float(resp.get("cummulativeQuoteQty", 0)) / float(ex)
            rec["order_id"] = resp.get("orderId")
            print("Comprado %s %s a média %.8g. Quantidade vendável: %s. AGORA: broker.py send exit" % (
                core.dstr(ex), order["base"], rec["avg_price"], rec["sellable_qty"]))
    else:
        rec["status"] = "protected"
        rec["order_list_id"] = resp.get("orderListId")
        print("OCO colocado (alvo %s, stop %s, lista %s)." % (order["exit"]["target"], order["exit"]["stop"], rec["order_list_id"]))
    save(state)
    return 0


def cmd_send(a):
    cfg, order, state, now, today = load_all(a)
    fp = check_risk(order, core.read_json(core.path_in("risk.json")), now)
    rec = find_record(state, fp, today)
    if not rec:
        raise core.TraderError("não existe 'sim' registrado para esta ordem (broker.py approve)")
    if bool(order["paper"]) != bool(cfg["paper"]):
        raise core.TraderError("a ordem foi dimensionada em modo diferente do config atual. Rode size.py e risk.py de novo.")
    if a.what == "entry" and rec["status"] != "approved":
        raise core.TraderError("a entrada desta ordem já foi tratada (estado: %s)" % rec["status"])
    if order.get("mode") == "otoco":
        if a.what == "exit":
            raise core.TraderError("no modo OTOCO o alvo e o stop já vão junto com a compra; não existe 'send exit'")
        return _send_otoco(a, cfg, order, rec, fp, state)
    return _send_two_step(a, cfg, order, rec, fp, state)


def cmd_status(a):
    cfg, order, state, now, today = load_all(a)
    rec = find_record(state, core.fingerprint(order), today)
    if not rec:
        print("Sem registro desta ordem hoje.")
        return 0
    print("Estado local: %s" % rec["status"])
    if not rec.get("order_list_id"):
        return 0
    host, key, sec = endpoint(cfg)
    try:
        ol = signed("GET", host, "/api/v3/orderList", {"orderListId": rec["order_list_id"]}, key, sec)
        print("Lista %s na Binance: %s / %s" % (rec["order_list_id"], ol.get("listStatusType"), ol.get("listOrderStatus")))
        for o in ol.get("orders", []):
            od = signed("GET", host, "/api/v3/order", {"symbol": order["symbol"], "orderId": o["orderId"]}, key, sec)
            print("  %s %s %s executado %s/%s%s" % (od.get("type"), od.get("side"), od.get("status"),
                                                   od.get("executedQty"), od.get("origQty"),
                                                   " stop %s" % od["stopPrice"] if od.get("stopPrice") not in (None, "0.00000000") else ""))
            if od.get("side") == "SELL" and od.get("status") == "FILLED":
                rec["status"] = "closed"
                rec["exit_type"] = od.get("type")
                save(state)
    except core.ApiError as e:
        print("Erro: %s" % e)
        return 1
    return 0


def cmd_flatten(a):
    cfg, order, state, now, today = load_all(a)
    fp = core.fingerprint(order)
    rec = find_record(state, fp, today)
    if not rec or rec["status"] not in OPEN_STATES:
        raise core.TraderError("não há posição aberta registrada para esta ordem")
    ok, why = parse_yes(a.reply, order)
    if not ok:
        print("Não executei: %s." % why)
        return 1
    qty = Decimal(rec["sellable_qty"])
    if a.dry_run:
        print("DRY-RUN cancelar a lista %s e vender %s %s a mercado" % (rec.get("order_list_id"), core.dstr(qty), order["base"]))
        return 0
    host, key, sec = endpoint(cfg)
    try:
        if rec["status"] == "protected":
            if rec.get("order_list_id"):
                signed("DELETE", host, "/api/v3/orderList",
                       {"symbol": order["symbol"], "orderListId": rec["order_list_id"]}, key, sec)
            else:
                signed("DELETE", host, "/api/v3/openOrders", {"symbol": order["symbol"]}, key, sec)
        resp = signed("POST", host, "/api/v3/order", market_sell_params(order, qty), key, sec)
    except core.ApiError as e:
        print("Erro: %s\nConfira a posição e as ordens abertas direto na Binance." % e)
        return 1
    rec["status"] = "flattened"
    rec["exit_type"] = "MARKET"
    print("Vendido a mercado (%s, %s). Estado: flattened." % (resp.get("status", "?"), resp.get("executedQty", "?")))
    save(state)
    return 0


def cmd_log(a):
    state = core.read_json(core.path_in("state.json"), {"orders": []})
    today = core.today_utc(core.now_ms(a.now))
    rows = [r for r in state.get("orders", []) if r.get("date") == today]
    if not rows:
        print("Nenhum trade hoje.")
    for r in rows:
        print("%s %s qty %s perda máx %.2f [%s]%s" % (r["date"], r["symbol"], r["qty"], r["max_loss"], r["status"],
                                                      " paper" if r.get("paper") else " REAL"))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--now", help=argparse.SUPPRESS)
    ap.add_argument("--config")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("show", "log", "check", "status"):
        sub.add_parser(name)
    p = sub.add_parser("approve")
    p.add_argument("--reply", required=True)
    p = sub.add_parser("send")
    p.add_argument("what", choices=["entry", "exit"])
    p.add_argument("--dry-run", action="store_true")
    p = sub.add_parser("flatten")
    p.add_argument("--reply", required=True)
    p.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    try:
        return {"show": cmd_show, "approve": cmd_approve, "send": cmd_send, "status": cmd_status,
                "flatten": cmd_flatten, "log": cmd_log, "check": cmd_check}[a.cmd](a)
    except core.TraderError as e:
        print("Erro: %s" % e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
