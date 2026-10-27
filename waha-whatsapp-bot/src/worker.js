
const processedMessages = new Set();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function normalize(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function containsOi(text) {
  return /(^|[^a-z0-9])oi([^a-z0-9]|$)/.test(normalize(text));
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function isValidSignature(request, rawBody, env) {
  const secret = env.WAHA_WEBHOOK_HMAC_KEY;
  if (!secret) return true;

  const signature = request.headers.get("X-Webhook-Hmac");
  if (!signature) return false;

  const algorithm = (
    request.headers.get("X-Webhook-Hmac-Algorithm") || "sha512"
  ).toLowerCase();

  const hashes = {
    sha256: "SHA-256",
    sha384: "SHA-384",
    sha512: "SHA-512",
  };

  if (!hashes[algorithm]) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: hashes[algorithm] },
    false,
    ["sign"]
  );

  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody)
  );

  const expected = Array.from(new Uint8Array(signed))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  return constantTimeEqual(
    signature.toLowerCase().replace(/^0x/, ""),
    expected
  );
}

async function callWaha(path, body, env) {
  if (!env.WAHA_API_URL) {
    throw new Error("WAHA_API_URL não configurada.");
  }

  const baseUrl = env.WAHA_API_URL.replace(/\/+$/, "");
  const headers = { "Content-Type": "application/json" };

  if (env.WAHA_API_TOKEN) {
    headers["X-Api-Key"] = env.WAHA_API_TOKEN;
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`WAHA retornou HTTP ${response.status} em ${path}`);
  }

  return response;
}

async function handleIncomingMessage(payload, env) {
  const data = payload?.payload || payload;
  const messageId = data?.id?._serialized || data?.id;
  const chatId = data?.from;

  if (!chatId || data?.fromMe) return;

  if (
    messageId &&
    processedMessages.has(messageId)
  ) {
    return;
  }

  if (messageId) {
    processedMessages.add(messageId);

    if (processedMessages.size > 500) {
      const oldest = processedMessages.values().next().value;
      processedMessages.delete(oldest);
    }
  }

  const isGroup = chatId.endsWith("@g.us");

  if (isGroup && env.REPLY_IN_GROUPS !== "true") return;

  const text =
    data?.body ||
    data?.text ||
    data?.message?.conversation ||
    "";

  if (!containsOi(text)) return;

  const session = env.WAHA_SESSION || "default";

  try {
    await callWaha("/api/sendSeen", {
      session,
      chatId,
    });

    await callWaha("/api/startTyping", {
      session,
      chatId,
    });

    await callWaha("/api/sendText", {
      session,
      chatId,
      text: env.REPLY_TEXT || "Olá! Como posso ajudar?",
    });
  } finally {
    try {
      await callWaha("/api/stopTyping", {
        session,
        chatId,
      });
    } catch (error) {
      console.error("Não foi possível parar a digitação:", error);
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        service: "Academia Rodrigues",
        status: "ok",
      });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ status: "healthy" });
    }

    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return json({ error: "Not found" }, 404);
    }

    const rawBody = await request.text();

    try {
      if (!(await isValidSignature(request, rawBody, env))) {
        return json({ error: "Assinatura inválida" }, 401);
      }

      const payload = JSON.parse(rawBody);

      ctx.waitUntil(
        handleIncomingMessage(payload, env).catch((error) => {
          console.error("Erro ao processar mensagem:", error);
        })
      );

      return json({ received: true }, 200);
    } catch (error) {
      console.error("Erro no webhook:", error);
      return json({ error: "Payload inválido" }, 400);
    }
  },
};
