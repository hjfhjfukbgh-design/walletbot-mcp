# walletbot-mcp

Bot de **auto trade em grid** para perpétuos no [Walt](https://walletbot.me) via **Walt MCP**
(`https://walletbot.me/bot-relay/public-api/mcp`), controlado pelo Telegram (`@walletbotmcpbot`)
e hospedado 100% serverless em **Cloudflare Workers** (webhook do Telegram + Cron a cada 5 min + KV).

> ⚠️ Perpétuos alavancados podem liquidar a conta. O ambiente de produção começa em **DEMO/PAPER**. A execução LIVE está atualmente bloqueada no bot e na Mini App até a validação independente do ciclo completo de abertura/fechamento, confirmação por ordem e reconciliação. Não use comandos antigos de LIVE como autorização para operar dinheiro real.

## Como funciona

Arquitetura **híbrida**: o **Telegram Serverless** (tgcloud) recebe as mensagens e hospeda a Mini App; o
**Cloudflare Worker** faz o trading (o Serverless não tem cron).

```
Telegram ─▶ tgcloud handlers/message.js ──▶ Worker POST /api/telegram ──▶ comandos (/grid, /run, /status…)
Mini App ─▶ Telegram.WebApp.Serverless.call ─▶ tgcloud endpoints/* ──▶ Worker /api/* (X-Api-Key)
Cron */5 min ─────────▶ Worker scheduled ──▶ preço → grid → travas de risco → ordem virtual (paper); LIVE bloqueado
Walt OAuth ───────────▶ tokens no KV do Worker (refresh automático)
```

Sem o Serverless ligado, o Worker também funciona sozinho com webhook direto (`/telegram`).

- **Estratégia** (`src/strategy/grid.ts`): grid de **posição única**, porque o Walt aceita só uma posição
  por contrato e não deixa aumentar uma posição aberta. A faixa `low`–`high` é dividida em N degraus.
  Quando o preço entra num degrau, o bot abre um long com **take-profit no degrau de cima** e
  **stop-loss em `low − STOP_LOSS_PCT%`**, ambos nativos do Walt (`autoClose`), então a saída acontece
  mesmo com o bot parado. Quando a posição fecha por TP, o bot espera o próximo degrau; por SL, para o grid.
- **Recentro automático** (`AUTO_RECENTER`, padrão ligado): sem posição aberta e com o preço fora da faixa
  (acima do `high` ou abaixo do degrau 0), o bot reposiciona a faixa em `−RECENTER_DOWN_PCT%` / `+RECENTER_UP_PCT%`
  do preço (padrão −6% / +2%), mantém degraus, margem e alavancagem, avisa no canal ("Grid recentrado") e já entra
  no degrau do preço no mesmo tick. Com posição aberta nunca recentra. Com `AUTO_RECENTER = "false"` só manda
  um alerta "preço fora da faixa".
- **Risco** (`src/risk.ts`, valores em `wrangler.toml`): alavancagem limitada pelo máximo do contrato (sem teto global artificial de 3x); margens, exposição total e perda diária seguem os limites configurados,
  margem ≤ `MAX_ORDER_PCT` do saldo por trade (hoje **25%**, para operar com ~$10), perda diária ≥ 5% pausa
  o bot, stop-loss 5% abaixo do `low`, whitelist BTC/ETH/SOL, tamanho mínimo do contrato validado no `/grid`.
- **Pares**: `ALLOWED_MARKETS = "*"` libera todos os contratos ativos do Walt com volume 24h ≥
  `MIN_VOLUME_24H_USD` ($1 mi). A Mini App lista os 127 contratos com volume, funding, alavancagem máxima e
  margem mínima; os sem liquidez aparecem bloqueados.
- **Alertas**: entradas, TP/SL, pausas, bloqueios de risco e erros vão para o canal `ALERT_CHAT_ID`
  (`wrangler.toml`; o bot precisa ser admin do canal). Se o envio falhar, o alerta cai no chat do dono.
- **Walt MCP** (`src/walt.ts`): segue o `perps_guide`. Toda escrita é `perps_prepare_*` → `perps_execute_operation`
  com o `confirmationToken`; o `amount` é **margem em USDC**; o preço vem de `perps_latest_rate` com
  `marketId` no formato `BTC-USD-PERP`; o saldo vem de `balance_get` (`accounts[].balance_available`, USDT); um execute que falha **nunca é repetido**
  (o bot pausa e pede conferência, para evitar ordens duplicadas). OAuth 2.1 com PKCE e registro dinâmico;
  o Walt só aceita redirect para `localhost`, então o endereço final é colado no bot.

## Mini App (Telegram Serverless)

Pasta `miniapp/` (projeto `tgcloud`): `web/` é a Mini App estática (HTML/JS/CSS puros, ícones SVG inline em
`web/icons.js`, sem emojis); `tgcloud/handlers/message.js` encaminha as
mensagens ao Worker; `tgcloud/endpoints/*` (`state`, `contracts`, `price`, `chart`, `trades`, `configure`,
`control`) repassam para a API do Worker. Abas:

- **Painel**: modo, status, preço, posição (entrada, TP, SL, PnL aberto, distância da liquidação, funding pago),
  gráfico de 48 h (velas de 15 min da Hyperliquid, ou os preços gravados pelo bot) com degraus, TP, SL e entrada.
- **Pares**: busca e filtro de liquidez; tocar num par mostra preço, margem mínima e faixa sugerida, e
  "Usar no grid" preenche o formulário.
- **Histórico**: trades (abertura, TP, SL, manual) e curva de patrimônio.
- **Controles**: configurar e acompanhar a simulação DEMO, consultar posições e histórico. LIVE permanece desabilitado até aprovação da segurança.

O Serverless não tem secrets e o repositório é público, então a chave da API **não fica no código**: o dono
envia `/link <API_SECRET>` no chat do bot uma vez; o handler valida no Worker, grava a chave e o seu user id no
banco do tgcloud e apaga a mensagem. Só esse user id abre os endpoints da Mini App.

**Ativar:**
1. No environment `TELEGRAM_BOT_TOKEN` do GitHub, crie `API_SECRET` (aleatório, longo) e `TGCLOUD_TOKEN`
   (BotFather → Serverless → CLI Access).
2. Rode o workflow (push na `main` ou *Run workflow*): o job `deploy` publica o Worker com o `API_SECRET` e o
   `deploy-miniapp` faz `tgcloud fetch` + `push` + `migrate --safe` e imprime a URL `https://app<id>.tgcloud.ai/`
   (a deste bot é `https://app8936339348.tgcloud.ai/`).
3. Coloque essa URL em `MINIAPP_URL` no `wrangler.toml` (novo deploy) e abra
   `/setup?secret=<TELEGRAM_WEBHOOK_SECRET>`: cria o botão de menu **Painel** sem mexer no webhook.
4. No chat do bot: `/link <API_SECRET>`. O bot apaga a mensagem e responde "✅ Vinculado ao Worker".

**Status histórico de implantação** (2026-10-24): o Worker e a Mini App foram ativados naquele momento. Esse registro não confirma o estado atual da implantação nem substitui o gate de release abaixo. O bot de produto atual é `@Kripta_Guru_bot`; o identificador legado `@walletbotmcpbot` não deve ser usado como referência de UI.

**Problemas comuns:**
- `deploy-miniapp` com *"never synced"*: o runner não tem `.tgcloud/`; o workflow já roda `tgcloud fetch` antes do push.
- `--yes and --safe are mutually exclusive`: use só `tgcloud migrate --safe`.
- Comandos sem resposta com o Serverless ligado: falta o `/link` (o handler responde "Bot em configuração").
- Desligar o Serverless no BotFather: abra `/setup` com `MINIAPP_URL` vazio para o webhook voltar ao Worker.

Local: `cd miniapp && npm install && npx tgcloud login && npx tgcloud fetch && npx tgcloud push && npx tgcloud migrate`.

### API do Worker (`/api/*`, header `X-Api-Key: <API_SECRET>`)

| Rota | O que faz |
|---|---|
| `GET state` | estado, grid (degraus, SL), posição paper/Walt ao vivo, PnL, travas |
| `GET contracts` | contratos do Walt com volume, funding, `liquid`, `allowed` |
| `GET price?market=&leverage=` | preço, margem mínima e faixa sugerida |
| `GET chart?market=` | velas de 15 min (Hyperliquid) ou preços gravados |
| `GET trades` | histórico de trades e curva de patrimônio |
| `POST grid` | `{market, low, high, levels, marginUsd, leverage}` |
| `POST control` | `{action: run\|stop\|resume\|closeall\|mode, mode?, confirm?}` |
| `POST telegram` | update do Telegram encaminhado pelo tgcloud |


## Estado atual do release — 2026-11-19

- **DEMO:** основной безопасный сценарий приложения; рыночные данные, графики, виртуальные позиции и история доступны через текущие API и UI.
- **AI Trading:** отдельный виртуальный счёт и read-only сводка; активный runner стратегий и автоматическое исполнение стратегий пока не реализованы. Не отображать статус «работает» без реального runner.
- **LIVE:** UI-переключатель заблокирован. Backend содержит prepare → explicit confirm → atomic one-shot execute → UNKNOWN/reconciliation для ручного открытия, но закрывающий контракт Walt не подтверждён. LIVE нельзя считать готовым для пользователей.
- **Безопасность:** нет автоматического LIVE grid execution; старый scheduled путь fail-closed. Реальные ордера, закрытия и переводы не использовать в тестах.
- **QA:** проверять `npm ci`, `npm run typecheck`, `npm test`, чистые UI screenshot/contract tests и ручной прогон Telegram iOS WebView. Зелёные PR checks не равны production deploy.
- **Release gate:** не выполнять production deploy, пока не закрыты security review, точный Walt close contract, полноценные mocked end-to-end тесты и ручная iPhone QA.
## Instalação

1. **Bot do Telegram**: no @BotFather pegue o token do `@walletbotmcpbot`.
2. **GitHub → Settings → Secrets → Actions**, crie:
   - `CLOUDFLARE_API_TOKEN` (template “Edit Cloudflare Workers”) e `CLOUDFLARE_ACCOUNT_ID`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_WEBHOOK_SECRET` (string aleatória, só `A-Z a-z 0-9 _ -`)
   - `OWNER_CHAT_ID` (seu chat id; se deixar vazio, o bot responde qualquer mensagem com o seu id)
   - `API_SECRET` (chave da API da Mini App) e, para a Mini App, `TGCLOUD_TOKEN`
   Os secrets podem estar no environment `TELEGRAM_BOT_TOKEN` (é o que o job `deploy` usa).
3. Push na `main` (ou *Run workflow* manual) → o workflow roda testes e faz `wrangler deploy`.
   A conta Cloudflare Free permite só 5 cron triggers; se o deploy falhar com `code: 10072`, libere um.
   O KV grátis permite 1000 escritas/dia: o bot faz ~1 escrita por tick (288/dia) e grava trades só em eventos. O KV `walletbot-mcp-STATE` já está
   configurado em `wrangler.toml`.
4. Sem o Telegram Serverless, registre o webhook direto no Worker abrindo uma vez (com `MINIAPP_URL`
   preenchida, este passo só cria o botão de menu):
   `https://walletbot-mcp.<sua-conta>.workers.dev/setup?secret=<TELEGRAM_WEBHOOK_SECRET>`
5. No Telegram:
   ```
   /connect                       → autorize no Walt e confirme no Telegram
   <cole o endereço localhost>    → conclui a conexão
   /conta  e  /conta CONFIRMO     → cria a conta Perps do agente (uma vez)
   /grid BTC 100000 110000 10 5 3 → BTC, faixa, 10 degraus, $5 de margem por trade, 3x
   /run                           → modo paper (simulado, preço real do Walt)
   /status
   LIVE: bloqueado. Não execute `/mode live`, `/live` ou `/run` para operar dinheiro real; o fluxo de grid LIVE está fail-closed.
   ```

### Valor mínimo por trade

O Walt exige `amount ≥ min_size_quote` ($1) **e** tamanho ≥ `min_size_base` do contrato. O tamanho é
`nocional ÷ (preço × (1 + slippage))`, com `nocional = margem ÷ (1/alavancagem + taxa taker)`. Para BTC
(`min_size_base` 0,00007, slippage 1%, taxa 0,09%) a ~$84 mil e 3x, a margem mínima é **≈ $2,00**; o `/grid`
recusa valores abaixo disso. Com saldo de $9,99 e `MAX_ORDER_PCT` 25%, o teto por trade é $2,49 — por isso o
grid atual usa `/grid BTC 77666.6 84276.5 8 2.2 3`.

### Comandos

| Comando | O que faz |
|---|---|
| `/status` | modo, grid, posição, PnL |
| `/connect`, `/code <url>`, `/disconnect` | OAuth do Walt |
| `/conta [CONFIRMO]` | `perps_readiness`; cria a conta Perps do agente se faltar |
| `/saldo` | `balance_get` |
| `/tools` | lista as tools (schemas em `/tools.json?secret=…`) |
| `/call <tool> [json]` | chama uma tool de leitura/preview diretamente (execute é bloqueado) |
| `/grid <mercado> <low> <high> <degraus> <margemUSD> [alav]` | configura o grid (`/grid` sozinho sugere um comando a partir do preço atual) |
| `/run`, `/stop`, `/closeall` | inicia, para (posição fica com TP/SL), fecha a posição e para |
| `/mode paper` | retorna ao modo DEMO/PAPER; LIVE permanece bloqueado no código atual |
| `/risk`, `/resume`, `/paper reset [saldo]` | travas, retomar após pausa, reiniciar simulação |
| `/testalert` | testa o envio de alertas para o canal |

## Desenvolvimento local

```bash
git clone https://github.com/stalinesatola/walletbot-mcp C:\GESTEM\walletbot-mcp
cd C:\GESTEM\walletbot-mcp
npm install
npm test && npm run typecheck
cp .dev.vars.example .dev.vars   # preencha
npx wrangler dev                 # use um túnel (ex.: cloudflared) para testar o webhook
```

Ferramentas: `wrangler` 4.152, `vitest` 5, `typescript` 5.9 (só dev; o Worker não tem dependências npm em
runtime). O `package.json` força `undici ^7.30.1` via `overrides`, porque o `miniflare` do wrangler ainda puxa uma
versão vulnerável. Confira com `npm audit` (esperado: 0 vulnerabilidades).

## Histórico de mudanças

| PR | O que entrou |
|---|---|
| #1 | Bot inicial: Worker + Telegram + cron + KV, cliente MCP e OAuth do Walt, grid e travas de risco |
| #2 | Adaptador dedicado ao Walt Perps (prepare → execute), grid de posição única com TP/SL nativos, alertas no canal, licença MIT |
| #3 | Mini App no Telegram Serverless (painel, pares, histórico, controles), API do Worker, `ALLOWED_MARKETS="*"` |
| #4 | Deploy da Mini App corrigido (`fetch` + `migrate --safe`), `MINIAPP_URL`, ícones SVG |
| #5 | Recentro automático do grid quando o preço sai da faixa; vitest 5, wrangler 4.152, `undici` forçado (0 vulnerabilidades) |

## Licença

[MIT](LICENSE) © 2026 Staline Satola. Uso por sua conta e risco: trading de perpétuos alavancados pode
causar perda total do capital.

> A memória do projeto para o Claude Code fica em `.secrets/CLAUDE.md`, que **não é versionado**
> (`.gitignore`). Mantenha uma cópia local em `C:\GESTEM\walletbot-mcp\.secrets\CLAUDE.md`.
