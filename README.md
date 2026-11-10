# binance-daytrade

Day trade spot na Binance feito em skill do Claude: scanner de rompimento, plano,
simulação das odds, backtest com treino e teste, tamanho da posição, checagem de
risco e envio da ordem só depois do seu sim. Testnet por padrão. Python 3.8+, só
biblioteca padrão.

Inspirado na estrutura do `day-trader-skill` do Jake Schincariol (ações, Yahoo/Alpaca),
mas escrito do zero para a Binance. Nenhum código foi copiado.

## Instalar

```powershell
# Windows (PowerShell): extrai em Downloads e aponta $S pros scripts
tar -xzf binance-daytrade.tar.gz
$S = "$env:USERPROFILE\Downloads\binance-daytrade\scripts"
```

```bash
# como skill do Claude Code
cp -r binance-daytrade ~/.claude/skills/
```

Na pasta do projeto: `cp config.example.json trader/config.json` e ajuste capital, perda
máxima por trade, âncora de horário etc.

## Testnet

Crie chaves em https://testnet.binance.vision e exporte:

```powershell
$env:BINANCE_TESTNET_API_KEY = "..."
$env:BINANCE_TESTNET_API_SECRET = "..."
python $S\broker.py check        # só leitura: chave, relógio, saldo, comissão real
```

Dinheiro real só com `"paper": false` no config **e** `BN_LIVE=1` no ambiente.

## Fluxo

```
scan.py orb  ->  plan.py plan  ->  timemachine.py run  ->  size.py  ->  risk.py  ->  broker.py
history.py fetch + backtest.py run      (antes de confiar na regra)
```

A ordem vai como **OTOCO**: compra LIMIT FOK (tudo ou nada) e, se executar, alvo e stop
nascem juntos na Binance como par OCO. Não existe janela em que a posição fica sem stop.
`entry_mode: "two-step"` no config volta ao modo antigo (IOC, depois OCO).

## Resultado da pesquisa (BTC e SOL, 12 meses)

Rompimento de faixa inicial: **nenhuma vantagem depois das taxas** (0 de 88 combinações
positivas fora da amostra). O `research.py` testa o que a literatura indica como viável em
cripto, com custo e walk-forward:

```powershell
python $S\research.py all BTCUSDT,SOLUSDT,ETHUSDT --months 12
```

Referências: Padysak & Vojtko (2022) sobre seasonality/trend em BTC horário; Concretum (2025)
sobre Donchian em cripto líquido de taxas; arXiv 2606.00060 (2026) sobre walk-forward em BTC
horário, onde só sobrevive quem opera pouco e só com sinal maior que o custo.

## Painel web

`web/` é um painel de **análise** (não envia ordem, não pede chave) que mostra a conclusão acima
com dados públicos e ao vivo da Binance: scanner, preço com a faixa inicial, os 10.000 replays do
Time Machine numa esfera, a grade do backtest em treino × teste e o bruto × líquido das estratégias.
O motor foi portado para TypeScript com testes de paridade contra os scripts Python.

![Painel web](web/docs/painel-desktop.png)

Arrastar o custo de 0 a 0,2% por lado recolore a esfera sem refazer os sorteios:

![Custo zero contra 0,20% por lado](web/docs/custo-0-vs-020.png)

```bash
cd web && npm ci && npm run dev
```

Detalhes, o que foi verificado e limites em [`web/README.md`](web/README.md). O workflow
`.github/workflows/web.yml` testa e publica no GitHub Pages (`/binance-daytrade/`).

## Testes

```bash
python3 -m unittest discover -s tests -v
```

66 testes, offline, com candles sintéticos e uma corretora falsa. Cobrem o sinal, o
dimensionamento e os filtros, os limites de risco, a simulação, o backtest, a leitura
dos zips mensais (com timestamps em microssegundos), a assinatura HMAC (contra o
exemplo da documentação da Binance) e os fluxos OTOCO e two-step do broker.

## O que foi conferido na documentação oficial

Fonte: `binance/binance-spot-api-docs` (rest-api.md, filters.md, faqs) e a página da
testnet. Em particular:

- `POST /api/v3/orderList/otoco`: `workingType=LIMIT`, `workingTimeInForce=FOK`,
  `pendingAboveType=LIMIT_MAKER`, `pendingBelowType=STOP_LOSS_LIMIT` + `pendingBelowTimeInForce`.
- `POST /api/v3/orderList/oco`: `aboveType/abovePrice`, `belowType/belowStopPrice/belowPrice/belowTimeInForce`.
  Restrição de preço na venda: alvo > último preço > stop.
- `DELETE /api/v3/orderList` cancela só a lista (em vez de todas as ordens do par).
- Timestamp mais de 1 s à frente do servidor é rejeitado: o broker sincroniza com `/api/v3/time`.
- Limites por IP: `X-MBX-USED-WEIGHT-1M` (6000/min), 429 com `Retry-After`, 418 = banimento.
  `ticker/24hr` sem símbolo pesa 80; por isso a lista de pares fica em cache.
- Filtros: `PRICE_FILTER`, `LOT_SIZE`, `MARKET_LOT_SIZE`, `NOTIONAL` (mín e máx),
  `PERCENT_PRICE_BY_SIDE`, e a regra de faixa de execução (`executionRules` + `referencePrice`).
- Comissão real: `GET /api/v3/account/commission` (e desconto em BNB). `broker.py check` compara com o config.
- Arquivos mensais em `data.binance.vision` (klines 5m) com timestamp em microssegundos desde 2025.

## O que já rodou contra a Binance (testnet, 2026-11-02)

- `scan.py universe/orb`, `plan.py`, `timemachine.py` (60 dias), `size.py` (exchangeInfo + avgPrice)
  e `risk.py`, com dados reais de mercado.
- `broker.py check` (conta, relógio, comissão), `send entry` em modo OTOCO (compra FOK executada,
  alvo LIMIT_MAKER e stop STOP_LOSS_LIMIT criados juntos), `status` e `flatten`
  (DELETE /api/v3/orderList + venda a mercado). Lista encerrada como ALL_DONE.

## O que ainda NÃO foi verificado

- Alvo ou stop executando sozinhos (depende de o preço chegar lá; é a Binance quem executa).
- O modo `two-step` (IOC + OCO) contra a API real; só na corretora falsa dos testes.
- `history.py fetch` e `backtest.py` com os zips reais de data.binance.vision.
- Conta real. A testnet não cobra taxa e tem liquidez artificial; preços podem diferir dos reais.
- A testnet é apagada periodicamente; `state.json` pode apontar para listas que não existem mais.

## Limites honestos

- O Time Machine sorteia candles de 5m como se fossem independentes: perde a sequência de
  volatilidade e as caudas gordas de cripto. É checagem de sanidade, não previsão.
- O backtest separa treino e teste, mas um par e um ano não provam nada. Repita em outros
  pares e períodos antes de acreditar numa combinação.
- Taxas pesam. Com 0,1% por lado mais slippage, uma faixa de 1% gasta boa parte do risco só
  em custo. O R médio líquido mostra isso; alvo de 1R não passa no retorno/risco.
- O limite diário soma o risco máximo das ordens enviadas, não o resultado realizado.
- Stop-limit não garante saída num gap. A perda máxima mostrada é no preço do stop.

Não é recomendação de investimento. Day trade perde dinheiro para a maioria.
