import express from 'express';
import bodyParser from 'body-parser';
import Stripe from 'stripe';
import fetch from 'node-fetch';

const app = express();

app.use('/stripe/webhook', bodyParser.raw({ type: 'application/json' }));
app.use(bodyParser.json());

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const bothelpUrl = process.env.BOTHELP_WEBHOOK_URL;

app.get('/health', (_req, res) => res.status(200).send('OK'));

app.post('/stripe/webhook', (req, res) => {
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('❌ Signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('✅ Stripe event:', event.type);

  if (bothelpUrl) {
    fetch(bothelpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    })
    .then(r => console.log('→ Forwarded to BotHelp:', r.status))
    .catch(e => console.error('→ BotHelp forward error:', e));
  }

  res.json({ received: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server listening on ${port}`));
