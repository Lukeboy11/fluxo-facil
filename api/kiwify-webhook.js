// api/kiwify-webhook.js

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

const KIWIFY_WEBHOOK_TOKEN =
  process.env.KIWIFY_WEBHOOK_TOKEN;


// ============================================================
// RESPOSTA JSON
// ============================================================

function response(res, status, body) {
  return res.status(status).json(body);
}


// ============================================================
// NORMALIZAR E-MAIL
// ============================================================

function normalizeEmail(email) {
  if (!email || typeof email !== "string") {
    return null;
  }

  return email.trim().toLowerCase();
}


// ============================================================
// SUPABASE REST API
// ============================================================

async function supabaseRequest(path, options = {}) {
  if (!SUPABASE_URL) {
    throw new Error("SUPABASE_URL não configurada.");
  }

  if (!SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY não configurada."
    );
  }

  const result = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      ...options,

      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,

        Authorization:
          `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,

        "Content-Type":
          "application/json",

        ...(options.headers || {})
      }
    }
  );

  const text = await result.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!result.ok) {
    throw new Error(
      `Supabase ${result.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}


// ============================================================
// VALIDAR TOKEN DA KIWIFY
// ============================================================
//
// O token configurado no painel da Kiwify será colocado
// como variável secreta na Vercel.
//
// Dependendo do formato enviado pela Kiwify, tentamos
// encontrar o token nos headers.
// ============================================================

function validateKiwifyToken(req, body) {
  if (!KIWIFY_WEBHOOK_TOKEN) {
    return false;
  }

  const headers = req.headers || {};

  const receivedToken =
    headers["x-kiwify-token"] ||
    headers["x-webhook-token"] ||
    headers["authorization"]?.replace(/^Bearer\s+/i, "") ||
    body?.token ||
    null;

  if (!receivedToken) {
    return false;
  }

  return String(receivedToken).trim() ===
    String(KIWIFY_WEBHOOK_TOKEN).trim();
}


// ============================================================
// PEGAR EVENTO
// ============================================================

function getEvent(body) {
  return (
    body.webhook_event_type ||
    body.event_type ||
    body.event ||
    null
  );
}


// ============================================================
// PEGAR CLIENTE
// ============================================================

function getCustomer(body) {
  return (
    body.Customer ||
    body.customer ||
    {}
  );
}


// ============================================================
// PEGAR PRODUTO
// ============================================================

function getProduct(body) {
  return (
    body.Product ||
    body.product ||
    {}
  );
}


// ============================================================
// PEGAR E-MAIL
// ============================================================

function getEmail(body) {
  const customer =
    getCustomer(body);

  return normalizeEmail(
    customer.email ||
    body.customer_email ||
    body.email ||
    null
  );
}


// ============================================================
// PEGAR NOME
// ============================================================

function getCustomerName(body) {
  const customer =
    getCustomer(body);

  return (
    customer.full_name ||
    customer.name ||
    body.customer_name ||
    null
  );
}


// ============================================================
// PEGAR PRODUTO
// ============================================================

function getProductId(body) {
  const product =
    getProduct(body);

  return (
    product.product_id ||
    product.id ||
    body.product_id ||
    null
  );
}


function getProductName(body) {
  const product =
    getProduct(body);

  return (
    product.product_name ||
    product.name ||
    body.product_name ||
    null
  );
}


// ============================================================
// PEGAR ASSINATURA
// ============================================================

function getSubscriptionId(body) {
  return (
    body.subscription_id ||
    body.Subscription?.subscription_id ||
    body.subscription?.subscription_id ||
    null
  );
}


// ============================================================
// SALVAR / ATUALIZAR ASSINATURA
// ============================================================

async function saveSubscription(data) {

  const {
    email,
    customerName,
    productId,
    productName,
    orderId,
    subscriptionId,
    event
  } = data;


  // ==========================================================
  // EVENTOS QUE LIBERAM / MANTÊM ACESSO
  // ==========================================================

  const activeEvents = [
    "compra_aprovada",
    "subscription_renewed",
    "order_approved"
  ];


  // ==========================================================
  // EVENTOS QUE BLOQUEIAM ACESSO
  // ==========================================================

  const inactiveEvents = [
    "compra_reembolsada",
    "chargeback",
    "subscription_canceled",
    "subscription_late"
  ];


  let status = null;


  if (activeEvents.includes(event)) {
    status = "active";
  }


  if (inactiveEvents.includes(event)) {
    status = "inactive";
  }


  // Eventos que não alteram acesso.
  if (!status) {
    return {
      changed: false,
      status: "ignored"
    };
  }


  // ==========================================================
  // PROCURAR ASSINATURA PELO E-MAIL
  // ==========================================================

  const existing =
    await supabaseRequest(
      `subscriptions?email=eq.${encodeURIComponent(email)}&select=id`,
      {
        method: "GET"
      }
    );


  const record = {
    email,
    customer_name: customerName,

    product_id: productId,
    product_name: productName,

    order_id: orderId,
    subscription_id: subscriptionId,

    status,
    last_event: event,

    updated_at:
      new Date().toISOString()
  };


  // ==========================================================
  // ATUALIZAR
  // ==========================================================

  if (existing && existing.length > 0) {

    await supabaseRequest(
      `subscriptions?id=eq.${encodeURIComponent(
        existing[0].id
      )}`,
      {
        method: "PATCH",

        headers: {
          Prefer: "return=minimal"
        },

        body: JSON.stringify(record)
      }
    );

    return {
      changed: true,
      status,
      action: "updated"
    };
  }


  // ==========================================================
  // CRIAR
  // ==========================================================

  await supabaseRequest(
    "subscriptions",
    {
      method: "POST",

      headers: {
        Prefer: "return=minimal"
      },

      body: JSON.stringify({
        ...record,

        created_at:
          new Date().toISOString()
      })
    }
  );


  return {
    changed: true,
    status,
    action: "created"
  };
}


// ============================================================
// VERCEL HANDLER
// ============================================================

module.exports = async function handler(req, res) {

  // ----------------------------------------------------------
  // SOMENTE POST
  // ----------------------------------------------------------

  if (req.method !== "POST") {
    return response(res, 405, {
      ok: false,
      error: "Método não permitido."
    });
  }


  try {

    // --------------------------------------------------------
    // BODY
    // --------------------------------------------------------

    let body = req.body;


    if (!body) {
      return response(res, 400, {
        ok: false,
        error: "Body vazio."
      });
    }


    if (typeof body === "string") {

      try {
        body = JSON.parse(body);
      } catch {
        return response(res, 400, {
          ok: false,
          error: "JSON inválido."
        });
      }

    }


    // --------------------------------------------------------
    // TOKEN
    // --------------------------------------------------------

    if (!validateKiwifyToken(req, body)) {

      console.error(
        "Webhook Kiwify rejeitado: token inválido."
      );

      return response(res, 401, {
        ok: false,
        error: "Não autorizado."
      });
    }


    // --------------------------------------------------------
    // EVENTO
    // --------------------------------------------------------

    const event =
      getEvent(body);


    if (!event) {

      return response(res, 400, {
        ok: false,
        error: "Evento não informado."
      });
    }


    // --------------------------------------------------------
    // DADOS
    // --------------------------------------------------------

    const email =
      getEmail(body);

    const customerName =
      getCustomerName(body);

    const productId =
      getProductId(body);

    const productName =
      getProductName(body);

    const orderId =
      body.order_id ||
      body.order_ref ||
      null;

    const subscriptionId =
      getSubscriptionId(body);


    // --------------------------------------------------------
    // LOG
    // --------------------------------------------------------

    console.log(
      "Kiwify webhook recebido:",
      {
        event,
        orderId,
        productId,
        hasEmail: Boolean(email),
        hasSubscription:
          Boolean(subscriptionId)
      }
    );


    // --------------------------------------------------------
    // E-MAIL É O VÍNCULO DO CLIENTE
    // --------------------------------------------------------

    if (!email) {

      console.error(
        "Webhook sem e-mail do comprador."
      );

      return response(res, 400, {
        ok: false,
        error:
          "E-mail do comprador não encontrado."
      });
    }


    // --------------------------------------------------------
    // SALVAR NO SUPABASE
    // --------------------------------------------------------

    const result =
      await saveSubscription({

        email,

        customerName,

        productId,

        productName,

        orderId,

        subscriptionId,

        event

      });


    // --------------------------------------------------------
    // SUCESSO
    // --------------------------------------------------------

    return response(res, 200, {

      ok: true,

      received: true,

      event,

      access:
        result.status,

      action:
        result.action || null

    });


  } catch (error) {

    console.error(
      "Erro no webhook Kiwify:",
      error
    );

    return response(res, 500, {

      ok: false,

      error:
        "Erro interno ao processar webhook."

    });
  }
};
