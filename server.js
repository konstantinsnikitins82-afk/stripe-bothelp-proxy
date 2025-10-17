// server.js — Costa Online Fit Club
// Stripe ↔ BotHelp интеграция с привязкой по Telegram ID + редирект на 6 языков

import express from 'express';
import bodyParser from 'body-parser';
import Stripe from 'stripe';
import fetch from 'node-fetch';

// ───────────────────────── ENV ─────────────────────────
// Stripe
const STRIPE_SECRET_KEY     = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// BotHelp OpenAPI
const BOTHELP_API_BASE      = (process.env.BOTHELP_API_BASE || ' https://openapi.bothelp.io').trim(); // без хвостов
const BOTHELP_CLIENT_ID     = process.env.BOTHELP_CLIENT_ID;
const BOTHELP_CLIENT_SECRET = process.env.BOTHELP_CLIENT_SECRET;
const BOTHELP_TAG           = process.env.BOTHELP_TAG || 'sub_active';

// (опционально) старый форвард вебхука
const BOTHELP_WEBHOOK_URL   = process.env.BOTHELP_WEBHOOK_URL || null;

// Payment Links по языкам (обязательно задайте в Render → Environment)
const LINKS = {
  it: process.env.IT_LINK, // https://buy.stripe.com/...
  en: process.env.EN_LINK,
  ru: process.env.RU_LINK,
  es: process.env.ES_LINK,
  fr: process.env.FR_LINK,
  lv: process.env.LV_LINK,
};

// ───────────────────────── INIT ────────────────────────
if (!STRIPE_SECRET_KEY)     console.warn('⚠️  STRIPE_SECRET_KEY is not set');
if (!STRIPE_WEBHOOK_SECRET) console.warn('⚠️  STRIPE_WEBHOOK_SECRET is not set');
if (!BOTHELP_CLIENT_ID || !BOTHELP_CLIENT_SECRET) console.warn('⚠️  BOTHELP CLIENT credentials are not set');

const stripe = new Stripe(STRIPE_SECRET_KEY);
const app = express();

// Stripe требует raw body ровно на /webhook
app.use('/webhook', bodyParser.raw({ type: 'application/json' }));
// остальное — обычный JSON
app.use(bodyParser.json());

// ─────────────────── BotHelp OAuth2 token ──────────────────
let bothelpToken = null;
let bothelpTokenExp = 0;

async function getBothelpToken() {
  const now = Date.now();
  if (bothelpToken && now < bothelpTokenExp - 60_000) return bothelpToken;

  const form = new URLSearchParams();
  form.append('client_id', BOTHELP_CLIENT_ID);
  form.append('client_secret', BOTHELP_CLIENT_SECRET);
  form.append('grant_type', 'client_credentials');

  const resp = await fetch(`${BOTHELP_API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    console.error('BotHelp token error:', resp.status, t);
    throw new Error('Cannot get BotHelp token');
  }

  const data = await resp.json();
  bothelpToken = data.access_token;
  bothelpTokenExp = Date.now() + (data.expires_in || 3600) * 1000;
  return bothelpToken;
}

// ───────────── BotHelp helpers (поиск/теги по tgId) ─────────────
async function findSubscriberByTelegramId(tgId) {
  if (!tgId) return null;
  try {
    const token = await getBothelpToken();
    const resp = await fetch(`${BOTHELP_API_BASE}/subscribers/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ telegram_id: String(tgId) })
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      console.error('BotHelp search error:', resp.status, t);
      return null;
    }
    const data = await resp.json();
    return data?.items?.[0]?.id || null;
  } catch (e) {
    console.error('findSubscriberByTelegramId error:', e);
    return null;
  }
}

async function setBothelpTag({ subscriberId, tag, action }) {
  if (!subscriberId) return;
  try {
    const token = await getBothelpToken();
    const url =
      action === 'add'
        ? `${BOTHELP_API_BASE}/subscribers/tags/add`
        : `${BOTHELP_API_BASE}/subscribers/tags/remove`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ subscriber_id: subscriberId, tag })
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      console.error('BotHelp tag error:', action, resp.status, t);
    } else {
      console.log(`✅ BotHelp tag ${action} OK:`, subscriberId, tag);
    }
  } catch (e) {
    console.error('setBothelpTag failed:', e);
  }
}

// ──────────────────── Утилита: достать tgId ───────────────────
async function getTgFromObject(obj) {
  // 1) Прямые места
  const direct =
    obj?.client_reference_id ||
    obj?.metadata?.telegram_id ||
    obj?.lines?.data?.[0]?.price?.metadata?.telegram_id ||
    null;
  if (direct) return String(direct);

  // 2) Из Customer.metadata (после того как мы сохраним туда tgId в checkout.session.completed)
  const customerId = obj?.customer || obj?.customer_id || null;
  if (customerId) {
    try {
      const customer = await stripe.customers.retrieve(customerId);
      return customer?.metadata?.telegram_id || null;
    } catch (e) {
      console.error('getTgFromObject: fetch customer failed', e);
    }
  }
  return null;
}

// ─────────────────────── Health ────────────────────────
app.get('/', (_req, res) => res.status(200).send('Stripe ↔ BotHelp proxy is up'));
app.get('/health', (_req, res) => res.status(200).send('OK'));

// ─────────────── Редирект на Stripe (6 языков) ───────────────
app.get('/pay/:lang', (req, res) => {
  const { lang } = req.params; // it|en|ru|es|fr|lv
  const { tg_id } = req.query;
  const base = LINKS[lang];

  if (!base)  return res.status(400).send('Unknown language');
  if (!tg_id) return res.status(400).send('tg_id required');

  const url = `${base}?client_reference_id=${encodeURIComponent(tg_id)}&locale=${encodeURIComponent(lang)}`;
  return res.redirect(302, url);
});

// ───────────────────── Stripe Webhook ─────────────────────
app.post('/webhook', async (req, res) => {
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('❌ Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('➡️  Stripe event:', event.type);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;

        const tgId =
          s?.client_reference_id ||
          s?.metadata?.telegram_id ||
          null;

        console.log('checkout.session.completed tgId=', tgId);

        // Сохраняем tgId в Customer.metadata (важно для дальнейших событий)
        try {
          if (tgId && s?.customer) {
            await stripe.customers.update(s.customer, {
              metadata: { telegram_id: String(tgId) }
            });
            console.log('Saved telegram_id to customer metadata');
          }
        } catch (e) {
          console.error('Failed to save tg to customer:', e);
        }

        // Ставим тег доступа в BotHelp
        if (tgId) {
          const subId = await findSubscriberByTelegramId(tgId);
          if (subId) {
            await setBothelpTag({ subscriberId: subId, tag: BOTHELP_TAG, action: 'add' });
          } else {
            console.warn('BotHelp subscriber not found by tgId:', tgId);
          }
        } else {
          console.warn('No client_reference_id / telegram_id in session');
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        // Можно продублировать "add" (если нужно подтверждать продления)
        const inv = event.data.object;
        const tgId = await getTgFromObject(inv);
        console.log('invoice.payment_succeeded tgId=', tgId);
        if (tgId) {
          const subId = await findSubscriberByTelegramId(tgId);
          if (subId) {
            await setBothelpTag({ subscriberId: subId, tag: BOTHELP_TAG, action: 'add' });
          }
        }
        break;
      }

      case 'invoice.payment_failed':
      case 'customer.subscription.deleted': {
        // Удаляем доступ при неуспехе/отписке
        const obj = event.data.object;
        const tgId = await getTgFromObject(obj);
        console.log(`${event.type} tgId=`, tgId);
        if (tgId) {
          const subId = await findSubscriberByTelegramId(tgId);
          if (subId) {
            await setBothelpTag({ subscriberId: subId, tag: BOTHELP_TAG, action: 'remove' });
          }
        }
        break;
      }

      case 'customer.subscription.trial_will_end':
        console.log('Trial will end soon');
        break;

      default:
        // прочие события просто логируем
        console.log('Unhandled event:', event.type);
    }
  } catch (e) {
    // Никогда не роняем ответ Stripe — логируем и продолжаем
    console.error('Handler error:', e);
  }

  // (опционально) форвард сырого события в дополнительный webhook
  if (BOTHELP_WEBHOOK_URL) {
    fetch(BOTHELP_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    })
      .then(r => console.log('→ Forwarded to BotHelp webhook:', r.status))
      .catch(e => console.error('→ BotHelp forward error:', e));
  }

  res.json({ received: true });
});

// ───────────────────── run ─────────────────────
const port = process.env.PORT || 3000; // Render сам задаёт PORT
app.listen(port, () => console.log(`Server listening on ${port}`));

