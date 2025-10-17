// server.js — Stripe ↔ BotHelp, привязка по Telegram ID (client_reference_id)

import express from 'express';
import bodyParser from 'body-parser';
import Stripe from 'stripe';
import fetch from 'node-fetch';

// ─── ENV ──────────────────────────────────────────────────────────────────────
// Stripe
const STRIPE_SECRET_KEY      = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET  = process.env.STRIPE_WEBHOOK_SECRET;

// BotHelp OpenAPI base: используем именно https://openapi.bothelp.io (без /api)
const BOTHELP_API_BASE       = (process.env.BOTHELP_API_BASE || ' https://openapi.bothelp.io').trim();
const BOTHELP_CLIENT_ID      = process.env.BOTHELP_CLIENT_ID;
const BOTHELP_CLIENT_SECRET  = process.env.BOTHELP_CLIENT_SECRET;

// Тег, который ставим активным подписчикам в BotHelp
const BOTHELP_TAG            = process.env.BOTHELP_TAG || 'sub_active';

// (опционально) старый форвард вебхука в BotHelp, если вдруг нужен
const BOTHELP_WEBHOOK_URL    = process.env.BOTHELP_WEBHOOK_URL || null;

// ─── Init SDKs ────────────────────────────────────────────────────────────────
const stripe = new Stripe(STRIPE_SECRET_KEY);

// ─── BotHelp OAuth2 (client_credentials) ─────────────────────────────────────
let bothelpToken = null;
let bothelpTokenExp = 0;

async function getBothelpToken() {
  const now = Date.now();
  if (bothelpToken && now < bothelpTokenExp - 60_000) return bothelpToken;

  // важный момент: OpenAPI ждёт x-www-form-urlencoded
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
    console.error('BotHelp token error:', resp.status, await resp.text());
    throw new Error('Cannot get BotHelp token');
  }

  const data = await resp.json();
  bothelpToken = data.access_token;
  bothelpTokenExp = Date.now() + (data.expires_in || 3600) * 1000;
  return bothelpToken;
}

// ─── BotHelp: поиск подписчика по Telegram ID ────────────────────────────────
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
      console.error('BotHelp search error:', resp.status, await resp.text());
      return null;
    }

    const data = await resp.json();
    return data?.items?.[0]?.id || null;
  } catch (e) {
    console.error('findSubscriberByTelegramId error:', e);
    return null;
  }
}

// ─── BotHelp: поставить/снять тег ────────────────────────────────────────────
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
      console.error('BotHelp tag error:', action, resp.status, await resp.text());
    } else {
      console.log(`BotHelp tag ${action} OK:`, subscriberId, tag);
    }
  } catch (e) {
    console.error('setBothelpTag failed:', e);
  }
}

// ─── Express server ──────────────────────────────────────────────────────────
const app = express();

// Stripe хочет «сырой» body ровно на /webhook (для подписи)
app.use('/webhook', bodyParser.raw({ type: 'application/json' }));
// а на остальные роуты обычный JSON
app.use(bodyParser.json());

app.get('/', (_req, res) => res.status(200).send('Stripe ↔ BotHelp proxy is up'));
app.get('/health', (_req, res) => res.status(200).send('OK'));

// ─── Stripe webhook handler ──────────────────────────────────────────────────
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

        // КЛЮЧЕВОЕ: достаём Telegram ID
        const tgId =
          s?.client_reference_id ||                 // что мы передаём в ссылке checkout
          s?.metadata?.telegram_id || null;         // на всякий случай дублируем в metadata

        console.log('checkout.session.completed tgId=', tgId);

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
        const inv = event.data.object;
        const tgId =
          inv?.client_reference_id ||
          inv?.metadata?.telegram_id ||
          inv?.lines?.data?.[0]?.price?.metadata?.telegram_id || null;

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
        const obj = event.data.object;
        const tgId =
          obj?.client_reference_id ||
          obj?.metadata?.telegram_id ||
          obj?.lines?.data?.[0]?.price?.metadata?.telegram_id || null;

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
        // Другие события можно просто логировать
        console.log('Unhandled event:', event.type);
    }
  } catch (e) {
    // Никогда не ломаем ответ Stripe — логируем и продолжаем
    console.error('Handler error:', e);
  }

  // (опционально) форвардим сырой event в ваш старый BotHelp webhook
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

// ─── run ─────────────────────────────────────────────────────────────────────
const port = process.env.PORT || 3000; // Render сам пробрасывает PORT
app.listen(port, () => console.log(`Server listening on ${port}`));
