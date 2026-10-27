'use strict';

require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const axios = require('axios');

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const WAHA_API_URL = (process.env.WAHA_API_URL || '').trim().replace(/\/+$/, '');
const WAHA_API_TOKEN = (process.env.WAHA_API_TOKEN || '').trim();
const WAHA_SESSION = (process.env.WAHA_SESSION || 'default').trim();
const WEBHOOK_HMAC_KEY = (process.env.WAHA_WEBHOOK_HMAC_KEY || '').trim();
const REPLY_TEXT = process.env.REPLY_TEXT || 'Olá! Como posso ajudar?';
const REPLY_IN_GROUPS = String(process.env.REPLY_IN_GROUPS || 'false').toLowerCase() === 'true';

if (!WAHA_API_URL) {
  console.error('[config] Variável WAHA_API_URL não definida. Encerrando.');
  process.exit(1);
}

if (!WAHA_API_TOKEN) {
  console.warn('[config] WAHA_API_TOKEN vazio: requisições serão enviadas sem autenticação.');
}

// Cliente HTTP para a API do WAHA (a autenticação do WAHA usa o header X-Api-Key)
const waha = axios.create({
  baseURL: WAHA_API_URL,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
    ...(WAHA_API_TOKEN ? { 'X-Api-Key': WAHA_API_TOKEN } : {}),
  },
});

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Remove acentos, converte para minúsculas e normaliza espaços. */
function normalize(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Retorna true se a mensagem contém a palavra "oi" (não casa com "oitenta", "boi" etc.). */
function containsOi(text) {
  return /(^|[^a-z0-9])oi([^a-z0-9]|$)/.test(normalize(text));
}

/** Cache simples para evitar processar a mesma mensagem duas vezes (reenvio de webhook). */
const processedIds = new Set();
function alreadyProcessed(id) {
  if (!id) return false;
  if (processedIds.has(id)) return true;
  processedIds.add(id);
  if (processedIds.size > 1000) {
    processedIds.delete(processedIds.values().next().value);
  }
  return false;
}

/** Valida a assinatura HMAC enviada pelo WAHA (opcional, só se WAHA_WEBHOOK_HMAC_KEY estiver definida). */
function isValidSignature(req) {
  if (!WEBHOOK_HMAC_KEY) return true;

  const received = req.get('X-Webhook-Hmac');
  const algorithm = (req.get('X-Webhook-Hmac-Algorithm') || 'sha512').toLowerCase();
  if (!received || !req.rawBody) return false;

  try {
    const expected = crypto.createHmac(algorithm, WEBHOOK_HMAC_KEY).update(req.rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(received);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (err) {
    console.error('[hmac] Erro ao validar assinatura:', err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Funções da API do WAHA
// ---------------------------------------------------------------------------
async function sendSeen(chatId) {
  try {
    await waha.post('/api/sendSeen', { session: WAHA_SESSION, chatId });
  } catch (err) {
    console.warn('[waha] sendSeen falhou:', describeError(err));
  }
}

async function typingFor(chatId, ms) {
  try {
    await waha.post('/api/startTyping', { session: WAHA_SESSION, chatId });
    await sleep(ms);
    await waha.post('/api/stopTyping', { session: WAHA_SESSION, chatId });
  } catch (err) {
    console.warn('[waha] typing falhou:', describeError(err));
  }
}

async function sendText(chatId, text) {
  const { data } = await waha.post('/api/sendText', {
    session: WAHA_SESSION,
    chatId,
    text,
  });
  return data;
}

function describeError(err) {
  if (err.response) {
    return `HTTP ${err.response.status} - ${JSON.stringify(err.response.data)}`;
  }
  return err.message;
}

// ---------------------------------------------------------------------------
// Lógica de negócio
// ---------------------------------------------------------------------------
async function handleIncomingMessage(message) {
  if (!message || message.fromMe) return;

  const chatId = message.from;
  if (!chatId || chatId === 'status@broadcast') return;
  if (chatId.endsWith('@g.us') && !REPLY_IN_GROUPS) return;
  if (alreadyProcessed(message.id)) return;

  const body = message.body;
  if (!body || !containsOi(body)) return;

  console.log(`[msg] "${body}" de ${chatId} -> respondendo`);

  await sendSeen(chatId);
  await typingFor(chatId, 1000);
  await sendText(chatId, REPLY_TEXT);
}

// ---------------------------------------------------------------------------
// Servidor Express
// ---------------------------------------------------------------------------
const app = express();

app.disable('x-powered-by');
app.use(
  express.json({
    limit: '2mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf; // necessário para validar HMAC
    },
  })
);

app.get('/', (_req, res) => {
  res.json({ service: 'waha-whatsapp-bot', status: 'ok' });
});

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'healthy', uptime: process.uptime() });
});

app.post('/webhook', (req, res) => {
  if (!isValidSignature(req)) {
    console.warn('[webhook] Assinatura HMAC inválida.');
    return res.status(401).json({ error: 'invalid signature' });
  }

  // Responde rápido ao WAHA e processa em segundo plano
  res.status(200).json({ received: true });

  const { event, session, payload } = req.body || {};

  if (session && session !== WAHA_SESSION) return;
  if (event !== 'message') return;

  handleIncomingMessage(payload).catch((err) => {
    console.error('[webhook] Erro ao processar mensagem:', describeError(err));
  });
});

// Rota não encontrada
app.use((_req, res) => {
  res.status(404).json({ error: 'not found' });
});

// Tratamento de erros (ex.: JSON inválido)
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[express] Erro:', err.message);
  res.status(400).json({ error: 'bad request' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] Webhook ouvindo na porta ${PORT}`);
  console.log(`[server] WAHA: ${WAHA_API_URL} | sessão: ${WAHA_SESSION}`);
});

// Encerramento limpo (EasyPanel/Docker enviam SIGTERM no redeploy)
function shutdown(signal) {
  console.log(`[server] ${signal} recebido, encerrando...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
