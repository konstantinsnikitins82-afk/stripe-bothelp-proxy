// server.js
import express from 'express';
import bodyParser from 'body-parser';
import Stripe from 'stripe';
import fetch from 'node-fetch';

// ========== ENV ==========
const STRIPE_SECRET_KEY      = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET  = process.env.STRIPE_WEBHOOK_SECRET;

// BotHelp OpenAPI
// ВАЖНО: базу оставляем как https://openapi.bothelp.io
// А пути используем с префиксом /openapi/...
const BOTHELP_API_BASE       = (process.env.BOTHELP_API_BASE || ' https://openapi.bothelp.io').trim();
const BOTHELP_CLIENT_ID      = process.env.BOTHELP_CLIENT_ID;
const BOTHELP_CLIENT_SECRET  = process.env.BOTHELP_CLIENT_SECRET;

// Тег, который ставим активным подписчикам
const BOTHELP_TAG            = process.env.BOTHELP_TAG || 'sub_active';

// ========== Sanity checks ==========
if (!STRIPE_SECRET_KEY)      console.warn('⚠️  Missing STRIPE_SECRET_KEY');
if (!STRIPE_WEBHOOK_SECRET)  console.warn('⚠️  Missing STRIPE_WEBHOOK_SECRET');
if (!BOTHELP_CLIENT_ID)      console.warn('⚠️  Missing BOTHELP_CLIENT_ID');
if (!BOTHELP_CLIENT_SECRET)  console.warn('⚠️  Missing BOTHELP_CLIENT_SECRET');

const stripe = new Stripe(STRIPE_SECRET_KEY);

// ========== BotHelp OAuth2 (client_credentials) ==========
let bothelpToken = null;
let bothelpTokenExp = 0;

async function getBothelpToken() {
  const now = Date.now();
  if (bothelpToken && now < bothelpTokenExp - 60_000) return bothelpToken;

  // BotHelp ожидает application/x-www-form-urlencoded
  const params = new URLSearchParams();
  params.append('client_id', BOTHELP_CLIENT_ID);
  params.append('client_secret', BOTHELP_CLIENT_SECRET);
  params.append('grant_type', 'client_credentials');

  const tokenUrl = `${BOTHELP_API_BASE}/openapi/oauth/token`;
  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  if (!resp.ok) {
    const txt = await resp.text();
    console.error('❌ BotHelp token error:', resp.status, txt);
    throw new Error('Cannot get BotHelp token');
  }

  const data = await resp.json();
  bothelpToken = data.access_token;
  bothelpTokenExp = Date.now() + (data.expires_in || 3600) * 1000;
  console.log('✅ BotHelp token OK');
  return bothelpToken;
}

// Поиск подписчика по email
async function findSubscriberByEmail(email) {
  try {
    const token = await getBothelpToken();
    const resp = await fetch(`${BOTHELP_API_BASE}/openapi/v1/subscribers/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email })
    });

    const text = await resp.text();
    let data;

    try {
      data = JSON.parse(text);
    } catch {
      console.error('❌ BotHelp API returned non-JSON response:', text.slice(0, 200));
      return null;
    }

    if (!resp.ok) {
      console.error('BotHelp search error:', resp.status, data);
      return null;
    }

    return data?.items?.[0]?.id || null;
  } catch (e) {
    console.error('findSubscriberByEmail error', e);
    return null;
  }
}

// Поставить/снять тег у подписчика
async function setBothelpTag({ subscriberId, tag, action }) {
  if (!subscriberId) return;
  try {
    const token = await getBothelpToken();
    const url =
      action === 'add'
        ? `${BOTHELP_API_BASE}/openapi/subscribers/tags/add`
        : `${BOTHELP_API_BASE}/openapi/subscribers/tags/remove`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ subscriber_id: String(subscriberId), tag })
    });

    if (!resp.ok) {
      const txt = await resp.text();
      console.error('❌ BotHelp tag error:', action, resp.status, txt);
    } else {
      console.log(`✅ BotHelp tag ${action} OK:`, subscriberId, tag);
    }
  } catch (e) {
    console.error('setBothelpTag failed:', e);
  }
}

// ========== Server ==========
const app = express();

// raw body ТОЛЬКО на /webhook (для проверки подписи Stripe)
app.use('/webhook', bodyParser.raw({ type: 'application/json' }));
// обычный json на всё остальное
app.use(bodyParser.json());

// healthcheck
app.get('/health', (_req, res) => res.status(200).send('OK'));

// Stripe webhook
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
        const email = s?.customer_details?.email || s?.customer_email || s?.customer?.email;
        console.log('checkout.session.completed email =', email);

        const subId = await findSubscriberByEmail(email);
        if (subId) {
          await setBothelpTag({ subscriberId: subId, tag: BOTHELP_TAG, action: 'add' });
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const inv = event.data.object;
        const email = inv?.customer_email || inv?.customer_details?.email;
        console.log('invoice.payment_succeeded email =', email);

        const subId = await findSubscriberByEmail(email);
        if (subId) {
          await setBothelpTag({ subscriberId: subId, tag: BOTHELP_TAG, action: 'add' });
        }
        break;
      }

      case 'invoice.payment_failed':
      case 'customer.subscription.deleted': {
        const obj = event.data.object;
        const email = obj?.customer_email || obj?.customer_details?.email;
        console.log(`🚫 ${event.type} — subscription canceled or payment failed. Email:`, email);

        const subId = await findSubscriberByEmail(email);
        if (subId) {
          await setBothelpTag({ subscriberId: subId, tag: BOTHELP_TAG, action: 'remove' });
          console.log(`❌ Tag "${BOTHELP_TAG}" removed — user access revoked.`);
        } else {
          console.warn('⚠️ BotHelp subscriber not found for removal:', email);
        }
        break;
      }

      case 'customer.subscription.trial_will_end': {
        console.log('ℹ️ Trial will end soon');
        break;
      }

      default:
        console.log('ℹ️ Unhandled event:', event.type);
    }
  } catch (e) {
    // не ломаем ответ Stripe — логируем и продолжаем
    console.error('Handler error:', e);
  }

  res.json({ received: true });
});

// run
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on ${port}`));
