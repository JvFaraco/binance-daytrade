# Prompt: laboratório de estratégias e "Cemitério de estratégias"

> Cole na sessão: **"Leia docs/PROMPT-laboratorio.md inteiro e execute. Antes de codar, me mostre o plano por fases,
> a lista final de estratégias com os parâmetros e a grade declarada, e espere meu ok."**

## Contexto

Leia `README.md`, `SKILL.md`, `scripts/research.py`, `scripts/backtest.py`, `scripts/timemachine.py`,
`scripts/history.py`, `tests/test_all.py` e `web/README.md` antes de qualquer coisa.

A conclusão do projeto hoje: **o rompimento da faixa inicial não tem vantagem depois das taxas** (0 de 88 combinações
positivas fora da amostra). A literatura concorda: regras técnicas de varejo perdem para comprar e segurar no Bitcoin
fora da amostra, e o que tem evidência melhor (momentum de série temporal no diário, operando pouco) é sensível a custo.

## Objetivo

Transformar o projeto num **laboratório que testa estratégias populares e da literatura na mesma régua** e mostrar o
resultado no site numa aba **"Cemitério de estratégias"**: quais sobrevivem às taxas, quais morrem, e com que taxa cada
uma deixaria de dar lucro.

O valor do projeto é ser honesto. **Se nenhuma sobreviver, esse é o resultado**, e ele vai assim para o site e para o PR.

## Regras que não se negociam

1. **Só pesquisa e análise.** Não mexa no envio de ordens (`broker.py`) nem nas travas do `risk.py`. Nada de operação
   vendida, futuros, margem ou alavancagem: o projeto é spot, só comprado.
2. **Parâmetros declarados antes de rodar.** Cada estratégia entra com os valores populares (os que cursos, corretoras e
   o TradingView usam) e, no máximo, uma grade pequena declarada no código antes do teste. Proibido ajustar até dar positivo.
3. **Todas as variações testadas contam** no detector de sorte (Sharpe deflacionado). Esconder variação ruim é trapaça.
4. **Só biblioteca padrão no Python**, como o resto dos scripts. Dados de `data.binance.vision` via `history.py`.
5. **Paridade com o TypeScript**: tudo que for para o site é portado para `web/src/engine/` com testes de paridade contra
   o Python, como o resto do painel. `python -m unittest discover -s tests` e a bateria do `web/` continuam passando.

## A régua única (um módulo novo em `scripts/`, com testes)

- **Custo por lado configurável**: 0,10% (padrão da Binance) e 0,075% (pagando taxa em BNB), mais slippage.
- **Ordem limite (maker)** só conta como executada se o preço **passar** do limite. Candles não mostram a fila do livro
  de ofertas, então a premissa tem de ser pessimista.
- **5 pares**: BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT. **24 a 36 meses** de candles via `history.py`.
- **Walk-forward em blocos**: escolher parâmetro no passado, medir no futuro, em blocos sucessivos.
- Para cada estratégia e par: retorno líquido e bruto, máximo drawdown, número de operações, tempo exposto, e a comparação
  com **comprar e segurar** e com **DCA semanal** no mesmo trecho.
- **Custo de equilíbrio**: a taxa por lado em que o lucro líquido zera. É o número que diz "esta só funciona se a taxa
  for menor que X%".
- **Detector de sorte**: Sharpe deflacionado (Bailey & López de Prado, 2014) contando todas as variações testadas, e a
  probabilidade de overfitting por validação cruzada combinatória (CSCV) quando houver grade.

**Critério de "viva"**: bate comprar e segurar **fora da amostra**, **depois das taxas**, com Sharpe deflacionado
significativo, em pelo menos 3 dos 5 pares. O resto é "morta", com o motivo.

## Estratégias

Parâmetros populares entre parênteses. Todas só compradas.

**Populares de varejo** (cursos, corretoras, TradingView):

1. Cruzamento de médias: 9/21 no gráfico de 1h e 50/200 no diário ("golden cross").
2. RSI (14, compra abaixo de 30, sai acima de 70).
3. MACD (12/26/9, cruzamento da linha de sinal).
4. Bandas de Bollinger (20, 2 desvios, volta à média).
5. SuperTrend (10, 3).
6. Ichimoku (9/26/52; compra com preço acima da nuvem e Tenkan acima de Kijun).
7. **Grid da Binance**: compra e venda em degraus numa faixa, como o robô Spot Grid da corretora. Faixa e número de
   degraus declarados antes (por exemplo, faixa de ±10% em torno do preço de início, 10 e 20 degraus), reiniciada
   mensalmente. É o robô mais usado da própria corretora.

**Com base na literatura:**

8. Momentum de série temporal: comprado se o retorno dos últimos 20, 60 ou 120 dias for positivo, revisão semanal.
9. Comprar e segurar com filtro de tendência: comprado só com o preço acima da média de 100 ou 200 dias.
10. Rotação semanal entre as 20 maiores moedas por momentum, com custo de troca (Zarattini, Pagani & Barbon).
11. Dual Thrust long only (rompimento intraday da QuantConnect), para comparar com o rompimento do projeto.
12. Efeito fim de semana / noturno (evidência fraca; entra para ser testado, não para ser vendido).

**Já existentes, que viram referência:** o rompimento da faixa inicial, a sazonalidade 21–23 UTC e o Donchian do
`research.py`.

**Réguas finais (não são candidatas, são o que bater):** comprar e segurar, e DCA semanal (comprar um valor fixo toda
semana), que é o que as corretoras recomendam para leigos.

## Time Machine em blocos

Acrescente ao `timemachine.py` a opção de **bootstrap estacionário** (Politis & Romano, 1994): sortear trechos de dias
inteiros, com comprimento geométrico, do **preço**, e aplicar a regra depois (não embaralhar os resultados dos trades).
Mantenha o modo atual e mostre os dois lado a lado, com a diferença explicada em uma frase. Documente a escolha do
comprimento médio do bloco.

## Site: aba "Cemitério de estratégias"

Mesmo design system do painel (tokens, componentes base, estados de carregando, erro e vazio, Lite e Pro).

- **Uma linha por estratégia**: "viva" ou "morta" (com o motivo), retorno líquido contra comprar e segurar, drawdown,
  número de operações e **custo de equilíbrio**.
- O **controle de taxa existente move todas juntas**: arrastar de 0 a 0,2% por lado mostra as estratégias morrendo uma
  a uma. É o momento principal da aba.
- No **Lite**, uma frase e um número: "X de N estratégias populares sobrevivem às taxas".
- Cálculos pesados no Web Worker. Resultado da pesquisa de 24–36 meses pode ser pré-calculado no build (JSON gerado
  pelo Python, com data e versão do motor) se for pesado demais para o navegador; diga isso na tela.
- Conferir com Playwright em 1440 px e 390 px, olhar as imagens e corrigir antes de terminar.

## Entrega

- Branch nova a partir de `main`, commits pequenos, **PR contra `main` sem merge**.
- `README.md`: seção curta com o resultado do cemitério e o link da aba.
- No PR: o que foi verificado, o que não foi, e o resultado honesto, inclusive se nenhuma sobreviver.
- Commits terminando com `Co-Authored-By: Claude <noreply@anthropic.com>`.

## Ordem de trabalho

1. Ler o repositório e me mostrar: plano por fases, lista final de estratégias com parâmetros e grade, e o critério de
   "viva". Esperar meu ok.
2. Régua única e detector de sorte, com testes.
3. Estratégias, uma por commit, com teste de que a regra faz o que diz num caso sintético.
4. Rodar a pesquisa e salvar o resultado.
5. Time Machine em blocos.
6. Aba no site, paridade e screenshots.

Ao fim de cada fase: commit, push e um resumo curto. Se o limite de uso estiver acabando, priorize deixar a fase atual
commitada e com push.

## Fontes

- Regras técnicas em cripto depois dos custos: [Annals of Operations Research](https://link.springer.com/article/10.1007/s10479-019-03357-1),
  [Technical trading and cryptocurrencies (Reading)](https://centaur.reading.ac.uk/85715)
- Momentum: [Han, Kang & Ryu](https://acfr.aut.ac.nz/__data/assets/pdf_file/0009/918729/Time_Series_and_Cross_Sectional_Momentum_in_the_Cryptocurrency_Market_with_IA.pdf),
  [Catching Crypto Trends](https://abarbon.com/papers/catching-crypto-trends),
  [Grayscale](https://research.grayscale.com/reports/the-trend-is-your-friend-managing-bitcoins-volatility-with-momentum-signals)
- Overfitting: [Deflated Sharpe Ratio](https://papers.ssrn.com/abstract=2460551),
  [Probability of Backtest Overfitting](https://papers.ssrn.com/abstract=2326253)
- Bootstrap: [The stationary bootstrap (Politis & Romano)](https://gnosis.library.ucy.ac.cy/handle/7/57533)
- Execução por candles e fila: [NautilusTrader, fill models](https://nautilustrader.io/docs/latest/concepts/backtesting/fill-models/)
- Calendário: [Quantpedia, efeitos de calendário no Bitcoin](https://quantpedia.com/are-there-any-simple-calendar-effects-in-bitcoin-market/)
- Bancos de estratégias: [Quantpedia](https://quantpedia.com/), [QuantConnect Strategy Library](https://www.quantconnect.com/docs/v2/writing-algorithms/strategy-library.md),
  [awesome-systematic-trading](https://github.com/paperswithbacktest/awesome-systematic-trading),
  [TradingView, scripts de estratégia](https://my.tradingview.com/scripts/strategy)
- Taxas: [Binance, suporte](https://www.binance.com/pt/support/articles/360033544231)
