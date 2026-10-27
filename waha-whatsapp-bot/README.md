# WAHA WhatsApp Bot

Automação de WhatsApp em Node.js (Express + Axios) que recebe webhooks do [WAHA](https://waha.devlike.pro/) e responde automaticamente. Exemplo incluído: quando a mensagem contém **"Oi"**, o bot responde **"Olá! Como posso ajudar?"**.

## Estrutura

```
waha-whatsapp-bot/
├── .github/workflows/deploy.yml
├── src/index.js
├── .dockerignore
├── .env.example
├── .gitignore
├── Dockerfile
├── package.json
└── README.md
```

## Variáveis de ambiente

| Variável | Obrigatória | Descrição |
|---|---|---|
| `WAHA_API_URL` | Sim | URL base do WAHA, sem barra final. Ex.: `http://waha:3000` (rede interna do EasyPanel) ou `https://waha.seudominio.com` |
| `WAHA_API_TOKEN` | Sim | Mesmo valor de `WAHA_API_KEY` configurado no WAHA (enviado no header `X-Api-Key`) |
| `PORT` | Sim | Porta do servidor de webhook. Padrão: `3000` |
| `WAHA_SESSION` | Não | Nome da sessão no WAHA. Padrão: `default` |
| `WAHA_WEBHOOK_HMAC_KEY` | Não | Se definida, valida a assinatura HMAC dos webhooks |
| `REPLY_TEXT` | Não | Texto da resposta automática |
| `REPLY_IN_GROUPS` | Não | `true` para responder também em grupos. Padrão: `false` |

## Deploy no EasyPanel

### Opção A: EasyPanel builda a partir do GitHub (mais simples)

1. No EasyPanel, crie um serviço **App** e, na aba **Source**, escolha **Github** (ou Git) e selecione este repositório, branch `main`.
2. Em **Build**, escolha **Dockerfile**.
3. Na aba **Environment**, adicione `WAHA_API_URL`, `WAHA_API_TOKEN` e `PORT=3000`.
4. Na aba **Domains & Proxy**, defina a porta `3000` e, se quiser, um domínio.
5. Para deploy contínuo, copie a **Deploy Webhook URL** do app e cadastre-a no GitHub (Settings > Webhooks, evento `push`), ou use o secret da Opção B.

### Opção B: GitHub Actions publica a imagem no GHCR e dispara o redeploy

1. No EasyPanel, crie um serviço **App** com **Source = Docker Image** e use `ghcr.io/SEU_USUARIO/SEU_REPOSITORIO:latest`.
2. Se o pacote for privado, informe usuário e um Personal Access Token com `read:packages` nas credenciais do registry do app. Para facilitar, você pode tornar o pacote público.
3. Configure as variáveis de ambiente do passo 3 acima.
4. Copie a **Deploy Webhook URL** do app no EasyPanel.
5. No GitHub: **Settings > Secrets and variables > Actions > New repository secret**, nome `EASYPANEL_DEPLOY_WEBHOOK_URL`, valor = URL copiada.
6. A cada push na `main`, o workflow builda a imagem, envia ao GHCR e chama o webhook para o EasyPanel puxar a nova versão. Sem o secret, o passo de redeploy é pulado.

## Apontando o WAHA para esta aplicação

Configure o webhook na sessão do WAHA. Pela API (`POST /api/sessions` ou `PUT /api/sessions/default`):

```json
{
  "name": "default",
  "config": {
    "webhooks": [
      {
        "url": "http://NOME_DO_SERVICO_DO_BOT:3000/webhook",
        "events": ["message"]
      }
    ]
  }
}
```

Ou, para todas as sessões, defina no container do WAHA:

```
WHATSAPP_HOOK_URL=http://NOME_DO_SERVICO_DO_BOT:3000/webhook
WHATSAPP_HOOK_EVENTS=message
```

Dicas:

- Se os dois serviços estão no mesmo projeto do EasyPanel, use o nome interno do serviço (ex.: `http://bot-whatsapp:3000/webhook`). Se não, use a URL pública (`https://bot.seudominio.com/webhook`).
- Para validar a origem dos webhooks, defina a mesma chave em `WHATSAPP_HOOK_HMAC_KEY` (WAHA) e `WAHA_WEBHOOK_HMAC_KEY` (este app).

## Testando

Health check:

```bash
curl http://localhost:3000/health
```

Simulando um webhook localmente (sem HMAC):

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d '{"event":"message","session":"default","payload":{"id":"teste1","from":"5511999999999@c.us","fromMe":false,"body":"Oi"}}'
```

## Desenvolvimento local

```bash
cp .env.example .env
npm install
npm run dev
```
