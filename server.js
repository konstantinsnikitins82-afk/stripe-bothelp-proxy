// server.js
import express from "express";
import bodyParser from "body-parser";
import Stripe from "stripe";
import fetch from "node-fetch";

// ======== ENV ========
const STRIPE_SECRET_KEY      = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET  = process.env.STRIPE_WEBHOOK_SECRET;

// BotHelp OpenAPI (по желанию — можно оставить пустым, код ниже не ломается)
const BOTHELP_API_BASE       = (process.env.BOTHELP_API_BASE || "https://openapi.bothelp.io").trim();
const BOTHELP_CLIENT_ID      = process.env.BOTHELP_CLIENT_ID || "";
const BOTHELP_CLIENT_SECRET  = process.env.BOTHELP_CLIENT_SECRET || "";
const BOTHELP_TAG            = process.env.BOTHELP_TAG || "sub_active";
const BOTHELP_WEBHOOK_URL    = process.env.BOTHELP_WEBHOOK_URL || "";

// ======== Stripe ========
const stripe = new Stripe(STRIPE_SECRET_KEY);

// ======== Мэппинг языков → Payment Link (buy.stripe.com/XXXX) ========
// ВПИШИ свои коды ссылок (то, что идёт после buy.stripe.com/)
const PAYMENT_LINKS = {
  en: "9B66oG0u4df0AfkcqMw03",   // пример! замени на свой
  ru: "7sY4gY18eejXmaxXWgMW01",  // пример! замени на свой
  it: "abcdef1234567890abcd01",  // пример! замени на свой
  es: "abcdef1234567890abcd02",
  fr: "abcdef1234567890abcd03",
  lv: "abcdef1234567890abcd04",
};

// Соответствие языка локали чекаута Stripe (опционально)
const LOCALE = {
  en: "en",
  ru: "ru",
  it: "it",
  es: "es",
  fr: "fr",
  lv: "lv",
};

// ======== BotHelp OAuth2 (опционально, для дальнейшей автотеговки) ========
let bothelpToken = null;
let bothelpTokenExp = 0;

async function getBothelpToken() {
  if (!BOTHELP_CLIENT_ID || !BOTHELP_CLIENT_SECRET) return null; // можно работать без BotHelp API
  const now = Date.now();
  if (bothelpToken && now < bothelpTokenExp - 60_000) return bothelpToken;

  const params = new URLSearchParams();
  params.append("client_id", BOTHELP_CLIENT_ID);
  params.append("client_secret", BOTHELP_CLIENT_SECRET);
  params.append("grant_type", "client_credentials");

  const resp = await fetch(`${BOTHELP_API_BASE}/openapi/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });

  if (!resp.ok) {
    console.error("BotHelp token error:", resp.status, await resp.text());
    return null;
  }

  const data = await resp.json();
  bothelpToken = data.access_token;
  bothelpTokenExp = Date.now() + (data.expires_in || 3600) * 1000;
  console.log("✅ BotHelp token OK");
  return bothelpToken;
}

// ======== Express ========
const app = express();

// raw body только на /webhook
app.use("/webhook", bodyParser.raw({ type: "application/json" }));
// обычный json для остальных роутов
app.use(bodyParser.json());

// Healthcheck
app.get("/health", (_req, res) => res.status(200).send("OK"));

// ---------- PAY: редирект на Stripe Payment Link с tg_id ----------
app.get("/pay/:lang", async (req, res) => {
  try {
    const lang = (req.params.lang || "en").toLowerCase();
    const tgId = (req.query.tg_id || "").toString().trim();

    const code = PAYMENT_LINKS[lang];
    if (!code) {
      return res.status(400).send(`Unknown language: ${lang}`);
    }

    // базовая ссылка Payment Link
    const base = `https://buy.stripe.com/${code}`;

    // добавляем client_reference_id (сюда кладём tg_id) и локаль
    const params = new URLSearchParams();
    if (tgId) params.append("client_reference_id", tgId);
    const locale = LOCALE[lang];
    if (locale) params.append("locale", locale);

    const url = params.toString() ? `${base}?${params.toString()}` : base;

    console.log("→ /pay:", { lang, tgId, redirect: url });
    return res.redirect(302, url);
  } catch (e) {
    console.error("PAY error:", e);
    return res.status(500).send("PAY error");
  }
});

// ---------- STRIPE WEBHOOK ----------
app.post("/webhook", async (req, res) => {
  let event;
  try {
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("❌ Stripe signature verify failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log("➡️ Stripe event:", event.type);

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const s = event.data.object;
        const tgId = s.client_reference_id || null; // вот тут получаем то, что передали из /pay
        const email =
          s?.customer_details?.email ||
          s?.customer_email ||
          null;

        console.log("checkout.session.completed:", { tgId, email });

        // здесь можно дернуть BotHelp по tgId (если у тебя в BotHelp есть кастомное поле)
        // или по email (если это уже налажено). Я оставляю лог, чтобы не ломать.
        break;
      }

      case "invoice.payment_succeeded": {
        const inv = event.data.object;
        // tgId в инвойсе чаще всего нет — он на сессии. Можно поднять из metadata, если будешь класть.
        const email = inv?.customer_email || inv?.customer_details?.email || null;
        console.log("invoice.payment_succeeded:", { email });
        break;
      }

      case "invoice.payment_failed":
      case "customer.subscription.deleted": {
        const obj = event.data.object;
        const email = obj?.customer_email || obj?.customer_details?.email || null;
        console.log(`${event.type}:`, { email });
        break;
      }

      default:
        // просто логируем остальные
        break;
    }
  } catch (e) {
    console.error("Webhook handler error:", e);
  }

  // (опционально) пробрасываем весь ивент в старый вебхук BotHelp
  if (BOTHELP_WEBHOOK_URL) {
    fetch(BOTHELP_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    })
      .then(r => console.log("→ forwarded to BotHelp webhook:", r.status))
      .catch(e => console.error("→ BotHelp forward error:", e));
  }

  res.json({ received: true });
});

// ---------- RUN ----------
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server listening on ${port}`);
});
