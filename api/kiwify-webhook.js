const crypto = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const KIWIFY_WEBHOOK_TOKEN = process.env.KIWIFY_WEBHOOK_TOKEN;

function send(res, status, data) {
  return res.status(status).json(data);
}

function safeEqual(a, b) {
  if (!a || !b) return false;

  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));

  if (aBuf.length !== bBuf.length) return false;

  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * A Kiwify usa um token configurado no webhook.
 *
 * Algumas integrações/versões entregam a assinatura:
 * - como ?signature=...
 * - no header X-Kiwify-Signature
 *
 * Também aceitamos o token diretamente em headers comuns
 * para facilitar compatibilidade com diferentes formatos de entrega.
 */
function validateKiwifyRequest(req, rawBody) {
  if (!KIWIFY_WEBHOOK_TOKEN) {
    console.error("KIWIFY_WEBHOOK_TOKEN não configurado.");
    return false;
  }

  const signature =
    req.query?.signature ||
    req.headers["x-kiwify-signature"] ||
    req.headers["x-kiwify-token"] ||
    req.headers["x-webhook-token"];

  if (!signature) {
    console.error("Assinatura/token da Kiwify não encontrado.");
    return false;
  }

  const received = String(signature).trim();

  // Caso a Kiwify entregue o próprio token.
  if (safeEqual(received, KIWIFY_WEBHOOK_TOKEN)) {
    return true;
  }

  // Caso entregue HMAC-SHA1 do corpo usando o token como segredo.
  const expected = crypto
    .createHmac("sha1", KIWIFY_WEBHOOK_TOKEN)
    .update(rawBody, "utf8")
    .digest("hex");

  const expectedWithPrefix = `sha1=${expected}`;

  return (
    safeEqual(received, expected) ||
    safeEqual(received, expectedWithPrefix)
  );
}

function normalizeEmail(email) {
  if (!email) return null;

  const normalized = String(email).trim().toLowerCase();

  if (!normalized || !normalized.includes("@")) {
    return null;
  }

  return normalized;
}

function getEventType(body) {
  return String(
    body?.webhook_event_type ||
      body?.event_type ||
      body?.event ||
      body?.type ||
      ""
  )
    .trim()
    .toLowerCase();
}

function getCustomer(body) {
  return body?.Customer || body?.customer || {};
}

function getProduct(body) {
  return body?.Product || body?.product || {};
}

function getEmail(body) {
  const customer = getCustomer(body);

  return normalizeEmail(
    customer.email ||
      customer.email_address ||
      body?.email ||
      body?.customer_email
  );
}

function getCustomerName(body) {
  const customer = getCustomer(body);

  return (
    customer.full_name ||
    customer.name ||
    customer.first_name ||
    body?.customer_name ||
    null
  );
}

function getProductId(body) {
  const product = getProduct(body);

  return (
    product.product_id ||
    product.id ||
    product.pid ||
    body?.product_id ||
    null
  );
}

function getProductName(body) {
  const product = getProduct(body);

  return (
    product.product_name ||
    product.name ||
    body?.product_name ||
    null
  );
}

function getOrderId(body) {
  return (
    body?.order_id ||
    body?.orderId ||
    body?.order_number ||
    body?.transaction_id ||
    null
  );
}

function getSubscriptionId(body) {
  return (
    body?.subscription_id ||
    body?.subscriptionId ||
    body?.Subscription?.subscription_id ||
    null
  );
}

function isActiveEvent(eventType, body) {
  const activeEvents = new Set([
    "compra_aprovada",
    "order_approved",
    "compra_approved",
    "subscription_renewed",
    "subscription_renew",
    "subscription_created",
  ]);

  if (activeEvents.has(eventType)) {
    return true;
  }

  // Algumas notificações de aprovação também carregam
  // order_status = paid.
  if (
    body?.order_status === "paid" &&
    (
      eventType === "" ||
      eventType === "order_approved" ||
      eventType === "compra_aprovada"
    )
  ) {
    return true;
  }

  return false;
}

function isInactiveEvent(eventType) {
  const inactiveEvents = new Set([
    "compra_reembolsada",
    "order_refunded",
    "compra_refund",
    "refund",
    "chargeback",
    "subscription_canceled",
    "subscription_cancelled",
    "subscription_late",
    "subscription_expired",
  ]);

  return inactiveEvents.has(eventType);
}

async function supabaseRequest(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    console.error("Erro Supabase:", response.status, data);
    throw new Error(
      `Supabase respondeu ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}

async function findSubscriptionByEmail(email) {
  const encodedEmail = encodeURIComponent(email);

  return supabaseRequest(
    `subscriptions?select=*&email=eq.${encodedEmail}&limit=1`,
    {
      method: "GET",
    }
  );
}

async function createSubscription(record) {
  return supabaseRequest("subscriptions", {
    method: "POST",
    headers: {
      Prefer: "return=representation",
    },
    body: JSON.stringify(record),
  });
}

async function updateSubscription(id, record) {
  return supabaseRequest(
    `subscriptions?id=eq.${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: {
        Prefer: "return=representation",
      },
      body: JSON.stringify(record),
    }
  );
}

module.exports = async function handler(req, res) {
  // Kiwify envia POST.
  if (req.method !== "POST") {
    return send(res, 405, {
      ok: false,
      error: "Método não permitido.",
    });
  }

  // Verificação básica das configurações.
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
      "SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configurados."
    );

    return send(res, 500, {
      ok: false,
      error: "Configuração do Supabase ausente.",
    });
  }

  try {
    /*
     * Precisamos do corpo original para validar assinatura HMAC.
     * O Vercel normalmente disponibiliza req.body já parseado.
     * Quando isso acontece, reconstruímos o JSON de forma consistente.
     */
    let body = req.body;

    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return send(res, 400, {
          ok: false,
          error: "JSON inválido.",
        });
      }
    }

    if (!body || typeof body !== "object") {
      return send(res, 400, {
        ok: false,
        error: "Payload vazio ou inválido.",
      });
    }

    const rawBody =
      typeof req.body === "string"
        ? req.body
        : JSON.stringify(body);

    /*
     * Segurança:
     * valida o token/assinatura antes de alterar o banco.
     */
    const valid = validateKiwifyRequest(req, rawBody);

    if (!valid) {
      console.error("Webhook Kiwify rejeitado: assinatura inválida.");

      return send(res, 401, {
        ok: false,
        error: "Webhook não autorizado.",
      });
    }

    const eventType = getEventType(body);

    const email = getEmail(body);
    const customerName = getCustomerName(body);
    const productId = getProductId(body);
    const productName = getProductName(body);
    const orderId = getOrderId(body);
    const subscriptionId = getSubscriptionId(body);

    if (!email) {
      console.error("Webhook sem email do cliente.", {
        eventType,
        orderId,
      });

      return send(res, 400, {
        ok: false,
        error: "Email do cliente não encontrado.",
      });
    }

    let status = null;

    if (isActiveEvent(eventType, body)) {
      status = "active";
    } else if (isInactiveEvent(eventType)) {
      status = "inactive";
    }

    /*
     * Eventos que não alteram o acesso:
     * boleto_gerado, pix_gerado, carrinho_abandonado,
     * compra_recusada etc.
     */
    if (!status) {
      console.log("Evento recebido sem alteração de acesso:", eventType);

      return send(res, 200, {
        ok: true,
        ignored: true,
        event: eventType || null,
      });
    }

    const existing = await findSubscriptionByEmail(email);

    const record = {
      email,
      customer_name: customerName,
      product_id: productId,
      product_name: productName,
      order_id: orderId,
      subscription_id: subscriptionId,
      status,
      last_event: eventType || "unknown",
      updated_at: new Date().toISOString(),
    };

    if (existing && existing.length > 0) {
      await updateSubscription(existing[0].id, record);

      console.log("Assinatura atualizada:", {
        email,
        status,
        eventType,
      });

      return send(res, 200, {
        ok: true,
        action: "updated",
        email,
        status,
        event: eventType,
      });
    }

    await createSubscription({
      ...record,
      created_at: new Date().toISOString(),
    });

    console.log("Assinatura criada:", {
      email,
      status,
      eventType,
    });

    return send(res, 200, {
      ok: true,
      action: "created",
      email,
      status,
      event: eventType,
    });
  } catch (error) {
    console.error("Erro no webhook Kiwify:", error);

    return send(res, 500, {
      ok: false,
      error: "Erro interno ao processar webhook.",
    });
  }
};
