# EasyBali.surf — Admin/Instructor Bot

Telegram bot for reviewing incoming bookings, dispatching them to the instructors
group, tracking instructor response times, ratings, and deposit refunds.

Companion to the client-facing booking bot (separate service) — this bot never
talks to end clients directly, only to super_admin / admin / instructor accounts.

## Roles
- **super_admin** — full access: edit/delete any order, manage admins & instructors
  (add/remove, edit roster data by hand), reset instructor ratings, approve
  cancellations with deposit refund, see all-time financials.
- **admin** — review incoming orders, send to the instructors group, edit an
  order's date/time/add-ons/status, see every order + its status and which
  instructor took it, see instructor earnings. Cannot delete users, change
  ratings, or issue a refund/cancel.
- **instructor** — added by super_admin (or self-registers gear/level/languages,
  super_admin just flips `is_active`). Sees the group card, can take an eligible
  order, sees their own taken/completed orders, can request a change (pings admins).

## Order lifecycle
`pending_review` → (admin/super_admin sends to group) → `in_group` →
(eligible instructor taps Take) → `taken` → (instructor taps the WhatsApp button
within 5 min) → `confirmed` → `completed`.

Dead ends: `in_group` with no takers for 3h → `deposit_refund_pending` (removed
from the group). `taken` with no WhatsApp click within 5 min → strike on the
instructor, order bounces back to `in_group`; after repeated bounces it's flagged
`needs_admin_assignment` for manual handling instead of looping forever.

## Setup
1. Create the bot via @BotFather, get `ADMIN_BOT_TOKEN`.
2. Copy `.env.example` → set real values (Railway → Variables in production).
3. `npm install`
4. `npm start`

## Booking intake
The booking form / client bot backend POSTs new orders to:
`POST /webhook/booking` with header `X-Booking-Secret: <BOOKING_WEBHOOK_SECRET>`
(same header name and shared-secret pattern as the reference ski-school form/bot).

Payload is the exact shape the reference booking form's `sendToBot`/`botData` and the
client Telegram bot's post-payment `order` object already send — no changes needed on
their end, plus two additive fields for the instructor-pay split:
```json
{
  "bookingId": "BK...", "fullName": "...", "phone": "...", "email": "...", "age": 29,
  "skillLevel": "beginner", "preferredLanguage": "english", "additionalInfo": "...",
  "sport": "surf", "participants": 2,
  "sessions": [{ "date": "2026-08-01", "timeWindow": "10:00 – 12:00", "spot": "Batu Bolong" }],
  "sessionPrice": 176,
  "addonsBreakdown": [
    { "label": "Photo + video + drone footage & edit", "amount": 200 },
    { "label": "Rental equipment ×2", "amount": 40 }
  ],
  "total": 416, "deposit": 83,
  "paymentStatus": "COMPLETED", "payerEmail": "...",
  "paymentId": "...", "paymentProvider": "paypal"
}
```
`sessionPrice` must be the coaching-only line (no add-ons) — the instructor's 80% cut is
computed from THIS number, never from `total`, so rental/media/transfer pass-through costs
never inflate what they're paid. If `sessionPrice` is omitted, it's backed out as
`total - sum(addonsBreakdown.amount)`, but sending it explicitly is safer than relying on
that fallback. `addonsBreakdown` is shown to the instructor as a separate line-item list
(both in their private order message and, generalized with no client PII, on the group
card) purely for their information — it's never included in the earnings figure.

`sessions` also accepts the ski-form's older `selectedDates: [{date,time}]` shape and
normalizes it. See `db.js` → `normalizeBookingPayload` for the exact field mapping
(including the `preferredLanguage` → short-code translation used for instructor matching).
