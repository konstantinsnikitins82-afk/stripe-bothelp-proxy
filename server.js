import express from 'express';
import bodyParser from 'body-parser';
import Stripe from 'stripe';
import fetch from 'node-fetch';

// ===== BotHelp config (ENV) =====
const BOTHELP_API_BASE = process.env.BOTHELP_API_BASE || 'https://api.bothelp.io';
const BOTHELP_CLIENT_ID = process.env.BOTHELP_CLIENT_ID;
const BOTHELP_CLIENT_SECRET = process.env.BOTHELP_CLIENT_SECRET;
const BOTHELP_TAG = process.env.BOTHELP_TAG || 'sub_active';

// ===== Получение токена BotHelp =====
let bothelpToken = null;
let bothelpTokenExp = 0;

async function getBothelpToken() {
  const now = Date.now();
  if (bothelpToken && now < bothelpTokenExp - 60_000) return bothelpToken;

  const params = new URLSearchParams();
params.append('client_id', BOTHELP_CLIENT_ID);
params.append('client_secret', BOTHELP_CLIENT_SECRET);
params.append('grant_type', 'client_credentials');

const resp = await fetch(`${BOTHELP_API_BASE}/oauth/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: params
});
  if (!resp.ok) {
    console.error('BotHelp token error:', await resp.text());
    throw new Error('Cannot get BotHelp token');
  }
  const data = await resp.json();
  bothelpToken = data.access_token;
  bothelpTokenExp = Date.now() + (data.expires_in || 3600) * 1000;
  return bothelpToken;
}

// ===== Поиск подписчика по email (удобно с Payment Links) =====
async function findSubscriberByEmail(email) {
  try {
    const token = await getBothelpToken();
    const resp = await fetch(`${BOTHELP_API_BASE}/openapi/subscribers/search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    // верни первый найденный id (подправим если у вас другой формат ответа)
    return data?.items?.[0]?.id || null;
  } catch (e) {
    console.error('findSubscriberByEmail error', e);
    return null;
  }
}

// ===== Поставить/снять тег в BotHelp по subscriber_id =====
async function setBothelpTag({ subscriberId, tag, action }) {
  try {
    const token = await getBothelpToken();
    const url =
      action === 'add'
        ? `${BOTHELP_API_BASE}/openapi/subscribers/tags/add`
        : `${BOTHELP_API_BASE}/openapi/subscribers/tags/remove`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriber_id: subscriberId, tag })
    });

    if (!resp.ok) {
      console.error('BotHelp tag error:', action, await resp.text());
    } else {
      console.log(`BotHelp tag ${action} OK:`, subscriberId, tag);
    }
  } catch (e) {
    console.error('setBothelpTag failed:', e);
  }
}

const app = express();

app.use('/webhook', bodyParser.raw({ type: 'application/json' }));
app.use(bodyParser.json());

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
// const bothelpUrl = process.env.BOTHELP_WEBHOOK_URL;

app.get('/health', (_req, res) => res.status(200).send('OK'));

app.post('/webhook', async (req, res) => {
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('❌ Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('✅ Stripe event:', event.type);

  // === Обработка событий Stripe ===
switch (event.type) {
  case 'checkout.session.completed': {
    const s = event.data.object;
    const email = s?.customer_details?.email || s?.customer_email;
    console.log('checkout.session.completed email=', email);

    if (email) {
      const subId = await findSubscriberByEmail(email);
      if (subId) {
        await setBothelpTag({ subscriberId: subId, tag: BOTHELP_TAG, action: 'add' });
      } else {
        console.warn('BotHelp subscriber not found by email:', email);
      }
    }
    break;
  }

  case 'invoice.payment_succeeded': {
    const inv = event.data.object;
    const email = inv?.customer_email || inv?.customer_details?.email;
    console.log('invoice.payment_succeeded email=', email);
    if (email) {
      const subId = await findSubscriberByEmail(email);
      if (subId) {
        await setBothelpTag({ subscriberId: subId, tag: BOTHELP_TAG, action: 'add' });
      }
    }
    break;
  }

  case 'invoice.payment_failed':
  case 'customer.subscription.deleted': {
    const obj = event.data.object;
    const email = obj?.customer_email || obj?.customer_details?.email;
    console.log(`${event.type} email=`, email);
    if (email) {
      const subId = await findSubscriberByEmail(email);
      if (subId) {
        await setBothelpTag({ subscriberId: subId, tag: BOTHELP_TAG, action: 'remove' });
      }
    }
    break;
  }

  case 'customer.subscription.trial_will_end': {
    console.log('Trial will end soon');
    break;
  }

  default:
    console.log('Unhandled event:', event.type);
}


  //if (bothelpUrl) {
    //fetch(bothelpUrl, {
     // method: 'POST',
     //headers: { 'Content-Type': 'application/json' },
     // body: JSON.stringify(event)
   // })
   // .then(r => console.log('→ Forwarded to BotHelp:', r.status))
   // .catch(e => console.error('→ BotHelp forward error:', e));
//  }

  res.json({ received: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on ${port}`));
