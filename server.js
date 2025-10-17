// server.js
import express from 'express';
import bodyParser from 'body-parser';
import Stripe from 'stripe';
import fetch from 'node-fetch';

/* ================= ENV ================= */
const STRIPE_SECRET_KEY      = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET  = process.env.STRIPE_WEBHOOK_SECRET;

// Хост OpenAPI без лишних префиксов:
const BOTHELP_API_BASE       = (process.env.BOTHELP_API_BASE || ' https://openapi.bothelp.io').trim();
const BOTHELP_CLIENT_ID      = process.env.BOTHELP_CLIENT_ID;
const BOTHELP_CLIENT_SECRET  = process.env.BOTHELP_CLIENT_SECRET;

// Тег активной подписки в BotHelp
const BOTHELP_TAG            = process.env.BOTHELP_TAG || 'sub_active';

/* ================ Stripe ================ */
const stripe = new Stripe(STRIPE_SECRET_KEY);

/* ===== BotHelp OAuth2 (client_credentials) ===== */
let bothelpToken = null;
let bothelpTokenExp = 0;

async function getBothelpToken() {
  const now = Date.now();
  if (bothelpToken && now < bothelpTokenExp - 60_000) return bothelpToken;

  const params = new URLSearchParams();
  params.append('client_id', BOTHELP_CLIENT_ID);
  params.append('client_secret', BOTHELP_CLIENT_SECRET);
  params.append('grant_type', 'client_credentials');

  // Важно: токен берём по /oauth/token на том же хосте
  const resp = await fetch(`${BOTHELP_API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  if (!resp.ok) {
    console.error('BotHelp token error:', resp.status, await resp.text());
    throw new Error('Cannot get BotHelp token');
  }

  const data = await resp.json();
  bothelpToken = data.access_token;
  bothelpTokenExp = Date.now() + (data.expires_in || 3600) * 1000;
  console.log('✅ BotHelp token OK');
  return bothelpToken;
}

/* ===== Поиск подписчика по email ===== */
async function findSubscriberByEmail(email) {
  if (!email) return null;
  try {
    const token = await getBothelpToken();
    // Важно: без /openapi в пути, т.к. уже на поддомене openapi.*
    const resp = await fetch(`${BOTHELP_API_BASE}/subscribers/search`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ email })
    });

    if (!resp.ok) {
      console.error('BotHelp search error:', resp.status, await resp.text());
      return null;
    }
    const data = await resp.json();
    return data?.items?.[0]?.id || null;
  } catch (e) {
    console.error('findSubscriberByEmail error:', e);
    return null;
  }
}

/* ===== Поставить/снять тег ===== */
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
      console.log(`✅ BotHelp tag ${action} OK:`, subscriberId, tag);
    }
  } catch (e) {
    console.error('setBothelpTag failed:', e);
  }
}

/* ================ Server ================ */
const app = express();

// raw body только на /webhook (для проверки подписи Stripe)
app.use('/webhook', bodyParser.raw({ type: 'application/json' }));
// JSON для остальных маршрутов
app.use(bodyParser.json());

app.get('/health', (_req, res) => res.status(200).send('OK'));

/* ===== Stripe webhook ===== */
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
        const email = s?.customer_details?.email || s?.customer_email || null;
        console.log('checkout.session.completed email =', email);

        const subId = await findSubscriberByEmail(email);
        if (subId) await setBothelpTag({ subscriberId: subId, tag: BOTHELP_TAG, action: 'add' });
        else console.warn('BotHelp subscriber not found by email:', email);
        break;
      }

      case 'invoice.payment_succeeded': {
        const inv = event.data.object;
        const email = inv?.customer_email || inv?.customer_details?.email || null;
        console.log('invoice.payment_succeeded email =', email);

        const subId = await findSubscriberByEmail(email);
        if (subId) await setBothelpTag({ subscriberId: subId, tag: BOTHELP_TAG, action: 'add' });
        break;
      }

      case 'invoice.payment_failed':
      case 'customer.subscription.deleted': {
        const obj = event.data.object;
        const email = obj?.customer_email || obj?.customer_details?.email || null;
        console.log(`${event.type} email =`, email);

        const subId = await findSubscriberByEmail(email);
        if (subId) await setBothelpTag({ subscriberId: subId, tag: BOTHELP_TAG, action: 'remove' });
        break;
      }

      case 'customer.subscription.trial_will_end':
        console.log('Trial will end soon');
        break;

      default:
        console.log('Unhandled event:', event.type);
    }
  } catch (e) {
    // не ломаем ответ Stripe — просто логируем
    console.error('Handler error:', e);
  }

  res.json({ received: true });
});

/* ===== Run ===== */
const port = process.env.PORT || 10000; // Render пробрасывает порт в PORT
app.listen(port, () => console.log(`Server listening on ${port}`));
