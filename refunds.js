// refunds.js — deposit refund handling.
// PayPal: automatic, via REST API (needs a real capture id stored at deposit-payment time).
// Crypto (NOWPayments/CryptoBot etc.): NOT automated here — most crypto refunds require
// manual review anyway (unclear which txid to send back to, network fees, etc.), so we
// just surface a clear "manual refund needed" task to the super_admin with all the details
// they need (amount, method, payment ref) instead of guessing at an API call.

const fetch = require('node-fetch');

async function getPayPalAccessToken() {
  const id = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET;
  const base = process.env.PAYPAL_API_BASE || 'https://api-m.paypal.com';
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const data = await res.json();
  if (!res.ok) throw new Error('PayPal auth failed: ' + JSON.stringify(data));
  return data.access_token;
}

// captureId = the PayPal capture id stored in orders.deposit_payment_ref at checkout time.
async function refundPayPalDeposit(captureId, amountUsd) {
  const base = process.env.PAYPAL_API_BASE || 'https://api-m.paypal.com';
  const token = await getPayPalAccessToken();
  const res = await fetch(`${base}/v2/payments/captures/${captureId}/refund`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: { value: amountUsd.toFixed(2), currency_code: 'USD' } })
  });
  const data = await res.json();
  if (!res.ok) throw new Error('PayPal refund failed: ' + JSON.stringify(data));
  return data; // { id, status: 'COMPLETED', ... }
}

// Returns { auto: true, result } if refunded automatically, or { auto: false } if it
// needs a human to action it (crypto, or PayPal call failed).
async function processDepositRefund(order) {
  if (order.deposit_payment_method === 'paypal' && order.deposit_payment_ref) {
    try {
      const result = await refundPayPalDeposit(order.deposit_payment_ref, order.deposit_price);
      return { auto: true, result };
    } catch (e) {
      console.error('Auto PayPal refund failed, falling back to manual:', e.message);
      return { auto: false, error: e.message };
    }
  }
  return { auto: false }; // crypto — always manual
}

module.exports = { processDepositRefund, refundPayPalDeposit };
