const express = require('express');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const ATENAS_BASE_URL = process.env.ATENAS_BASE_URL || 'https://nexuspag.com';
const API_KEY = process.env.ATENAS_API_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';

const OFFERS = {
  QUEBRA_GALHO: { name: 'Quebra-Galho', amount: 9.90 },
  START: { name: 'Start', amount: 19.90 },
  PREMIUM: { name: 'Premium', amount: 29.90 },
  VIP: { name: 'VIP', amount: 49.90 }
};

app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); } }));
app.use(express.static(path.join(__dirname)));

function requireKey() {
  if (!API_KEY) throw new Error('ATENAS_API_KEY não configurada no servidor.');
}

async function atenasFetch(endpoint, options = {}) {
  requireKey();
  const response = await fetch(ATENAS_BASE_URL + endpoint, {
    ...options,
    headers: {
      'x-api-key': API_KEY,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) {
    const msg = data?.message || data?.error || `Atenas Pay respondeu HTTP ${response.status}`;
    const err = new Error(msg); err.status = response.status; throw err;
  }
  return data;
}

app.post('/api/create-payment', async (req, res) => {
  try {
    const { plan } = req.body || {};
    const offer = OFFERS[plan];
    if (!offer) return res.status(400).json({ error: 'Oferta inválida.' });

    const externalId = `bruna-${plan.toLowerCase()}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const webhookUrl = process.env.PUBLIC_BASE_URL
      ? `${process.env.PUBLIC_BASE_URL.replace(/\/$/, '')}/api/webhooks/atenas`
      : undefined;

    const payload = {
      amount: offer.amount,
      description: `Bruna Camila - ${offer.name}`,
      external_id: externalId,
      expiration: Number(process.env.PIX_EXPIRATION || 1800)
    };
    if (webhookUrl) payload.webhook_url = webhookUrl;

    const data = await atenasFetch('/api/pix/create', {
      method: 'POST', body: JSON.stringify(payload)
    });

    // A API atual retorna os dados da cobrança dentro de `transaction`.
    // Mantemos compatibilidade caso algum ambiente antigo retorne os campos no nível raiz.
    const tx = data?.transaction || data;
    if (!tx?.id || !tx?.pix_copia_cola || !tx?.qr_code_base64) {
      console.error('Resposta inesperada da Atenas Pay:', JSON.stringify(data));
      return res.status(502).json({ error: 'A Atenas Pay não retornou os dados completos do PIX.' });
    }

    res.status(201).json({
      id: tx.id,
      txid: tx.txid,
      external_id: tx.external_id || externalId,
      amount: tx.amount || offer.amount,
      status: tx.status || 'pending',
      pix_copia_cola: tx.pix_copia_cola,
      qr_code_base64: tx.qr_code_base64,
      expires_at: tx.expires_at
    });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'Erro ao criar PIX.' });
  }
});

app.get('/api/payment/:id', async (req, res) => {
  try {
    const data = await atenasFetch(`/api/pix/${encodeURIComponent(req.params.id)}`);
    res.json({
      id: data.id,
      external_id: data.external_id,
      status: data.status,
      amount: data.amount,
      paid_at: data.paid_at,
      expires_at: data.expires_at
    });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'Erro ao consultar PIX.' });
  }
});

function validWebhook(req) {
  if (!WEBHOOK_SECRET) return true;
  const signature = req.headers['x-webhook-signature'];
  if (!signature || !req.rawBody) return false;
  const fields = Object.fromEntries(signature.split(',').map(part => part.split('=')));
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET)
    .update(`${fields.t}.${req.rawBody}`).digest('hex');
  const received = fields.v1 || '';
  if (received.length !== expected.length) return false;
  const fresh = Math.abs(Date.now() / 1000 - Number(fields.t)) <= 300;
  return fresh && crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

app.post('/api/webhooks/atenas', (req, res) => {
  try {
    if (!validWebhook(req)) return res.status(401).json({ error: 'Assinatura inválida.' });
    console.log('Atenas Pay webhook:', req.headers['x-webhook-event'], req.body);
    return res.sendStatus(200);
  } catch (err) {
    console.error(err);
    return res.sendStatus(500);
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Bruna Camila site rodando na porta ${PORT}`);
  if (!API_KEY) console.warn('ATENÇÃO: ATENAS_API_KEY não configurada.');
});
