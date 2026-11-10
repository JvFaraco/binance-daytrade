import contextlib
from decimal import Decimal
import io
import json
import math
import os
import random
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))
import core, scan, plan as planmod, timemachine, size, risk, broker, history, backtest, research, lab  # noqa: E402
import zipfile

IV = core.IV
CFG = core.load_config("/nonexistent.json")
DAY0 = core.utc_ms("2026-10-01 00:00")


def make_bars(start, n, price=100.0, seed=1, vol=0.002, drift=0.0):
    rng = random.Random(seed)
    out, p = [], price
    for i in range(n):
        o = p
        c = o * (1 + drift + rng.gauss(0, vol))
        h = max(o, c) * (1 + abs(rng.gauss(0, vol / 2)))
        l = min(o, c) * (1 - abs(rng.gauss(0, vol / 2)))
        out.append({"t": start + i * IV, "o": o, "h": h, "l": l, "c": c, "v": 1e6})
        p = c
    return out


def session_with_breakout(s, hi=101.0, lo=99.0, trig_slot=14, close=101.5):
    """12 candles de faixa entre lo e hi; depois lateral; candle trig_slot fecha acima do topo."""
    bars = []
    for i in range(12):
        bars.append({"t": s + i * IV, "o": 100, "h": hi if i == 3 else min(hi, 100.5), "l": lo if i == 5 else max(lo, 99.5), "c": 100, "v": 1})
    for i in range(12, 96):
        c = close if i == trig_slot else 100
        bars.append({"t": s + i * IV, "o": 100, "h": max(c, 100.4), "l": 100.1, "c": c, "v": 1})
    return bars


S = core.utc_ms("2026-11-02 13:00")


class TestCore(unittest.TestCase):
    def test_session_start(self):
        self.assertEqual(core.session_start(core.utc_ms("2026-11-02 14:00"), "13:00"), S)
        self.assertEqual(core.session_start(core.utc_ms("2026-11-02 02:00"), "13:00"), S - 86400000)

    def test_signal_states(self):
        bars = session_with_breakout(S)
        sig = core.orb_signal(core.closed_only(bars, S + 30 * 60000), S + 30 * 60000, CFG)
        self.assertEqual(sig["status"], "forming")
        now = S + 14 * IV  # candle 14 ainda nao fechou
        self.assertEqual(core.orb_signal(core.closed_only(bars, now), now, CFG)["status"], "waiting")
        now = S + 15 * IV
        sig = core.orb_signal(core.closed_only(bars, now), now, CFG)
        self.assertEqual(sig["status"], "triggered")
        self.assertEqual(sig["trigger"]["slot"], 14)
        self.assertEqual(sig["trigger"]["close"], 101.5)
        self.assertEqual((sig["range_high"], sig["range_low"], sig["range_mid"]), (101.0, 99.0, 100.0))
        now = S + 6 * 3600000
        flat = [dict(b, c=100, h=100.4) for b in bars]
        self.assertEqual(core.orb_signal(core.closed_only(flat, now), now, CFG)["status"], "expired")

    def test_no_trigger_outside_window(self):
        bars = session_with_breakout(S, trig_slot=80)  # 80*5 = 400min > 60+240
        now = S + 7 * 3600000
        self.assertEqual(core.orb_signal(core.closed_only(bars, now), now, CFG)["status"], "expired")

    def test_costs(self):
        self.assertAlmostEqual(core.round_trip_cost(100, 101, 0.1, 0.05), 201 * 0.0015)
        self.assertAlmostEqual(core.net_r(100, 99, 99, 0.1, 0.05), (-1 - 199 * 0.0015) / 1.0)
        self.assertAlmostEqual(core.loss_per_unit(100, 99, 0.1, 0.05), 1 + 199 * 0.0015)

    def test_decimal_steps(self):
        self.assertEqual(core.dstr(core.floor_step(0.123456, "0.001")), "0.123")
        self.assertEqual(core.dstr(core.ceil_step(101.231, "0.01")), "101.24")
        self.assertEqual(core.dstr(core.floor_step(12, "1")), "12")

    def test_target_parse(self):
        self.assertEqual(core.parse_target_r("1.5R"), 1.5)
        self.assertEqual(core.parse_target_r("2"), 2.0)
        with self.assertRaises(core.TraderError):
            core.parse_target_r("abc")

    def test_session_bars_ask_only_from_session_start(self):
        seen = {}

        def fake(symbol, limit=320, start=None, end=None):
            seen.update(symbol=symbol, limit=limit, start=start)
            return session_with_breakout(S)
        now = S + 15 * IV
        with mock.patch.object(core, "get_klines", fake):
            bars = core.get_session_bars("BTCUSDT", now, CFG)
        self.assertEqual(seen["start"], S)
        self.assertEqual(len(bars), 15)  # só os fechados até agora

    def test_parse_klines_and_closed(self):
        rows = [[S, "1", "2", "0.5", "1.5", "10", S + IV - 1, "15", 3, "0", "0", "0"]]
        b = core.parse_klines(rows)
        self.assertEqual(b[0]["c"], 1.5)
        self.assertEqual(b[0]["v"], 15.0)
        self.assertEqual(core.closed_only(b, S + IV - 1), [])
        self.assertEqual(len(core.closed_only(b, S + IV)), 1)


class TestScan(unittest.TestCase):
    def test_mini_ticker_and_cache(self):
        raw = [{"symbol": "BTCUSDT", "openPrice": "100", "lastPrice": "99", "quoteVolume": "900000000"},
               {"symbol": "UUSDT", "openPrice": "1.0000", "lastPrice": "0.9999", "quoteVolume": "60000000"},
               {"symbol": "ETHBTC", "openPrice": "1", "lastPrice": "1", "quoteVolume": "5"}]
        calls = []
        with tempfile.TemporaryDirectory() as d:
            os.environ["TRADER_DIR"] = d
            try:
                def fake(path, params=None):
                    calls.append((path, params))
                    return raw
                with mock.patch.object(core, "market_get", fake):
                    t1 = scan.load_tickers(CFG, now=1000)
                    t2 = scan.load_tickers(CFG, now=1000 + 60000)           # dentro do TTL: usa o cache
                    t3 = scan.load_tickers(CFG, now=1000 + 31 * 60000)      # passou do TTL: busca de novo
                self.assertEqual(len(calls), 2)
                self.assertEqual(calls[0], ("/api/v3/ticker/24hr", {"type": "MINI"}))
                self.assertEqual(t1, t2)
                u = scan.pick_universe(t3, CFG, 10)
                self.assertEqual([x["symbol"] for x in u], ["BTCUSDT"])      # UUSDT: stablecoin
                self.assertAlmostEqual(u[0]["change_pct"], -1.0)
            finally:
                os.environ.pop("TRADER_DIR", None)

    def test_universe_filters(self):
        tick = [
            {"symbol": "BTCUSDT", "quoteVolume": "900000000", "priceChangePercent": "1"},
            {"symbol": "USDCUSDT", "quoteVolume": "800000000"},
            {"symbol": "ETHBTC", "quoteVolume": "800000000"},
            {"symbol": "XYZUSDT", "quoteVolume": "1000"},
            {"symbol": "ETHUSDT", "quoteVolume": "500000000"},
        ]
        u = scan.pick_universe(tick, CFG, 10)
        self.assertEqual([x["symbol"] for x in u], ["BTCUSDT", "ETHUSDT"])
        more = tick + [
            {"symbol": "UUSDT", "quoteVolume": "60000000", "lastPrice": "0.9998", "priceChangePercent": "-0.04"},
            {"symbol": "SNDKBUSDT", "quoteVolume": "45000000", "lastPrice": "600", "priceChangePercent": "-3.9"},
            {"symbol": "SOLUSDT", "quoteVolume": "150000000", "lastPrice": "170", "priceChangePercent": "-2.2"}]
        cfg = dict(CFG, exclude_bases=["SNDKB"])
        self.assertEqual([x["symbol"] for x in scan.pick_universe(more, cfg, 10)], ["BTCUSDT", "ETHUSDT", "SOLUSDT"])

    def test_scan_and_filter(self):
        now = S + 15 * IV
        data = {"AAAUSDT": session_with_breakout(S), "BBBUSDT": session_with_breakout(S, hi=100.2, lo=100.0)}
        uni = [{"symbol": k, "quote_volume": 1e8} for k in data]
        res = scan.scan_orb(uni, now, CFG, lambda s: core.closed_only(data[s], now))
        hits = scan.filter_hits(res, CFG)
        self.assertEqual([h["symbol"] for h in hits], ["AAAUSDT"])  # BBB: faixa estreita demais

    def test_chase_filter(self):
        now = S + 15 * IV
        res = scan.scan_orb([{"symbol": "A", "quote_volume": 1}], now, CFG,
                            lambda s: core.closed_only(session_with_breakout(S, close=103.5), now))
        self.assertEqual(scan.filter_hits(res, CFG), [])
        why = scan.explain_filtered(res, CFG)
        self.assertEqual(why[0][0], "A")
        self.assertIn("acima do topo", why[0][1])
        res = scan.scan_orb([{"symbol": "B", "quote_volume": 1}], now, CFG,
                            lambda s: core.closed_only(session_with_breakout(S, hi=100.2, lo=100.0), now))
        self.assertIn("abaixo do mínimo", scan.explain_filtered(res, CFG)[0][1])


class TestPlanSizeRisk(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["TRADER_DIR"] = self.tmp.name
        self.now = S + 15 * IV + 60000
        bars = core.closed_only(session_with_breakout(S), self.now)
        self.sig = core.orb_signal(bars, self.now, CFG)
        self.plan = planmod.build_plan("btcusdt", self.sig, CFG, "or-mid", 1.5, now=self.now)
        self.info = {"symbols": [{"symbol": "BTCUSDT", "status": "TRADING", "baseAsset": "BTC", "quoteAsset": "USDT",
                                  "filters": [{"filterType": "PRICE_FILTER", "tickSize": "0.01"},
                                              {"filterType": "LOT_SIZE", "minQty": "0.00001", "stepSize": "0.00001"},
                                              {"filterType": "NOTIONAL", "minNotional": "5.00"}]}]}

    def tearDown(self):
        os.environ.pop("TRADER_DIR", None)
        self.tmp.cleanup()

    def test_plan_numbers(self):
        p = self.plan
        self.assertEqual((p["entry"], p["stop"], p["target"]), (101.5, 100.0, 103.75))
        self.assertEqual(p["entry_slot"], 14)
        self.assertEqual(p["symbol"], "BTCUSDT")

    def test_plan_requires_trigger(self):
        sig = dict(self.sig, status="waiting", trigger=None)
        with self.assertRaises(core.TraderError):
            planmod.build_plan("X", sig, CFG, "or-mid", 1.0)

    def test_plan_rejects_entry_far_above_range(self):
        sig = dict(self.sig, status="waiting", trigger=None)
        with self.assertRaises(core.TraderError):
            planmod.build_plan("X", sig, CFG, "or-mid", 1.0, entry=110.0, now=self.now)  # 8.9% acima do topo 101

    def test_testplan_only_in_paper(self):
        p = planmod.build_testplan("BTCUSDT", 76962.61, CFG, 1.0, 1.5, self.now)
        self.assertTrue(p["test_plan"])
        self.assertAlmostEqual(p["stop"], 76962.61 * 0.99)
        self.assertAlmostEqual(p["target"], 76962.61 + 1.5 * (76962.61 * 0.01))
        with self.assertRaises(core.TraderError):
            planmod.build_testplan("BTCUSDT", 1.0, dict(CFG, paper=False), 1.0, 1.5, self.now)

    def test_plan_manual_entry_slot(self):
        sig = dict(self.sig, status="waiting", trigger=None)
        p = planmod.build_plan("X", sig, CFG, "or-mid", 1.0, entry=101.2, now=self.now)
        self.assertEqual(p["entry_slot"], 15 - 1)

    def test_size_math(self):
        o = size.size_order(self.plan, CFG, size.parse_rules(self.info, "BTCUSDT"))
        e = float(o["entry"]["price"])
        self.assertAlmostEqual(e, 101.61, places=2)  # 101.5 + 0.1%
        lpu = core.loss_per_unit(e, 100.0, 0.1, 0.05)
        self.assertLessEqual(o["notional"], 500.01)                      # teto de 50% de 1000 manda aqui
        self.assertLess(o["max_loss"], CFG["max_loss_per_trade"])
        big = size.size_order(self.plan, dict(CFG, account=100000), size.parse_rules(self.info, "BTCUSDT"))
        self.assertLessEqual(float(big["qty"]) * lpu, CFG["max_loss_per_trade"] + 1e-9)   # aqui manda o risco
        self.assertGreater(float(big["qty"]) * lpu, CFG["max_loss_per_trade"] - lpu * 0.00001 - 1e-9)

    def test_size_too_small(self):
        cfg = dict(CFG, max_loss_per_trade=0.0001)
        with self.assertRaises(core.TraderError):
            size.size_order(self.plan, cfg, size.parse_rules(self.info, "BTCUSDT"))

    def test_rules_not_trading(self):
        self.info["symbols"][0]["status"] = "BREAK"
        with self.assertRaises(core.TraderError):
            size.parse_rules(self.info, "BTCUSDT")

    def _order(self):
        return size.size_order(self.plan, CFG, size.parse_rules(self.info, "BTCUSDT"))

    def test_risk_pass_and_blocks(self):
        real = self._order()
        now = self.now + 2 * 60000
        names = lambda cs, lvl: {c["name"] for c in cs if c["level"] == lvl}
        # com taxas e buffer de compra, 1.5R aqui rende menos de 1:1 e o risk barra
        self.assertLess(real["reward_risk"], 1.0)
        self.assertEqual(names(risk.run_checks(self.plan, real, CFG, {"orders": []}, now), "block"), {"retorno/risco"})
        o = dict(real, reward_risk=1.2)
        cs = risk.run_checks(self.plan, o, CFG, {"orders": []}, now)
        self.assertEqual(names(cs, "block"), set())
        # limite diario estourado
        st = {"orders": [{"date": core.today_utc(now), "status": "protected", "max_loss": 25}]}
        self.assertIn("limite do dia", names(risk.run_checks(self.plan, o, CFG, st, now), "block"))
        # trades demais
        st = {"orders": [{"date": core.today_utc(now), "status": "flattened", "max_loss": 1}] * 3}
        self.assertIn("trades no dia", names(risk.run_checks(self.plan, o, CFG, st, now), "block"))
        # sinal velho
        self.assertIn("sinal fresco", names(risk.run_checks(self.plan, o, CFG, {"orders": []}, now + 30 * 60000), "block"))
        # depois da janela
        self.assertIn("janela de entrada", names(risk.run_checks(self.plan, o, CFG, {"orders": []}, self.plan["window_end"] + 1), "block"))
        # perda maior que o limite
        self.assertIn("perda máxima", names(risk.run_checks(self.plan, dict(o, max_loss=50), CFG, {"orders": []}, now), "block"))

    def test_risk_force_only_in_paper(self):
        o = dict(self._order(), reward_risk=1.2)
        core.write_json(core.path_in("plan.json"), self.plan)
        core.write_json(core.path_in("orders.json"), o)
        late = "2026-11-02 20:00"   # janela fechada, sinal velho
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = risk.main(["--now", late])
        self.assertEqual(rc, 2)
        test_plan = dict(self.plan, test_plan=True)
        core.write_json(core.path_in("plan.json"), test_plan)
        core.write_json(core.path_in("orders.json"), dict(o, plan_fingerprint=core.fingerprint(test_plan)))  # size.py roda depois do plano
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = risk.main(["--now", late, "--force"])
        self.assertEqual(rc, 0, buf.getvalue())
        self.assertIn("TESTE DE TUBULAÇÃO", buf.getvalue())
        core.write_json(core.path_in("config.json"), {"paper": False})
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = risk.main(["--force"])
        self.assertEqual(rc, 1)
        self.assertIn("--force", buf.getvalue())

    def test_risk_counts_every_status_of_the_day(self):
        o = dict(self._order(), reward_risk=1.2)
        now = self.now + 2 * 60000
        names = lambda cs: {c["name"] for c in cs if c["level"] == "block"}
        today = core.today_utc(now)
        # trade que já fechou no stop e resposta incerta da Binance também comprometem o dia
        for status in ("closed", "entry_pending", "qualquer-outro"):
            st = {"orders": [{"date": today, "status": status, "max_loss": 25}]}
            self.assertIn("limite do dia", names(risk.run_checks(self.plan, o, CFG, st, now)), status)
        st = {"orders": [{"date": today, "status": "closed", "max_loss": 1}] * 3}
        self.assertIn("trades no dia", names(risk.run_checks(self.plan, o, CFG, st, now)))
        st = {"orders": [{"date": "2026-11-01", "status": "closed", "max_loss": 25}]}
        self.assertEqual(names(risk.run_checks(self.plan, o, CFG, st, now)), set())

    def _risk_cli(self, *args):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = risk.main(list(args))
        return rc, buf.getvalue()

    def test_risk_main_blocks_order_from_other_plan(self):
        o = dict(self._order(), reward_risk=1.2)
        core.write_json(core.path_in("orders.json"), o)
        when = "2026-11-02 14:18"   # self.now (14:16) + 2 min
        core.write_json(core.path_in("plan.json"), self.plan)
        rc, out = self._risk_cli("--now", when)
        self.assertEqual(rc, 0, out)
        core.write_json(core.path_in("plan.json"), dict(self.plan, target=self.plan["target"] + 1))
        rc, out = self._risk_cli("--now", when)
        self.assertEqual(rc, 2, out)
        self.assertIn("ordem do plano atual", out)
        core.write_json(core.path_in("plan.json"), dict(self.plan, symbol="ETHUSDT"))
        self.assertEqual(self._risk_cli("--now", when)[0], 2)

    def test_risk_main_ignores_record_of_this_same_order(self):
        o = dict(self._order(), reward_risk=1.2)
        core.write_json(core.path_in("plan.json"), self.plan)
        core.write_json(core.path_in("orders.json"), o)
        now = self.now + 2 * 60000
        mine = {"date": core.today_utc(now), "status": "approved", "max_loss": o["max_loss"],
                "fingerprint": core.fingerprint(o)}
        core.write_json(core.path_in("state.json"), {"orders": [mine] * 3})   # rodar o risk de novo depois do "sim"
        when = "2026-11-02 14:18"
        rc, out = self._risk_cli("--now", when)
        self.assertEqual(rc, 0, out)
        core.write_json(core.path_in("state.json"), {"orders": [dict(mine, fingerprint="outra")] * 3})
        self.assertEqual(self._risk_cli("--now", when)[0], 2)

    def test_risk_now_only_in_paper(self):
        core.write_json(core.path_in("plan.json"), self.plan)
        core.write_json(core.path_in("orders.json"), dict(self._order(), reward_risk=1.2))
        core.write_json(core.path_in("config.json"), {"paper": False})
        rc, out = self._risk_cli("--now", "2026-11-02 14:16")
        self.assertEqual(rc, 1)
        self.assertIn("--now", out)
        self.assertIsNone(core.read_json(core.path_in("risk.json")))

    def test_risk_warns_without_timemachine(self):
        cs = risk.run_checks(self.plan, self._order(), CFG, {"orders": []}, self.now)
        self.assertEqual([c["level"] for c in cs if c["name"] == "time machine"], ["warn"])


class TestTimeMachine(unittest.TestCase):
    def history(self, n=30, drift=0.0, seed=5):
        bars = []
        for d in range(n):
            s = S - (n - d) * 86400000
            bars += make_bars(s, 96, 100 + d * 0.01, seed=seed + d, vol=0.002, drift=drift)
        return bars

    def setUp(self):
        now = S + 15 * IV + 60000
        sig = core.orb_signal(core.closed_only(session_with_breakout(S), now), now, CFG)
        self.plan = planmod.build_plan("BTCUSDT", sig, CFG, "or-mid", 1.5, now=now)

    def test_full_sessions_drop_incomplete(self):
        bars = self.history(25)
        del bars[100]  # buraco num pregao
        ss = timemachine.full_sessions(bars, self.plan["params"], S)
        self.assertEqual(len(ss), 24)

    def test_deterministic_and_sums(self):
        ss = timemachine.full_sessions(self.history(30), self.plan["params"], S)
        a = timemachine.run_mc(self.plan, ss, CFG, 2000, 19, 2)
        b = timemachine.run_mc(self.plan, ss, CFG, 2000, 19, 2)
        self.assertEqual(a, b)
        self.assertEqual(sum(a["counts"].values()), 2000)
        self.assertAlmostEqual(sum(a["pct"].values()), 100.0)
        c = timemachine.run_mc(self.plan, ss, CFG, 2000, 7, 2)
        self.assertNotEqual(a["counts"], c["counts"])

    def test_costs_lower_r(self):
        ss = timemachine.full_sessions(self.history(30), self.plan["params"], S)
        free = timemachine.run_mc(self.plan, ss, dict(CFG, fee_pct=0, slippage_pct=0), 3000, 19, 2)
        paid = timemachine.run_mc(self.plan, ss, CFG, 3000, 19, 2)
        self.assertLess(paid["avg_net_r"], free["avg_net_r"])

    def test_both_touched_counts_as_stop(self):
        # candle enorme que toca stop e alvo: tem que contar como stop
        n = 96
        wide = []
        for d in range(25):
            s = S - (25 - d) * 86400000
            bars = [{"t": s + i * IV, "o": 100, "h": 100, "l": 100, "c": 100, "v": 1} for i in range(n)]
            for i in range(15, n):
                bars[i] = {"t": s + i * IV, "o": 100, "h": 110, "l": 90, "c": 100, "v": 1}
            wide += bars
        ss = timemachine.full_sessions(wide, self.plan["params"], S)
        mc = timemachine.run_mc(self.plan, ss, CFG, 200, 19, 0)
        self.assertEqual(mc["counts"]["stop"], 200)

    def test_history_rule_replays_known_session(self):
        # pregoes iguais: rompe no slot 14 a 101.5, stop 100, alvo 103.75; depois sobe a 104
        sessions = []
        for d in range(20):
            s = S - (20 - d) * 86400000
            bars = session_with_breakout(s)
            for i in range(20, 30):
                bars[i] = {"t": s + i * IV, "o": 101.5, "h": 104, "l": 101.4, "c": 103.5, "v": 1}
            sessions.append((s, bars))
        h = timemachine.run_history(self.plan, sessions, CFG)
        self.assertEqual((h["fired"], h["target"], h["stop"]), (20, 20, 0))
        self.assertGreater(h["avg_net_r"], 0.5)

    def test_verdict_text(self):
        mc = {"counts": {"target": 40, "stop": 60, "open": 0}}
        v = timemachine.verdict(mc, self.plan, CFG)
        self.assertTrue(v.startswith("Pende para o stop"), v)
        mc = {"counts": {"target": 48, "stop": 52, "open": 0}}
        self.assertTrue(timemachine.verdict(mc, self.plan, CFG).startswith("Perto de empate"))
        mc = {"counts": {"target": 90, "stop": 10, "open": 0}}
        self.assertTrue(timemachine.verdict(mc, self.plan, CFG).startswith("Forte para o alvo"))

    def test_verdict_impossible_when_costs_exceed_target(self):
        plan = dict(self.plan, entry=0.3179, stop=0.3173, target=0.3188, target_r=1.5)
        mc = {"counts": {"target": 31, "stop": 68, "open": 1}}
        v = timemachine.verdict(mc, plan, CFG)
        self.assertTrue(v.startswith("Impossível empatar"), v)

    def test_cli_runs_from_fixture(self):
        with tempfile.TemporaryDirectory() as d:
            os.environ["TRADER_DIR"] = d
            try:
                core.write_json(os.path.join(d, "plan.json"), self.plan)
                fx = os.path.join(d, "bars.json")
                json.dump(self.history(30), open(fx, "w"))
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf):
                    rc = timemachine.main(["run", "--fixture", fx, "--now", "2026-11-02 14:20",
                                           "--replays", "500", "--write"])
                self.assertEqual(rc, 0, buf.getvalue())
                self.assertIn("Veredito:", buf.getvalue())
                self.assertTrue(os.path.exists(os.path.join(d, "timemachine.json")))
            finally:
                os.environ.pop("TRADER_DIR", None)


INFO = {"symbols": [{"symbol": "BTCUSDT", "status": "TRADING", "baseAsset": "BTC", "quoteAsset": "USDT",
                     "isSpotTradingAllowed": True, "ocoAllowed": True, "otoAllowed": True,
                     "orderTypes": ["LIMIT", "LIMIT_MAKER", "MARKET", "STOP_LOSS_LIMIT", "TAKE_PROFIT_LIMIT"],
                     "filters": [{"filterType": "PRICE_FILTER", "tickSize": "0.01"},
                                 {"filterType": "LOT_SIZE", "minQty": "0.00001", "maxQty": "9000", "stepSize": "0.00001"},
                                 {"filterType": "MARKET_LOT_SIZE", "minQty": "0", "maxQty": "100", "stepSize": "0"},
                                 {"filterType": "PERCENT_PRICE_BY_SIDE", "bidMultiplierUp": "5", "bidMultiplierDown": "0.2",
                                  "askMultiplierUp": "5", "askMultiplierDown": "0.2", "avgPriceMins": 5},
                                 {"filterType": "NOTIONAL", "minNotional": "5.00", "maxNotional": "9000000", "applyMinToMarket": True},
                                 {"filterType": "MAX_NUM_ALGO_ORDERS", "maxNumAlgoOrders": 5}]}]}


class FakeExchange:
    """Corretora falsa: registra tudo que recebe e responde como a documentação descreve."""

    def __init__(self, fill=True, fail_oco=False, fok_fill=True):
        self.sent, self.fill, self.fail_oco, self.fok_fill = [], fill, fail_oco, fok_fill
        self.qty = None
        self.open_lists = []

    def __call__(self, url, params=None, headers=None, data=None, method=None, timeout=20, retries=2):
        body = (data or b"").decode()
        self.sent.append((method, url, body, headers or {}))
        path = url.split("?")[0]
        if path.endswith("/api/v3/time"):
            return {"serverTime": int(__import__("time").time() * 1000) + 250}
        if path.endswith("/api/v3/executionRules"):
            return {"symbolRules": [{"symbol": "BTCUSDT", "rules": [
                {"ruleType": "PRICE_RANGE", "bidLimitMultUp": "2", "bidLimitMultDown": "0.5",
                 "askLimitMultUp": "2", "askLimitMultDown": "0.5"}]}]}
        if path.endswith("/api/v3/referencePrice"):
            return {"symbol": "BTCUSDT", "referencePrice": "101.5"}
        if path.endswith("/api/v3/orderList/otoco"):
            if self.fok_fill:
                return {"orderListId": 77, "listStatusType": "EXEC_STARTED", "orderReports": [
                    {"side": "BUY", "type": "LIMIT", "status": "FILLED", "executedQty": self.qty,
                     "cummulativeQuoteQty": "%.8f" % (float(self.qty) * 101.5)},
                    {"side": "SELL", "type": "LIMIT_MAKER", "status": "PENDING_NEW"},
                    {"side": "SELL", "type": "STOP_LOSS_LIMIT", "status": "PENDING_NEW"}]}
            return {"orderListId": 78, "listStatusType": "ALL_DONE", "orderReports": [
                {"side": "BUY", "type": "LIMIT", "status": "EXPIRED", "executedQty": "0.00000000",
                 "cummulativeQuoteQty": "0.00000000"}]}
        if path.endswith("/api/v3/orderList/oco"):
            if self.fail_oco:
                raise core.ApiError("HTTP 400 em oco: parametro invalido")
            return {"orderListId": 7}
        if path.endswith("/api/v3/openOrderList") and method == "GET":
            return self.open_lists
        if path.endswith("/api/v3/orderList") and method == "DELETE":
            return {"orderListId": 7, "listOrderStatus": "ALL_DONE"}
        if path.endswith("/api/v3/openOrders") and method == "DELETE":
            return []
        if path.endswith("/api/v3/order") and method == "POST":
            if "type=MARKET" in body:
                return {"status": "FILLED", "executedQty": "1"}
            if not self.fill:
                return {"orderId": 2, "executedQty": "0.00000000", "cummulativeQuoteQty": "0.00000000", "fills": []}
            return {"orderId": 1, "executedQty": self.qty, "cummulativeQuoteQty": "%.8f" % (float(self.qty) * 101.5),
                    "fills": [{"commission": "0.00001", "commissionAsset": "BTC"}]}
        return {}

    def paths(self):
        return [(m, u.split("?")[0].replace(core.TEST_HOST, "")) for m, u, _, _ in self.sent
                if not u.endswith(("/api/v3/time",)) and "executionRules" not in u and "referencePrice" not in u]


class TestSizeRules(unittest.TestCase):
    def setUp(self):
        now = S + 15 * IV + 60000
        sig = core.orb_signal(core.closed_only(session_with_breakout(S), now), now, CFG)
        self.plan = planmod.build_plan("BTCUSDT", sig, CFG, "or-mid", 1.5, now=now)
        self.rules = size.parse_rules(INFO, "BTCUSDT")

    def test_rules_parsed(self):
        r = self.rules
        self.assertTrue(r["oto_allowed"] and r["oco_allowed"])
        self.assertEqual((r["bid_mult_up"], r["ask_mult_down"]), (5.0, 0.2))
        self.assertEqual(r["max_notional"], "9000000")

    def test_mode_otoco_and_sell_qty_after_fee(self):
        o = size.size_order(self.plan, CFG, self.rules, avg_price=101.5)
        self.assertEqual(o["mode"], "otoco")
        self.assertEqual(o["entry"]["timeInForce"], "FOK")
        self.assertLess(Decimal(o["exit"]["quantity"]), Decimal(o["qty"]))
        self.assertAlmostEqual(float(o["exit"]["quantity"]) / float(o["qty"]), 1 - CFG["fee_pct"] / 100, places=4)
        o2 = size.size_order(self.plan, dict(CFG, fee_in_bnb=True), self.rules, avg_price=101.5)
        self.assertEqual(o2["exit"]["quantity"], o2["qty"])
        o3 = size.size_order(self.plan, dict(CFG, entry_mode="two-step"), self.rules, avg_price=101.5)
        self.assertEqual((o3["mode"], o3["entry"]["timeInForce"]), ("two-step", "IOC"))

    def test_percent_price_by_side_blocks(self):
        with self.assertRaises(core.TraderError):
            size.size_order(self.plan, CFG, self.rules, avg_price=10.0)   # compra 10x acima da média
        with self.assertRaises(core.TraderError):
            size.size_order(self.plan, CFG, self.rules, avg_price=1000.0)  # stop limite abaixo de 0.2x

    def test_max_notional_caps(self):
        rules = dict(self.rules, max_notional="200")
        o = size.size_order(self.plan, CFG, rules, avg_price=101.5)
        self.assertLessEqual(o["notional"], 200.0)

    def test_missing_order_types_rejected(self):
        info = {"symbols": [dict(INFO["symbols"][0], orderTypes=["LIMIT", "MARKET"])]}
        with self.assertRaises(core.TraderError):
            size.parse_rules(info, "BTCUSDT")


class TestBroker(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["TRADER_DIR"] = self.tmp.name
        self.now = S + 15 * IV + 60000
        sig = core.orb_signal(core.closed_only(session_with_breakout(S), self.now), self.now, CFG)
        self.plan = planmod.build_plan("BTCUSDT", sig, CFG, "or-mid", 1.5, now=self.now)
        core.write_json(core.path_in("plan.json"), self.plan)
        os.environ["BINANCE_TESTNET_API_KEY"] = "k"
        os.environ["BINANCE_TESTNET_API_SECRET"] = "s"
        self.stamp = core.today_utc(self.now)
        broker._clock["offset"] = None
        self.use_mode("otoco")

    def use_mode(self, mode):
        cfg = dict(CFG, entry_mode=mode)
        self.order = size.size_order(self.plan, cfg, size.parse_rules(INFO, "BTCUSDT"), avg_price=101.5)
        core.write_json(core.path_in("orders.json"), self.order)
        core.write_json(core.path_in("config.json"), {"entry_mode": mode})

    def tearDown(self):
        for k in ("TRADER_DIR", "BINANCE_TESTNET_API_KEY", "BINANCE_TESTNET_API_SECRET", "BN_LIVE"):
            os.environ.pop(k, None)
        self.tmp.cleanup()

    def run_cli(self, *args):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = broker.main(["--now", "2026-11-02 14:16"] + list(args))
        return rc, buf.getvalue()

    def risk_pass(self):
        core.write_json(core.path_in("risk.json"), {"fingerprint": core.fingerprint(self.order), "verdict": "PASS",
                                                   "checked_at": core.utc_ms("2026-11-02 14:16"), "date": self.stamp,
                                                   "checks": []})

    def state(self):
        return core.read_json(core.path_in("state.json"))["orders"][0]

    def test_signature_vector_from_binance_docs(self):
        qs = ("symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1"
              "&recvWindow=5000&timestamp=1499827319559")
        sec = "NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j"
        self.assertEqual(broker.sign(qs, sec), "c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71")

    def test_parse_yes(self):
        o = self.order
        self.assertTrue(broker.parse_yes("sim BTCUSDT", o)[0])
        self.assertTrue(broker.parse_yes("Yes, btc", o)[0])
        self.assertFalse(broker.parse_yes("sim", o)[0])
        self.assertFalse(broker.parse_yes("ok BTCUSDT", o)[0])
        self.assertFalse(broker.parse_yes("não sim BTCUSDT", o)[0])
        self.assertFalse(broker.parse_yes("", o)[0])

    def test_no_send_without_risk_or_yes(self):
        rc, out = self.run_cli("send", "entry")
        self.assertEqual(rc, 1)
        self.assertIn("risk.py", out)
        self.risk_pass()
        rc, out = self.run_cli("send", "entry")
        self.assertEqual(rc, 1)
        self.assertIn("sim", out)

    def test_risk_block_stops_everything(self):
        self.risk_pass()
        r = core.read_json(core.path_in("risk.json"))
        r["verdict"] = "BLOCK"
        core.write_json(core.path_in("risk.json"), r)
        rc, out = self.run_cli("approve", "--reply", "sim BTCUSDT")
        self.assertEqual(rc, 1)
        self.assertIn("BLOCK", out)

    def test_risk_for_other_order_rejected(self):
        self.risk_pass()
        core.write_json(core.path_in("orders.json"), dict(self.order, qty="9"))
        self.assertEqual(self.run_cli("approve", "--reply", "sim BTCUSDT")[0], 1)

    def test_live_requires_flags(self):
        with self.assertRaises(core.TraderError):
            broker.endpoint(dict(CFG, paper=False), env={"BINANCE_API_KEY": "k", "BINANCE_API_SECRET": "s"})
        host, _, _ = broker.endpoint(dict(CFG, paper=False), env={"BN_LIVE": "1", "BINANCE_API_KEY": "k", "BINANCE_API_SECRET": "s"})
        self.assertEqual(host, core.LIVE_HOST)
        host, _, _ = broker.endpoint(CFG, env={"BINANCE_TESTNET_API_KEY": "k", "BINANCE_TESTNET_API_SECRET": "s"})
        self.assertEqual(host, core.TEST_HOST)
        with self.assertRaises(core.TraderError):
            broker.endpoint(CFG, env={})

    def test_otoco_params_match_official_docs(self):
        p = broker.otoco_params(self.order, "abc")
        self.assertEqual((p["workingType"], p["workingSide"], p["workingTimeInForce"]), ("LIMIT", "BUY", "FOK"))
        self.assertEqual((p["pendingSide"], p["pendingAboveType"], p["pendingBelowType"]), ("SELL", "LIMIT_MAKER", "STOP_LOSS_LIMIT"))
        self.assertEqual(p["pendingBelowTimeInForce"], "GTC")
        self.assertEqual(p["pendingQuantity"], self.order["exit"]["quantity"])
        self.assertLess(float(p["pendingBelowPrice"]), float(p["pendingBelowStopPrice"]))
        self.assertGreater(float(p["pendingAbovePrice"]), float(p["workingPrice"]))

    def test_clock_offset_applied_to_timestamp(self):
        fx = FakeExchange()
        fx.qty = self.order["qty"]
        with mock.patch.object(core, "http_json", fx):
            broker.signed("GET", core.TEST_HOST, "/api/v3/account", {}, "k", "s")
        self.assertIn(broker._clock["offset"], (249, 250, 251))
        url = [u for _, u, _, _ in fx.sent if "/api/v3/account" in u][0]
        ts = int(url.split("timestamp=")[1].split("&")[0])
        self.assertGreater(ts, int(__import__("time").time() * 1000) + 100)

    def test_otoco_full_flow(self):
        self.risk_pass()
        fx = FakeExchange()
        fx.qty = self.order["qty"]
        with mock.patch.object(core, "http_json", fx):
            self.assertEqual(self.run_cli("approve", "--reply", "sim BTCUSDT")[0], 0)
            self.assertEqual(self.run_cli("approve", "--reply", "sim BTCUSDT")[0], 1)   # já registrado
            self.assertEqual(self.run_cli("send", "exit")[0], 1)                         # não existe no otoco
            rc, out = self.run_cli("send", "entry")
            self.assertEqual(rc, 0, out)
            self.assertIn("Alvo e stop já estão", out)
            self.assertEqual(self.state()["status"], "protected")
            self.assertEqual(self.state()["order_list_id"], 77)
            self.assertEqual(self.run_cli("send", "entry")[0], 1)                        # não compra de novo
            rc, out = self.run_cli("flatten", "--reply", "sim BTCUSDT")
            self.assertEqual(rc, 0, out)
        self.assertEqual(self.state()["status"], "flattened")
        self.assertEqual(fx.paths(), [("POST", "/api/v3/orderList/otoco"), ("DELETE", "/api/v3/orderList"),
                                      ("POST", "/api/v3/order")])
        otoco_body = fx.sent[[i for i, s in enumerate(fx.sent) if "otoco" in s[1]][0]][2]
        for key in ("workingTimeInForce=FOK", "pendingAboveType=LIMIT_MAKER", "pendingBelowType=STOP_LOSS_LIMIT",
                    "pendingBelowTimeInForce=GTC", "signature="):
            self.assertIn(key, otoco_body)
        cancel_url = [u for m, u, _, _ in fx.sent if m == "DELETE"][0]
        self.assertIn("orderListId=77", cancel_url)
        for _, url, body, hdr in fx.sent:
            self.assertTrue(url.startswith(core.TEST_HOST))
            if "signature=" in body + url:
                self.assertEqual(hdr["X-MBX-APIKEY"], "k")

    def test_otoco_fok_not_filled(self):
        self.risk_pass()
        fx = FakeExchange(fok_fill=False)
        fx.qty = self.order["qty"]
        with mock.patch.object(core, "http_json", fx):
            self.run_cli("approve", "--reply", "sim BTCUSDT")
            rc, out = self.run_cli("send", "entry")
        self.assertEqual(rc, 0, out)
        self.assertIn("Nada foi comprado", out)
        self.assertEqual(self.state()["status"], "entry_unfilled")
        self.assertEqual(self.run_cli("flatten", "--reply", "sim BTCUSDT")[0], 1)

    def test_two_step_full_flow(self):
        self.use_mode("two-step")
        self.risk_pass()
        fx = FakeExchange()
        fx.qty = self.order["qty"]
        with mock.patch.object(core, "http_json", fx):
            self.assertEqual(self.run_cli("approve", "--reply", "sim BTCUSDT")[0], 0)
            self.assertEqual(self.run_cli("send", "exit")[0], 1)          # não protege sem compra
            rc, out = self.run_cli("send", "entry")
            self.assertEqual(rc, 0, out)
            st = self.state()
            self.assertEqual(st["status"], "entry_filled")
            self.assertAlmostEqual(float(st["sellable_qty"]), float(self.order["qty"]) - 0.00001, places=8)
            self.assertEqual(self.run_cli("send", "exit")[0], 0)
            self.assertEqual(self.state()["status"], "protected")
            self.assertEqual(self.run_cli("flatten", "--reply", "sim BTCUSDT")[0], 0)
        self.assertEqual(fx.paths(), [("POST", "/api/v3/order"), ("POST", "/api/v3/orderList/oco"),
                                      ("DELETE", "/api/v3/orderList"), ("POST", "/api/v3/order")])
        entry_body = fx.sent[[i for i, s in enumerate(fx.sent) if s[1].endswith("/api/v3/order") and s[0] == "POST"][0]][2]
        self.assertIn("timeInForce=IOC", entry_body)
        oco_body = [b for _, u, b, _ in fx.sent if u.endswith("orderList/oco")][0]
        self.assertIn("aboveType=LIMIT_MAKER", oco_body)
        self.assertIn("belowType=STOP_LOSS_LIMIT", oco_body)

    def test_two_step_unfilled_ioc(self):
        self.use_mode("two-step")
        self.risk_pass()
        fx = FakeExchange(fill=False)
        fx.qty = self.order["qty"]
        with mock.patch.object(core, "http_json", fx):
            self.run_cli("approve", "--reply", "sim BTCUSDT")
            rc, out = self.run_cli("send", "entry")
        self.assertEqual(rc, 0)
        self.assertEqual(self.state()["status"], "entry_unfilled")

    def test_two_step_oco_failure_warns_unprotected(self):
        self.use_mode("two-step")
        self.risk_pass()
        fx = FakeExchange(fail_oco=True)
        fx.qty = self.order["qty"]
        with mock.patch.object(core, "http_json", fx):
            self.run_cli("approve", "--reply", "sim BTCUSDT")
            self.run_cli("send", "entry")
            rc, out = self.run_cli("send", "exit")
        self.assertEqual(rc, 1)
        self.assertIn("SEM stop", out)

    def test_dry_run_sends_nothing(self):
        self.risk_pass()
        with mock.patch.object(core, "http_json", side_effect=AssertionError("rede não deveria ser usada")):
            self.run_cli("approve", "--reply", "sim BTCUSDT")
            rc, out = self.run_cli("send", "entry", "--dry-run")
        self.assertEqual(rc, 0)
        self.assertIn("DRY-RUN", out)
        self.assertIn("otoco", out)

    def test_exec_rule_warning(self):
        fx = FakeExchange()
        low = dict(self.order, exit=dict(self.order["exit"], stop_limit="40"))  # abaixo de 0.5 x 101.5
        with mock.patch.object(core, "http_json", fx):
            self.assertIsNone(broker.exec_rule_warning(core.TEST_HOST, self.order))
            self.assertIn("faixa de execução", broker.exec_rule_warning(core.TEST_HOST, low))

    def _protected_record(self, order, **extra):
        rec = {"date": self.stamp, "at": self.now, "fingerprint": core.fingerprint(order), "symbol": order["symbol"],
               "status": "protected", "mode": order["mode"], "max_loss": order["max_loss"], "qty": order["qty"],
               "paper": order["paper"], "sellable_qty": order["exit"]["quantity"]}
        rec.update(extra)
        core.write_json(core.path_in("state.json"), {"orders": [rec]})

    def test_now_only_in_paper(self):
        core.write_json(core.path_in("config.json"), {"paper": False})
        with mock.patch.object(core, "http_json", side_effect=AssertionError("rede não deveria ser usada")):
            for args in (("status",), ("flatten", "--reply", "sim BTCUSDT"), ("send", "entry")):
                rc, out = self.run_cli(*args)
                self.assertEqual(rc, 1, args)
                self.assertIn("--now", out)

    def test_status_and_flatten_refuse_other_mode(self):
        live = dict(self.order, paper=False)           # dimensionada em modo real, config em paper
        core.write_json(core.path_in("orders.json"), live)
        self._protected_record(live, order_list_id=77)
        with mock.patch.object(core, "http_json", side_effect=AssertionError("rede não deveria ser usada")):
            for args in (("status",), ("flatten", "--reply", "sim BTCUSDT")):
                rc, out = self.run_cli(*args)
                self.assertEqual(rc, 1, args)
                self.assertIn("modo diferente", out)
        self.assertEqual(self.state()["status"], "protected")

    def test_flatten_without_list_id_cancels_only_own_lists(self):
        self._protected_record(self.order)              # protegida, mas sem order_list_id gravado
        fp = core.fingerprint(self.order)
        fx = FakeExchange()
        fx.open_lists = [
            {"orderListId": 7, "symbol": "BTCUSDT", "listClientOrderId": "bnd-%s-x-12345" % fp},
            {"orderListId": 9, "symbol": "BTCUSDT", "listClientOrderId": "minha-ordem-manual"},
            {"orderListId": 11, "symbol": "BTCUSDT", "listClientOrderId": "bnd-outraordem-x-1"},
            {"orderListId": 13, "symbol": "ETHUSDT", "listClientOrderId": "bnd-%s-x-9" % fp}]
        with mock.patch.object(core, "http_json", fx):
            rc, out = self.run_cli("flatten", "--reply", "sim BTCUSDT")
        self.assertEqual(rc, 0, out)
        self.assertNotIn(("DELETE", "/api/v3/openOrders"), fx.paths())
        cancels = [u for m, u, _, _ in fx.sent if m == "DELETE"]
        self.assertEqual(len(cancels), 1)
        self.assertIn("orderListId=7", cancels[0])
        self.assertEqual(self.state()["status"], "flattened")

    def test_check_is_read_only(self):
        fx = FakeExchange()

        def fake(url, **k):
            fx.sent.append((k.get("method"), url, "", k.get("headers") or {}))
            if url.endswith("/api/v3/time"):
                return {"serverTime": int(__import__("time").time() * 1000)}
            if "/account/commission" in url:
                return {"standardCommission": {"maker": "0.001", "taker": "0.001"},
                        "discount": {"enabledForAccount": True, "enabledForSymbol": True, "discountAsset": "BNB", "discount": "0.75"}}
            return {"canTrade": True, "balances": [{"asset": "USDT", "free": "10000.0", "locked": "0.0"},
                                                    {"asset": "BTC", "free": "0", "locked": "0"}]}
        with mock.patch.object(core, "http_json", fake):
            rc, out = self.run_cli("check")
        self.assertEqual(rc, 0, out)
        self.assertIn("USDT", out)
        self.assertIn("testnet não cobra", out)
        self.assertNotIn("ajuste", out)   # na testnet a comissão é 0 e não deve pedir ajuste
        self.assertTrue(all(m in (None, "GET") for m, _, _, _ in fx.sent))
        self.assertFalse(any("order" in u and "commission" not in u for _, u, _, _ in fx.sent))


class TestHistoryAndBacktest(unittest.TestCase):
    def make_zip(self, path, bars, micro=True):
        lines = []
        for b in bars:
            t = b["t"] * 1000 if micro else b["t"]
            lines.append("%d,%s,%s,%s,%s,1,%d,%s,10,0.5,0.5,0" % (t, b["o"], b["h"], b["l"], b["c"], t + 1, b["v"]))
        with zipfile.ZipFile(path, "w") as z:
            z.writestr(os.path.basename(path).replace(".zip", ".csv"), "\n".join(lines))

    def test_month_list(self):
        self.assertEqual(history.month_list(core.utc_ms("2026-11-02 14:00"), 3), [(2026, 8), (2026, 9), (2026, 10)])
        self.assertEqual(history.month_list(core.utc_ms("2026-01-15 00:00"), 2), [(2025, 11), (2025, 12)])

    def test_zip_with_microseconds_parses(self):
        with tempfile.TemporaryDirectory() as d:
            bars = make_bars(S, 10)
            p = os.path.join(d, "X-5m-2026-10.zip")
            self.make_zip(p, bars, micro=True)
            got = core.load_klines_file(p)
            self.assertEqual([b["t"] for b in got], [b["t"] for b in bars])
            self.assertAlmostEqual(got[3]["c"], bars[3]["c"])

    def test_load_merges_zips_and_api_gap(self):
        with tempfile.TemporaryDirectory() as d:
            os.environ["TRADER_DIR"] = d
            try:
                sym = "BTCUSDT"
                os.makedirs(history.history_dir(sym))
                m1 = make_bars(S - 20 * 86400000, 288 * 3)
                self.make_zip(history.zip_path(sym, 2026, 10), m1)
                now = m1[-1]["t"] + 50 * IV
                api = make_bars(m1[-1]["t"] + IV, 60)
                calls = []

                def fake_range(symbol, start, end):
                    calls.append((symbol, start, end))
                    return [b for b in api if start <= b["t"] < end]
                with mock.patch.object(core, "get_klines_range", fake_range):
                    bars = history.load(sym, now)
                self.assertEqual(calls[0][1], m1[-1]["t"] + IV)   # pediu só o que faltava
                self.assertEqual(len(bars), len(m1) + 49)          # o 50º ainda não fechou
                self.assertEqual(len({b["t"] for b in bars}), len(bars))
            finally:
                os.environ.pop("TRADER_DIR", None)

    def test_fetch_skips_existing_and_reports_404(self):
        with tempfile.TemporaryDirectory() as d:
            os.environ["TRADER_DIR"] = d
            try:
                sym = "BTCUSDT"
                os.makedirs(history.history_dir(sym))
                open(history.zip_path(sym, 2026, 10), "wb").close()
                asked = []

                def fake_dl(url, dest, timeout=60):
                    asked.append(url)
                    return "2026-09" in url
                with mock.patch.object(history, "download", fake_dl):
                    got, missing = history.fetch(sym, 3, core.utc_ms("2026-11-02 14:00"), log=lambda m: None)
                self.assertEqual(len(asked), 2)
                self.assertTrue(all("BTCUSDT-5m-2026-0" in u for u in asked))
                self.assertEqual(missing, ["2026-08"])
                self.assertEqual(len(got), 2)
            finally:
                os.environ.pop("TRADER_DIR", None)

    def test_backtest_detects_planted_edge(self):
        # 60 sessões onde o rompimento sempre vai ao alvo: R total alto no treino E no teste
        bars = []
        for d in range(60):
            s = S - (60 - d) * 86400000
            sess = session_with_breakout(s)
            for i in range(20, 30):
                sess[i] = {"t": s + i * IV, "o": 101.5, "h": 106, "l": 101.4, "c": 105, "v": 1}
            bars += sess
        combos = [{"anchor_utc": "13:00", "range_minutes": 60, "stop_rule": "or-mid", "target_r": 1.5, "min_range_pct": 1.0}]
        res = backtest.evaluate(bars, CFG, combos, 0.7, 240, 8, 1.0)
        r = res[0]
        self.assertEqual(r["sessions"], (42, 18))
        self.assertEqual(r["train"]["trades"], 42)
        self.assertGreater(r["train"]["sum_r"], 40)
        self.assertGreater(r["test"]["sum_r"], 15)
        self.assertEqual(r["test"]["win_pct"], 100.0)

    def test_backtest_random_is_negative_after_costs(self):
        bars = []
        for d in range(120):
            s = S - (120 - d) * 86400000
            bars += make_bars(s, 288, 100, seed=500 + d, vol=0.003)
        combos = list(backtest.grid(["00:00", "13:00"], [30, 60], ["or-mid"], [1.5, 2.0], [0.3]))
        res = backtest.evaluate(bars, CFG, combos, 0.7, 240, 8, 1.0)
        tot = sum(r["test"]["sum_r"] for r in res if r["test"]["trades"])
        self.assertTrue(any(r["test"]["trades"] > 5 for r in res))
        self.assertLess(tot, 0)   # sem vantagem, as taxas vencem

    def test_backtest_cli_offline(self):
        with tempfile.TemporaryDirectory() as d:
            os.environ["TRADER_DIR"] = d
            try:
                bars = []
                for day in range(120):
                    s = S - (120 - day) * 86400000
                    bars += make_bars(s, 288, 100, seed=900 + day, vol=0.004)
                fx = os.path.join(d, "bars.json")
                json.dump(bars, open(fx, "w"))
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf):
                    rc = backtest.main(["run", "BTCUSDT", "--fixture", fx, "--now", "2026-11-02 14:00",
                                        "--anchors", "13:00", "--ranges", "60", "--targets", "1.5", "--min-ranges", "0.1"])
                self.assertEqual(rc, 0, buf.getvalue())
                self.assertTrue("TESTE" in buf.getvalue() or "Nenhuma combinação" in buf.getvalue(), buf.getvalue())
            finally:
                os.environ.pop("TRADER_DIR", None)


class TestResearch(unittest.TestCase):
    def synth(self, days, seed=3, hour_edge_bps=0.0, trend=False, drift=0.0):
        rng = random.Random(seed)
        bars, p = [], 100.0
        start = core.utc_ms("2025-01-01 00:00")
        for i in range(days * 288):
            ts = start + i * IV
            hr = (ts // HOUR_MS) % 24
            d = drift / 288 + (hour_edge_bps / 1e4 / 12 if hr in (21, 22) else 0)
            if trend:
                d += 0.010 / 288 * (1 if (i // 288 // 40) % 2 == 0 else -1)
            o = p
            c = o * (1 + d + rng.gauss(0, 0.0015))
            bars.append({"t": ts, "o": o, "h": max(o, c) * 1.0003, "l": min(o, c) * 0.9997, "c": c, "v": 1.0})
            p = c
        return bars

    def test_hourly_and_daily_aggregation(self):
        bars = self.synth(3)
        hourly = research.to_hourly(bars)
        daily = research.to_daily(bars)
        self.assertEqual(len(hourly), 72)
        self.assertEqual(len(daily), 3)
        self.assertEqual(hourly[0]["o"], bars[0]["o"])
        self.assertEqual(hourly[0]["c"], bars[11]["c"])
        self.assertEqual(daily[1]["h"], max(b["h"] for b in bars[288:576]))

    def test_hour_profile_detects_planted_edge(self):
        bars = self.synth(300, hour_edge_bps=25.0)
        rows = research.hour_profile(research.to_hourly(bars))
        sig = {h for h, n, m, se, t in rows if t is not None and t > 2}
        self.assertTrue({21, 22} <= sig, sig)
        flat = research.hour_profile(research.to_hourly(self.synth(300, seed=9)))
        nsig = sum(1 for h, n, m, se, t in flat if t is not None and abs(t) > 2)
        self.assertLessEqual(nsig, 3)   # ruído: no máximo umas poucas horas por acaso

    def test_season_costs_eat_small_edge(self):
        bars = self.synth(300, hour_edge_bps=8.0)
        hourly = research.to_hourly(bars)
        net = research.season_returns(hourly, 21, 23, CFG)
        gross = research.season_returns(hourly, 21, 23, dict(CFG, fee_pct=0, slippage_pct=0))
        self.assertEqual(len(net), len(gross))
        self.assertGreater(sum(gross), 0)
        self.assertLess(sum(net), 0)
        self.assertAlmostEqual(sum(gross) - sum(net), len(net) * 0.003, places=6)

    def test_donchian_catches_trend_and_pays_costs(self):
        bars = self.synth(400, trend=True)
        daily = research.to_daily(bars)
        rets = research.donchian_returns(daily, 20, CFG)
        s = research.summarize(rets, 365)
        self.assertGreater(s["total"], 0)
        self.assertGreater(s["total"], research.summarize(research.buy_hold(daily), 365)["total"])
        c_side = (CFG["fee_pct"] + CFG["slippage_pct"]) / 100
        entries = sum(1 for i in range(1, len(rets)) if rets[i] != 0 and rets[i - 1] == 0)
        self.assertGreater(entries, 2)
        # sem tendência e sem drift: as taxas pesam e o resultado não é melhor que ficar fora
        flat = research.donchian_returns(research.to_daily(self.synth(400, seed=11)), 20, CFG)
        self.assertLess(research.summarize(flat, 365)["total"], 20)

    def test_summarize_metrics(self):
        s = research.summarize([0.01] * 365, 365)
        self.assertAlmostEqual(s["cagr"], (1.01 ** 365 - 1) * 100, places=0)
        self.assertEqual(s["max_dd"], 0.0)
        s2 = research.summarize([0.1, -0.5, 0.1], 365)
        self.assertAlmostEqual(s2["max_dd"], -50.0)
        self.assertEqual(research.summarize([], 365)["n"], 0)

    def test_walk_forward_uses_only_past(self):
        series = {5: [0.01] * 40 + [-0.02] * 40, 7: [-0.01] * 40 + [0.02] * 40}
        oos, chosen = research.walk_forward(lambda p: series[p["k"]], [{"k": 5}, {"k": 7}], n_blocks=4)
        # bloco 1 e 2: escolhe k=5 (melhor no passado) e sofre; bloco 3: já viu k=7 ganhar e troca
        self.assertEqual([c["k"] for c in chosen], [5, 5, 7])
        self.assertEqual(len(oos), 60)

    def test_cli_all_offline(self):
        with tempfile.TemporaryDirectory() as d:
            fx = os.path.join(d, "bars.json")
            json.dump(self.synth(120, trend=True), open(fx, "w"))
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = research.main(["all", "FAKE", "--fixture", fx, "--now", "2025-05-01 00:00", "--lookbacks", "10,20"])
            self.assertEqual(rc, 0, buf.getvalue())
            self.assertIn("Resumo", buf.getvalue())
            self.assertIn("walk-forward", buf.getvalue())


def daily_bars(closes, start=None, spread=0.01, vol=1.0):
    start = core.utc_ms("2026-01-05 00:00") if start is None else start   # uma segunda-feira
    return [{"t": start + i * lab.DAY, "o": c, "h": c * (1 + spread), "l": c * (1 - spread), "c": c, "v": vol}
            for i, c in enumerate(closes)]


class TestLab(unittest.TestCase):
    """A régua do laboratório: custo, posições, indicadores, regras, walk-forward e detector de sorte."""

    def test_cost_model_is_a_factor_per_side(self):
        s = {"G": [1.1, 1.0, 1.0], "T": [1, 1, 0], "E": [1, 0, 0], "X": [1, 1, 0]}
        r = lab.net_returns(s, 0.001)
        self.assertAlmostEqual(r[0], 1.1 * 0.999 - 1)
        self.assertAlmostEqual(r[1], 0.999 - 1)
        self.assertEqual(r[2], 0.0)
        self.assertAlmostEqual(lab.net_returns(s, 0.0)[0], 0.1)

    def test_from_positions_charges_turnover_and_compounds(self):
        bars = daily_bars([100 + i for i in range(11)])
        d0 = bars[0]["t"] // lab.DAY
        s = lab.from_positions(bars, [1.0] * 11, d0, 11)
        g = 1.0
        for x in s["G"]:
            g *= x
        self.assertAlmostEqual(g, 110 / 100)
        self.assertEqual(sum(s["T"]), 1)          # só a entrada
        self.assertEqual(sum(s["E"]), 1)
        flip = lab.from_positions(bars, [1.0, 0.0] * 5 + [1.0], d0, 11)
        self.assertEqual(sum(flip["T"]), 11)      # entra, sai, entra...: um lado a cada barra

    def test_indicators(self):
        self.assertEqual(lab.sma([1, 2, 3, 4], 2), [None, 1.5, 2.5, 3.5])
        e = lab.ema([1, 2, 3, 4, 5], 3)
        self.assertEqual(e[:2], [None, None])
        self.assertAlmostEqual(e[2], 2.0)              # semente = média simples
        self.assertAlmostEqual(e[3], 0.5 * 4 + 0.5 * 2.0)
        self.assertEqual(lab.rsi(list(range(1, 30)), 14)[-1], 100.0)
        alt = [100 + (i % 2) for i in range(40)]
        self.assertAlmostEqual(lab.rsi(alt, 14)[-1], 50.0, delta=5)
        bars = daily_bars([100] * 20, spread=0.01)
        self.assertAlmostEqual(lab.atr(bars, 10)[-1], 2.0, places=6)

    def test_trend_rules_follow_the_trend(self):
        down_up = daily_bars([100 - i for i in range(30)] + [70 + 2 * i for i in range(40)])
        for pos in (lab.pos_ma_cross(down_up, 9, 21, "ema"), lab.pos_macd(down_up), lab.pos_supertrend(down_up, 10, 3)):
            self.assertEqual(pos[25], 0.0)          # caindo: fora
            self.assertEqual(pos[-1], 1.0)          # subindo há semanas: dentro
        self.assertEqual(lab.pos_trend_filter(down_up, 20)[-1], 1.0)
        self.assertEqual(lab.pos_trend_filter(down_up, 20)[28], 0.0)
        self.assertEqual(lab.pos_donchian(down_up, 10)[-1], 1.0)
        up = daily_bars([100 * 1.01 ** i for i in range(120)])
        self.assertEqual(lab.pos_ichimoku(up)[-1], 1.0)
        self.assertEqual(lab.pos_ichimoku(daily_bars([100 * 0.99 ** i for i in range(120)]))[-1], 0.0)

    def test_mean_reversion_rules_buy_the_dip_and_sell_the_bounce(self):
        bars = daily_bars([100] * 20 + [100 - 3 * i for i in range(1, 11)] + [70 + 4 * i for i in range(1, 21)])
        r = lab.pos_rsi(bars)
        self.assertEqual(r[19], 0.0)
        self.assertEqual(r[29], 1.0)                # despencou: RSI abaixo de 30 compra
        self.assertEqual(r[-1], 0.0)                # subiu sem parar: RSI acima de 70 vende
        noisy = [100 + (1 if i % 2 else -1) for i in range(30)] + [90] + [100] * 5
        b = lab.pos_bollinger(daily_bars(noisy))
        self.assertEqual(b[29], 0.0)
        self.assertEqual(b[30], 1.0)                # fechou abaixo da banda de baixo
        self.assertEqual(b[-1], 0.0)                # voltou acima da média

    def test_calendar_rules(self):
        week = daily_bars([100] * 14)               # começa numa segunda
        self.assertEqual([lab.weekday(b["t"]) for b in week[:7]], [0, 1, 2, 3, 4, 5, 6])
        self.assertEqual(lab.pos_weekend(week)[:7], [0, 0, 0, 0, 1, 1, 0])   # decide sexta e sábado
        bars = daily_bars([100 + i for i in range(30)])
        mom = lab.pos_ts_momentum(bars, 5)
        changes = [i for i in range(1, 30) if mom[i] != mom[i - 1]]
        self.assertTrue(changes)
        self.assertTrue(all(lab.weekday(bars[i]["t"]) == 6 for i in changes))
        hourly = [{"t": core.utc_ms("2026-01-05 00:00") + h * lab.HOUR, "o": 1, "h": 1, "l": 1, "c": 1, "v": 1} for h in range(48)]
        pos = lab.pos_season(hourly)
        held = [hourly[i + 1]["t"] // lab.HOUR % 24 for i in range(len(hourly) - 1) if pos[i]]
        self.assertEqual(sorted(set(held)), [21, 22])

    def test_grid_profits_from_oscillation_and_needs_price_to_cross(self):
        start = core.utc_ms("2026-03-01 00:00")
        d0 = start // lab.DAY
        lv = [90 * (110 / 90) ** (j / 10) for j in range(11)]
        bars = [{"t": start, "o": 100, "h": 100.1, "l": 99.9, "c": 100, "v": 1}]
        for i in range(1, 200):                     # oscila entre 96 e 104, cruzando degraus
            up = i % 2 == 0
            bars.append({"t": start + i * lab.HOUR, "o": 100, "h": 104 if up else 100.5, "l": 99.5 if up else 96, "c": 100, "v": 1})
        s = lab.grid_series(bars, d0, 10, 10)
        g = 1.0
        for x in s["G"]:
            g *= x
        self.assertGreater(g, 1.0)                  # cada ida e volta rende um degrau
        self.assertGreater(sum(s["E"]), 10)
        below = max(x for x in lv if x < 100)
        touch = [{"t": start, "o": 100, "h": 100, "l": 100, "c": 100, "v": 1},
                 {"t": start + lab.HOUR, "o": 100, "h": 100, "l": below, "c": 100, "v": 1}]
        self.assertEqual(sum(lab.grid_series(touch, d0, 2, 10)["E"]), 0)   # encostar no degrau não executa

    def test_orb_series_uses_the_project_rule(self):
        bars = session_with_breakout(S)
        d0 = S // lab.DAY
        s = lab.orb_series(bars, d0, 1, CFG, "or-mid", 1.5)
        self.assertEqual((s["T"][0], s["E"][0]), (2, 1))
        self.assertAlmostEqual(s["G"][0], 100 / 101.5)   # sem alvo nem stop: zera no fechamento

    def test_dual_thrust_enters_at_trigger_and_exits_at_close(self):
        start = core.utc_ms("2026-01-05 00:00")
        daily = daily_bars([100, 100, 100, 100, 100], start=start, spread=0.01)   # faixa = max(101-100, 100-99) = 1
        day = start + 4 * lab.DAY
        m5 = [{"t": day + i * IV, "o": 100, "h": 100.2, "l": 99.9, "c": 100, "v": 1} for i in range(288)]
        m5[100] = dict(m5[100], h=101.5, c=101.2)
        m5[-1] = dict(m5[-1], c=102.0)
        s = lab.dual_thrust_series(m5, daily, start // lab.DAY, 5, n=4, k=0.5)
        self.assertAlmostEqual(s["G"][4], 102.0 / 100.5)   # gatilho = abertura 100 + 0,5 x 1
        self.assertEqual((s["T"][4], s["E"][4]), (2, 1))

    def test_rotation_buys_what_rose(self):
        n = 80
        uni = {"UPUSDT": daily_bars([100 * 1.01 ** i for i in range(n)]),
               "DOWNXUSDT": daily_bars([100 * 0.99 ** i for i in range(n)]),
               "FLATUSDT": daily_bars([100.0] * n)}
        d0 = uni["UPUSDT"][0]["t"] // lab.DAY
        s = lab.rotation_series(uni, d0, n, 7)
        self.assertGreater(max(s["X"]), 0.19)            # 1 de 5 vagas: 20% investido
        self.assertLessEqual(max(s["X"]), 0.2 * 1.01 ** 7 + 1e-6)   # só a que subiu: 20%, crescendo na semana
        g = 1.0
        for x in s["G"]:
            g *= x
        self.assertGreater(g, 1.0)

    def test_blocks_cover_the_window_without_gaps(self):
        _, ev, end = lab.window(core.utc_ms("2026-11-01 00:00"))
        bl = lab.blocks_for(ev, end)
        self.assertEqual(len(bl), 12)
        self.assertEqual(bl[0][0], 0)
        self.assertEqual(bl[-1][1], end // lab.DAY - ev // lab.DAY)
        self.assertTrue(all(bl[i][1] == bl[i + 1][0] for i in range(len(bl) - 1)))
        self.assertEqual(lab.ymd(ev), "2023-11-01")

    def test_walk_forward_picks_by_the_past_only(self):
        n = 40
        a = {"G": [1.01] * 20 + [0.99] * 20, "T": [0] * n, "E": [0] * n, "X": [1] * n}
        b = {"G": [0.995] * 20 + [1.02] * 20, "T": [0] * n, "E": [0] * n, "X": [1] * n}
        for s in (a, b):                                   # um pouco de ruído para o Sharpe existir
            s["G"] = [g * (1 + (0.001 if i % 2 else -0.001)) for i, g in enumerate(s["G"])]
        oos, _, _, chosen = lab.walk_forward([a, b], 0.0, [(0, 10), (10, 20), (20, 30), (30, 40)])
        self.assertEqual(chosen[:2], [0, 0])               # até o dia 20, a era a melhor
        self.assertEqual(len(oos), 30)                     # o primeiro bloco só treina

    def test_deflated_sharpe_punishes_many_trials(self):
        one = lab.deflated_sharpe(0.1, 1000, 0.0, 3.0, 1, 0.0)
        self.assertAlmostEqual(one, lab.ND.cdf(0.1 * math.sqrt(999) / math.sqrt(1 + 2 / 4 * 0.01)))
        few = lab.deflated_sharpe(0.1, 1000, 0.0, 3.0, 5, 0.001)
        many = lab.deflated_sharpe(0.1, 1000, 0.0, 3.0, 100, 0.001)
        self.assertGreater(one, few)
        self.assertGreater(few, many)
        self.assertIsNone(lab.deflated_sharpe(None, 1000, 0, 3, 5, 0.001))

    def test_pbo(self):
        rng = random.Random(3)
        good = [0.002 + rng.gauss(0, 0.001) for _ in range(400)]
        bad = [-0.002 + rng.gauss(0, 0.001) for _ in range(400)]
        self.assertEqual(lab.pbo_cscv([good, bad]), 0.0)   # a campeã do treino é sempre a melhor no teste
        flip_a = [(0.01 if (i // 50) % 2 == 0 else -0.01) + rng.gauss(0, 0.001) for i in range(400)]
        flip_b = [-x for x in flip_a]
        self.assertGreater(lab.pbo_cscv([flip_a, flip_b]), 0.4)
        self.assertIsNone(lab.pbo_cscv([good]))

    def test_breakeven_matches_closed_form(self):
        n = 30
        s = {"G": [1.0] * n, "T": [0.0] * n, "E": [0] * n, "X": [0.0] * n}
        s["G"][15], s["T"][15] = 1.01, 2.0
        be = lab.breakeven([s], [(0, 10), (10, 20), (20, 30)])
        self.assertAlmostEqual(be, (1 - 1.01 ** (-1 / 2)) * 100, places=3)
        s["G"][15] = 0.99
        self.assertIsNone(lab.breakeven([s], [(0, 10), (10, 20), (20, 30)]))

    def test_buy_hold_and_dca_baselines(self):
        bars = daily_bars([100.0] * 10 + [110.0] * 10)
        d0 = bars[0]["t"] // lab.DAY
        r = lab.buy_hold_oos(bars, d0, 20, 5, 0.001)
        eq = 1.0
        for x in r:
            eq *= 1 + x
        self.assertAlmostEqual(eq, 1.1 * 0.999)
        self.assertGreater(lab.dca_oos(bars, d0, 20, 0, 0.0), 0)

    def test_catalog_counts_every_variant(self):
        self.assertEqual(lab.n_trials(), sum(len(s["variants"]) for s in lab.STRATEGIES) + 2)
        self.assertEqual(len({s["key"] for s in lab.STRATEGIES} | {lab.ROTATION["key"]}), len(lab.STRATEGIES) + 1)
        self.assertEqual(lab.COSTS[0], 0.0)
        self.assertEqual(lab.COSTS[-1], 0.2)
        self.assertIn(lab.DEFAULT_COST, lab.COSTS)


HOUR_MS = 3600000


if __name__ == "__main__":
    unittest.main()
