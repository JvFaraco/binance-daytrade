# Prompt: painel web de análise de mercado

> Cole na sessão: **"Leia docs/PROMPT-painel-web.md inteiro e execute. Antes de codar, me mostre o plano e o design system."**

## Contexto

Este repositório é um skill do Claude para day trade spot na Binance, em Python só com biblioteca
padrão: `scripts/core.py` (sinal, custos, dados), `scan.py` (scanner de rompimento da faixa inicial
nos pares USDT líquidos), `plan.py`, `timemachine.py` (Monte Carlo: 10.000 replays de candles de
5m + histórico real, líquido de taxas), `backtest.py` (grade com treino/teste), `research.py`
(sazonalidade 21–23 UTC, Donchian diário, walk-forward contra comprar-e-segurar), `size.py`,
`risk.py`, `broker.py`. Leia `README.md`, `SKILL.md`, todo `scripts/` e `tests/test_all.py`
antes de qualquer coisa.

A conclusão central do projeto: **rompimento da faixa inicial não tem vantagem depois das taxas**
(0 de 88 combinações positivas fora da amostra). O painel existe para *mostrar isso com dados
reais*, ao vivo, de um jeito que dê vontade de ficar olhando.

## Objetivo

Criar `web/`: uma ferramenta de **análise de mercado de verdade** (não demo, não dado fictício),
publicada no GitHub Pages. Trabalhe na branch `web-dashboard`, commits pequenos e lógicos, push e
abra um PR contra `main` (não faça merge). Texto da interface em português do Brasil.

## Regras que não se negociam

1. **Só análise.** Nunca envia ordem, nunca pede ou guarda chave de API, nunca chama endpoint
   assinado. Não porte `broker.py`. Deixe visível: "somente análise — nenhuma ordem é enviada".
2. **Todo número na tela vem de cálculo real sobre dado real.** Nada de telemetria decorativa,
   métrica inventada ou marca de instituição. Carregando ou indisponível = mostre esse estado.
3. **Dados só de endpoints públicos sem chave**: REST `https://data-api.binance.vision/api/v3/...`
   (klines, ticker/24hr, exchangeInfo, avgPrice) e WebSocket `wss://data-stream.binance.vision/ws/...`
   (reserva: `wss://stream.binance.com:9443`). Confirme CORS. Respeite o peso da API: cache do
   universo de pares como o `core.py` faz, backoff em 429/418, leia `X-MBX-USED-WEIGHT-1M` se exposto.
4. **Motor portado para TypeScript com paridade.** Sinal, custo (taxa + slippage), Time Machine,
   grade do backtest com treino/teste, pesquisa (sazonalidade, Donchian, walk-forward, buy & hold),
   dimensionamento com filtros da exchangeInfo e checagens de risco. Escreva um script Python que
   exporta os candles sintéticos de `tests/test_all.py` e as saídas do Python para JSON, e testes
   Vitest que exigem o mesmo resultado no TS (porte o RNG ou torne os dois determinísticos).
   Não mude o comportamento do Python: `python -m unittest discover -s tests` continua passando.
5. **Trabalho pesado em Web Workers** (10k replays, grade, meses de candles). A UI não pode cair de 60 fps.

## Frontend: é aqui que o projeto se destaca

Referência de clima: painel de "centro de controle" escuro e denso, monoespaçado, dezenas de
painéis finos em volta de uma visualização central enorme e hipnótica. A diferença para as
imagens de inspiração: aqui cada pixel significa algo.

### Design system (defina primeiro, em `web/src/styles/tokens.css`, e me mostre)

- **Cores como tokens** CSS: fundo quase preto azulado (não #000 puro), superfícies em 2–3 níveis,
  bordas de 1px de baixo contraste, texto primário/secundário/terciário. Acentos com função fixa:
  âmbar = sinal/seleção, verde-água = resultado positivo líquido, vermelho = negativo líquido,
  azul frio = dado bruto/neutro. Nunca use cor só como enfeite.
- **Tipografia**: uma mono de qualidade (JetBrains Mono ou IBM Plex Mono via Google Fonts) para
  números e rótulos, com `font-variant-numeric: tabular-nums` em tudo que muda; rótulos em caixa
  alta pequena com letter-spacing; uma escala de 5–6 tamanhos, sem exceções.
- **Grade**: CSS Grid com áreas nomeadas; espaçamento em múltiplos de 4px; cabeçalho de painel
  padronizado (título · subtítulo técnico · estado ao vivo).
- Componentes base reutilizáveis: `Panel`, `Stat`, `Sparkline`, `Meter`, `Badge`, `Tooltip`,
  `LiveDot`, `Skeleton`. Nenhum painel reinventa cabeçalho, borda ou número.

### Movimento (framer-motion + requestAnimationFrame)

- **Coreografia de entrada**: na abertura, os painéis entram em sequência (stagger curto) enquanto
  o motor carrega; cada painel tem skeleton com shimmer até ter dado real.
- **Números vivos**: valores interpolam (tween de 200–400 ms) em vez de pular; a casa que mudou
  pisca de leve na cor do sentido (verde/vermelho) e volta.
- **Causa e efeito visível**: mexer num controle (taxa, âncora, alvo em R) deve fazer a mudança
  atravessar o painel: o pipeline acende, o worker trabalha (mostre o progresso real), a esfera
  e os números mudam juntos.
- Curvas de easing consistentes (definidas uma vez). Respeite `prefers-reduced-motion`.

### Visualização central: a esfera do Time Machine (react-three-fiber)

- Os 10.000 caminhos de capital dos replays, mapeados em coordenadas esféricas (tempo → ângulo,
  resultado → raio/latitude), cada fio colorido pelo resultado **líquido**, com blending aditivo
  para o brilho onde os fios se acumulam.
- Performance: uma única `LineSegments`/`BufferGeometry` (ou instanced), atualizada por buffer
  vindo do worker (transferable), sem recriar geometria a cada frame. Bloom leve via postprocessing.
- Rotação lenta; arrastar gira; passar o mouse destaca um caminho e mostra o R dele.
- **Controle de custo** (0 → 0,2% por lado): ao arrastar, a esfera muda de cor em tempo real,
  de verde para vermelho. Este é o momento "uau" e a tese do projeto em uma interação.
- Ao lado: win rate, R médio líquido, percentis (p5/p50/p95), máx. drawdown.

### Painéis em volta

1. **Preço ao vivo** (WebSocket) do par escolhido, em canvas, com a faixa inicial desenhada
   (âncora e duração configuráveis como no `config.example.json`) e o candle de rompimento marcado.
2. **Scanner ao vivo**: pares USDT líquidos e o estado de cada um (esperando / rompeu / expirou),
   calculado exatamente como `scan.py`; clicar num par seleciona ele no painel inteiro.
3. **Pipeline** `scan → plan → timemachine → size → risk`, cada etapa acendendo quando o cálculo
   real termina, com o tempo gasto. Termina em risk; o broker aparece apagado com "não enviado".
4. **Mapa da grade do backtest**: cada combinação acende enquanto é calculada; alternar treino ×
   teste com transição animada mostrando os "vencedores" do treino morrendo fora da amostra.
   Meses de candles de 5m via klines paginados, com progresso e cache em IndexedDB.
5. **Bruto × líquido** (halteres) por estratégia: rompimento, sazonalidade, Donchian, buy & hold.
6. **Pareto dos sinais rejeitados**, com os motivos que o motor realmente devolve.
7. **Fita de negócios ao vivo** do par e **telemetria real**: peso de API usado, latência do WS,
   candles carregados, tempo do worker, fps.
8. **Cartão do plano**: entrada/stop/alvo/R:R, tamanho da posição para capital e perda máxima
   informados (lógica do `size.py` com filtros da exchangeInfo), checagens do `risk.py`, e um
   diagrama animado de como seria a ordem OTOCO, marcado como **não enviada**.

### Qualidade de frontend exigida

- Responsivo de verdade: desktop denso; tablet com 2 colunas; celular com a esfera no topo e
  painéis empilhados e recolhíveis. Sem scroll horizontal.
- Estados de vazio, carregando, erro e "API limitou" desenhados, não improvisados.
- Acessibilidade: contraste AA no texto, foco visível, controles por teclado, `aria-live` discreto
  para mudanças importantes.
- Performance: code-splitting do three.js, Lighthouse ≥ 90 em performance no desktop, nada de
  re-render da árvore inteira a cada tick do WebSocket (estado por painel, ex.: zustand com seletores).
- **Verifique visualmente**: rode o app com Playwright, tire screenshots em 1440px e 390px, olhe
  as imagens, corrija o que estiver feio ou desalinhado e repita antes de dizer que terminou.

## Stack

React + Vite + TypeScript, react-three-fiber + drei + postprocessing, framer-motion, zustand,
Vitest, ESLint. Versões exatas fixadas no `package.json`.

## Entrega

- GitHub Actions que faz build e publica `web/` no GitHub Pages (`base: "/binance-daytrade/"`).
- `web/README.md` e uma seção "Painel web" no `README.md` da raiz, com screenshots.
- Antes do push: lint, typecheck, vitest, testes Python e build de produção, tudo passando.
- No PR: o que foi verificado, o que não foi, e limitações honestas (ex.: o Time Machine trata
  candles de 5m como independentes; a testnet não é o mercado real).
- Commits terminando com `Co-Authored-By: Claude <noreply@anthropic.com>`.

## Ordem de trabalho

1. Ler o repositório e me mostrar: plano por fases + design system (tokens, tipografia, grade).
2. Motor TS + testes de paridade (sem isso, nada de UI).
3. Casca do layout com componentes base e dados ao vivo do scanner e do preço.
4. Esfera + controle de custo.
5. Demais painéis.
6. Polimento de movimento, responsivo, screenshots, deploy.

Ao fim de cada fase: commit, push e um resumo curto com screenshot.
