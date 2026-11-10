---
name: binance-daytrade
description: >-
  Day trade spot na Binance, com testnet por padrão. Escaneia os pares USDT mais
  líquidos atrás de rompimento da faixa inicial da sessão, monta o plano
  (entrada, stop, alvo), roda o Time Machine (10.000 replays + histórico real,
  já com taxas), faz backtest com treino e teste separados em meses de dados,
  dimensiona a posição pelo prejuízo máximo, confere seus limites e só então
  envia a ordem (compra + alvo + stop numa lista OTOCO), depois do seu sim. Use
  quando o usuário falar em day trade cripto, Binance, "scanner", "rompimento",
  "montar o plano", "quais são as odds", "backtest", "quanto comprar", "enviar a
  ordem", "zerar a posição", "testnet".
---

# binance-daytrade

Day trade **spot, só comprado**, em pares USDT da Binance. Nada de futuros,
alavancagem ou margem. `${CLAUDE_SKILL_DIR}` é a pasta deste SKILL.md.

Tudo grava em `trader/` na pasta do projeto (`trader/config.json` é opcional;
modelo em `config.example.json`). Cada etapa lê o que a anterior escreveu:

```
scan -> plan -> timemachine -> size -> risk -> broker
backtest (de vez em quando, antes de confiar na regra)
```

```bash
S="${CLAUDE_SKILL_DIR}/scripts"
python3 "$S/scan.py" orb                                # rompimentos agora (--verbose mostra tempos)
python3 "$S/plan.py" check BTCUSDT                      # esperando / rompeu / expirou
python3 "$S/plan.py" plan BTCUSDT --target 1.5R --write
python3 "$S/timemachine.py" run --write                 # --months 12 usa o histórico do history.py
python3 "$S/size.py" --write
python3 "$S/risk.py"
python3 "$S/broker.py" check                            # só leitura: chaves, relógio, saldo, comissão
python3 "$S/broker.py" show
python3 "$S/history.py" fetch BTCUSDT --months 12       # zips mensais públicos da Binance
python3 "$S/backtest.py" run BTCUSDT --months 12        # varredura com treino/teste
python3 "$S/research.py" all BTCUSDT,SOLUSDT,ETHUSDT --months 12   # hipóteses da literatura, walk-forward
python3 "$S/lab.py" fetch && python3 "$S/lab.py" run   # cemitério: 15 estratégias, 5 pares, 36 meses, 41 custos
python3 "$S/lab.py" show                                # resumo do último resultado
```

## O que os dados mostraram (BTC e SOL, nov/2025 a out/2026)

O rompimento da faixa inicial **não tem vantagem depois das taxas**: 192 combinações
testadas, zero positivas com 10+ trades fora da amostra. Não é bug, é o sinal: cripto
não tem "abertura", e um stop de 0,3% não paga 0,3% de custo. Diga isso ao usuário
antes de qualquer trade e não tente "ajustar parâmetros até dar positivo".

O `research.py` testa o que a literatura aponta como possível em cripto: efeito de
horário (21–23 UTC), e trend-following diário (Donchian) com poucas operações. Mostra
sempre bruto vs líquido, walk-forward e a comparação com comprar-e-segurar no mesmo
trecho. Se o usuário perguntar "o que faz dinheiro", a resposta é: rode isso em 3 pares
e 24+ meses, e só leve a sério o que ganhar de comprar-e-segurar no walk-forward.

O `lab.py` fez exatamente isso com as estratégias populares (médias, RSI, MACD, Bollinger,
SuperTrend, Ichimoku, o robô Grid da Binance) e as da literatura (momentum, filtro de
tendência, rotação, Dual Thrust, fim de semana), mais as do projeto: BTC, ETH, SOL, BNB e
XRP, nov/2023 a out/2026, walk-forward, Sharpe deflacionado contando as 33 variações.
**Nenhuma sobrevive, em nenhum custo.** Ichimoku e Donchian ganham do comprar e segurar em
4 e 3 dos 5 pares, mas não passam da barra da sorte (Sharpe ~1,27). Quando o usuário trouxer
"a estratégia do curso" ou "o robô da corretora", mostre o `lab.py show` antes de qualquer
trade, e diga que o período foi de alta forte para BTC, BNB e XRP.

## A estratégia

Sessão = começa em `anchor_utc` (padrão 13:00 UTC, 10:00 de Brasília). A **faixa
inicial** é a primeira hora (`range_minutes`). O sinal é o primeiro candle de 5m
que **fecha acima do topo da faixa**, dentro de `entry_window_minutes` (4h).
Stop no meio da faixa (`or-mid`) ou no fundo (`or-low`); alvo em múltiplos de R;
zerar até `flat_by_hours` (8h) depois do início. Cripto roda 24h, então a
"âncora" é uma escolha sua, não um horário de pregão. O `backtest.py` é o jeito
de testar âncoras e parâmetros antes de confiar neles.

## Passos

1. **Scanner.** `scan.py orb`. Só mostra rompimentos com faixa >= 1% e que não
   subiram mais de 1% acima do topo (faixa menor não paga as taxas). Mostra os
   descartados e o motivo. Se não houver nada, diga isso e pare; não force um trade.
2. **Plano.** `plan.py check SYMBOL`, depois `plan.py plan SYMBOL --write`.
   Alvo de 1R não passa no retorno/risco depois das taxas; comece em 1.5R.
3. **Time Machine.** `timemachine.py run --write`. Conte ao usuário, nesta ordem:
   as três odds, o R médio líquido, o histórico real, o veredito e a seed. Se o
   R médio líquido for negativo ou o veredito pender para o stop, diga isso com
   clareza e **não empurre o trade**. Menos de 30 disparos no histórico: repita o
   aviso de amostra pequena. Com `--months 12` o histórico fica bem maior.
4. **Tamanho.** `size.py --write` busca as regras do par (`exchangeInfo`) e o
   preço médio (`avgPrice`). Aplica tick, passo, valor mínimo e máximo,
   `PERCENT_PRICE_BY_SIDE`. Mostre a perda máxima e o ganho no alvo, com taxas.
   A quantidade de venda sai um pouco menor que a de compra porque a Binance
   cobra a taxa da compra na moeda comprada (a menos que `fee_in_bnb` seja true).
5. **Risco.** `risk.py`. BLOCK = para aqui e explica o motivo. AVISO não bloqueia,
   mas tem que ser dito ao usuário (inclusive "time machine não rodou").
6. **Corretora.** Antes da primeira ordem do dia, `broker.py check` (confere chave,
   relógio, saldo e a comissão real; se a comissão não bater com `fee_pct`, peça
   pra ajustar o config). Depois `broker.py show` e mostre o ticket em palavras
   comuns, inclusive que stop é plano e não garantia. Pergunte ao usuário. **Só**
   depois de um sim dele para esta ordem: `broker.py approve --reply "<as palavras
   dele>"`, depois `broker.py send entry`.
   - **Modo OTOCO (padrão):** uma lista só. Compra LIMIT **FOK** (tudo ou nada);
     se executar, alvo (`LIMIT_MAKER`) e stop (`STOP_LOSS_LIMIT`) nascem juntos
     como par OCO. Não existe momento em que a posição está sem stop. Se o FOK não
     executar, nada foi comprado. Confira com `broker.py status`.
   - **Modo two-step** (`entry_mode` no config, ou par sem `otoAllowed`): compra
     IOC, e **logo em seguida** `broker.py send exit` coloca o OCO. Se o OCO
     falhar, avise em destaque que a posição está sem stop e ofereça `flatten`.
7. **Zerar.** Perto do `flat_by`, lembre o usuário de `broker.py flatten` (ele
   também precisa dizer sim). Cancela só a lista alvo/stop desta ordem
   (`DELETE /api/v3/orderList`) e vende a mercado.

## Regras que não se negociam

- Nunca invente o "sim". O `--reply` é exatamente o que o usuário escreveu no
  chat, e ele precisa citar o par ("sim BTCUSDT"). Sem sim, sem ordem.
- Nunca use `--dry-run` como desculpa pra pular a pergunta; ele só mostra a ordem.
- Modo real exige `"paper": false` no config **e** `BN_LIVE=1` no ambiente. Não
  mude nenhum dos dois por conta própria. Chaves ficam em variáveis de ambiente
  (`BINANCE_TESTNET_API_KEY/SECRET`, ou `BINANCE_API_KEY/SECRET` no real), nunca
  no chat nem em arquivo.
- Nada aqui roda sozinho: ninguém zera a posição no horário. Se o usuário quiser
  automatizar, a saída é uma tarefa agendada, e mesmo assim com o sim dele.
- Peso de API: cada pedido conta contra 6000/min por IP. O código avisa a 70% e
  para em 418 (banimento). Não rode o scanner em loop apertado.
- O fluxo OTOCO (compra FOK + alvo + stop), `status` e `flatten` já rodaram com sucesso na
  testnet. O modo two-step e a conta real, não. Teste de tubulação: `plan.py testplan` +
  `risk.py --force`, os dois só em paper, e diga sempre ao usuário que não é um setup.
- A testnet é apagada periodicamente (saldo volta, ordens somem). Se
  `broker.py status` não achar a lista, foi isso. Preços da testnet podem
  diferir dos reais; compras FOK/IOC podem não executar lá por isso.
- Day trade perde dinheiro na maioria dos casos. Isto não é recomendação.

## Regras de pesquisa (valem pra qualquer nova ideia)

- Toda hipótese passa primeiro no `backtest.py`/`research.py` com custo e walk-forward.
  Só depois vira código de execução.
- Um par e um ano não provam nada. Mínimo: 3 pares, 24 meses, e o fora-da-amostra positivo.
- Desconfie de qualquer coisa que só funcione num lookback ou num horário específico.
- Nunca escolha parâmetros olhando o período de teste.

## O que ainda não existe

Notícias/anúncios da Binance, alertas de preço e acompanhamento contínuo da
posição (o par OCO cuida do stop e do alvo na própria corretora; `status` consulta).
