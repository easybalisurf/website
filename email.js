// email.js — client-facing transactional emails via Resend.
const fetch = require('node-fetch');

async function sendEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL || 'hello@easybali.surf';
  if (!apiKey) { console.log('⚠️ RESEND_API_KEY not set — skipping email:', subject); return; }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html })
  });
  if (!res.ok) console.error('Resend send failed:', await res.text());
}

function bookingConfirmedEmail(order) {
  return sendEmail(
    order.client_email,
    'Your EasyBali.surf session is confirmed',
    `<p>Hi ${order.client_name},</p><p>Your ${order.sport_type} session (booking #${order.id}) is confirmed — your coach will reach out on WhatsApp with the exact meeting point.</p>`
  );
}

function reminder2hEmail(order, sessionTime) {
  return sendEmail(
    order.client_email,
    'Your session starts in 2 hours',
    `<p>Hi ${order.client_name},</p><p>Just a reminder — your ${order.sport_type} session is coming up at ${sessionTime}. See you in the water!</p>`
  );
}

function followUpEmail(order) {
  return sendEmail(
    order.client_email,
    'How was your session with EasyBali.surf?',
    `<p>Hi ${order.client_name},</p><p>Thanks for riding with us! We'd love to hear how it went — and if you're up for another session, we're always here.</p>`
  );
}

function depositRefundedEmail(order) {
  return sendEmail(
    order.client_email,
    'Your EasyBali.surf deposit has been refunded',
    `<p>Hi ${order.client_name},</p><p>We couldn't match your booking #${order.id} with a coach in time, so your $${order.deposit_price} deposit has been refunded via ${order.deposit_payment_method}. Sorry for the inconvenience — feel free to try another time window.</p>`
  );
}

module.exports = { sendEmail, bookingConfirmedEmail, reminder2hEmail, followUpEmail, depositRefundedEmail };
