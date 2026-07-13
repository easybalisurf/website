// index.js — EasyBali.surf admin/instructor bot.
// Talks Telegram (Telegraf) to admins/instructors, and HTTP (Express) to the
// booking form / client-bot backend for order intake + WhatsApp-click tracking.

const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const db = require('./db');
const { t } = require('./i18n');
const time = require('./time');
const { processDepositRefund } = require('./refunds');
const email = require('./email');

function requireEnv(name) {
  const v = process.env[name];
  if (!v) { console.error(`❌ Missing required env var: ${name}`); process.exit(1); }
  return v;
}

const BOT_TOKEN = requireEnv('ADMIN_BOT_TOKEN');
const INSTRUCTORS_GROUP_ID = requireEnv('INSTRUCTORS_GROUP_ID');
const BOOKING_WEBHOOK_SECRET = requireEnv('BOOKING_WEBHOOK_SECRET');
const PUBLIC_BASE_URL = requireEnv('PUBLIC_BASE_URL');

const bot = new Telegraf(BOT_TOKEN);
bot.catch((err) => console.error('❌ Bot error:', err));

const conversationState = new Map(); // per-admin multi-step flows (add instructor, edit order, etc.)

// ============================================================
// HELPERS
// ============================================================

const SPORT_EMOJI = { surf: '🏄', kite: '🪁', wing: '🌬️', sup: '🧘' };
const POOL_WINDOW_MIN = 3 * 60;   // 3h unclaimed in the group → refund path
const WHATSAPP_WINDOW_MIN = 5;    // 5min to message the client after taking
const MAX_BOUNCES = 3;            // after this many kicks-back, escalate instead of resending

function instructorEarnings(order) { return Math.round(order.session_price * 0.8); }

// Order-card body copy — translated by the VIEWER's language, passed in explicitly since
// an order has no language of its own (client-facing labels like "Sessions"/"Status" are
// chrome around the data, same idea as the menu/button strings in i18n.js).
const CARD = {
  en: { sessions: 'Sessions', addons: 'Add-ons', addonsClientPaid: 'Add-ons (client-paid, not part of your cut)', addonsSubtotal: 'add-ons subtotal', mediaDates: 'Shoot days', clientPrefers: 'Client prefers', level: 'Level', language: 'Language', yourEarnings: 'Your earnings', yourEarnings80: 'Your earnings (80% of session price)', yourEarnings80Only: 'Your earnings (80% of session price only)', sessionPrice: 'Session price', total: 'Total (incl. add-ons)', deposit: 'Deposit', paid: 'paid', unpaid: 'UNPAID', status: 'Status', instructor: 'Instructor', messageClientReminder: 'Message the client on WhatsApp within 5 minutes.' },
  ru: { sessions: 'Занятия', addons: 'Допы', addonsClientPaid: 'Допы (оплачивает клиент, не входит в ваш %)', addonsSubtotal: 'итого по допам', mediaDates: 'Дни съёмки', clientPrefers: 'Клиент предпочитает', level: 'Уровень', language: 'Язык', yourEarnings: 'Ваш заработок', yourEarnings80: 'Ваш заработок (80% от цены занятия)', yourEarnings80Only: 'Ваш заработок (только 80% от цены занятия)', sessionPrice: 'Цена занятия', total: 'Итого (с допами)', deposit: 'Депозит', paid: 'оплачен', unpaid: 'НЕ ОПЛАЧЕН', status: 'Статус', instructor: 'Инструктор', messageClientReminder: 'Напишите клиенту в WhatsApp в течение 5 минут.' }
};
function c(lang, key) { return (CARD[lang] && CARD[lang][key]) || CARD.en[key]; }

// Small extra strings not worth a full i18n.js entry — admin/super_admin management
// screens (Admins/Instructors CRUD) stay English-only since that's internal ops tooling;
// anything an instructor sees (Pending/All/My orders empty states) is translated here.
const MISC = {
  en: {
    nothing_pending: '📭 Nothing pending.', no_orders: '📭 No orders yet.', no_my_orders: '📭 You have no orders yet.',
    finances_title: 'All-time finances', active_orders: 'Active/completed orders', gross_revenue: 'Gross revenue', deposits_collected: 'Deposits collected', refunded_pending: 'Refunded/pending refund',
    your_earnings_title: 'Your earnings', orders_word: 'Orders', earnings_total: 'Total (80% of session price, excl. add-ons)',
    instructor_earnings_title: 'Instructor earnings', no_instructor_activity: 'No instructor activity yet.', orders_suffix: 'orders',
    no_admins: '📭 No admins yet.', add_new_admin: 'Add a new admin:', add_admin_btn: '➕ Add admin', send_admin_username: 'Send the new admin\'s @telegram_username:', added_as_admin: 'added as admin. Ask them to send /start to this bot.', remove_btn: '🗑 Remove', removed: '✅ Removed',
    no_instructors: '📭 No instructors yet.', add_new_instructor: 'Add a new instructor:', add_instructor_btn: '➕ Add instructor', send_instructor_username: 'Send the instructor\'s @telegram_username:', added_as_instructor: 'added. Ask them to send /start to this bot.',
    gear_label: 'Gear', level_label: 'Level', languages_label: 'Langs', strikes_label: 'Strikes',
    deactivate_btn: '🚫 Deactivate', activate_btn: '✅ Activate', reset_strikes_btn: '🔄 Reset strikes', updated: '✅ Updated', strikes_reset: '✅ Strikes reset, reactivated',
    ask_name: 'Name:', ask_gear: 'Gear, comma-separated (surf, kite, wing, sup):', ask_levels: 'Level range, e.g. "first-timer,advanced":', ask_langs: 'Spoken languages, comma-separated (en, ru):'
  },
  ru: {
    nothing_pending: '📭 Ничего не ожидает.', no_orders: '📭 Пока нет заказов.', no_my_orders: '📭 У вас пока нет заказов.',
    finances_title: 'Финансы за всё время', active_orders: 'Активные/завершённые заказы', gross_revenue: 'Валовая выручка', deposits_collected: 'Собрано депозитов', refunded_pending: 'Возвращено / ожидает возврата',
    your_earnings_title: 'Ваш заработок', orders_word: 'Заказы', earnings_total: 'Итого (80% от цены занятия, без допов)',
    instructor_earnings_title: 'Заработок инструкторов', no_instructor_activity: 'Пока нет активности инструкторов.', orders_suffix: 'заказов',
    no_admins: '📭 Пока нет админов.', add_new_admin: 'Добавить нового админа:', add_admin_btn: '➕ Добавить админа', send_admin_username: 'Пришлите @username нового админа:', added_as_admin: 'добавлен как админ. Попросите его нажать /start в этом боте.', remove_btn: '🗑 Удалить', removed: '✅ Удалён',
    no_instructors: '📭 Пока нет инструкторов.', add_new_instructor: 'Добавить нового инструктора:', add_instructor_btn: '➕ Добавить инструктора', send_instructor_username: 'Пришлите @username инструктора:', added_as_instructor: 'добавлен. Попросите его нажать /start в этом боте.',
    gear_label: 'Снаряд', level_label: 'Уровень', languages_label: 'Языки', strikes_label: 'Страйки',
    deactivate_btn: '🚫 Деактивировать', activate_btn: '✅ Активировать', reset_strikes_btn: '🔄 Сбросить страйки', updated: '✅ Обновлено', strikes_reset: '✅ Страйки сброшены, доступ восстановлен',
    ask_name: 'Имя:', ask_gear: 'Снаряжение через запятую (surf, kite, wing, sup):', ask_levels: 'Диапазон уровней, напр.: "first-timer,advanced":', ask_langs: 'Языки через запятую (en, ru):'
  }
};
function m(lang, key) { return (MISC[lang] && MISC[lang][key]) || MISC.en[key]; }

function addonsSubtotal(addonsBreakdown) { return addonsBreakdown.reduce((sum, a) => sum + (Number(a.amount) || 0), 0); }

function parseJson(v, fallback) { try { return typeof v === 'string' ? JSON.parse(v) : (v || fallback); } catch (e) { return fallback; } }

function isEligible(instructor, order) {
  const gear = parseJson(instructor.gear, []);
  const langs = parseJson(instructor.spoken_languages, []);
  const reqLangs = parseJson(order.required_languages, []);
  const levels = ['first-timer', 'beginner', 'intermediate', 'advanced'];
  const orderLevelIdx = levels.indexOf(order.skill_level);
  const minIdx = levels.indexOf(instructor.level_min || 'first-timer');
  const maxIdx = levels.indexOf(instructor.level_max || 'advanced');
  const gearOk = gear.includes(order.sport_type);
  const levelOk = orderLevelIdx >= minIdx && orderLevelIdx <= maxIdx;
  const langOk = reqLangs.length === 0 || reqLangs.some(l => langs.includes(l));
  return gearOk && levelOk && langOk;
}

function groupCardMessage(order, lang) {
  // NEVER include client name/phone/email here — group card is anonymized to just the order number.
  const emoji = SPORT_EMOJI[order.sport_type] || '🏄';
  const sessions = parseJson(order.sessions, []);
  const addonsBreakdown = parseJson(order.addons, []);
  const mediaDates = parseJson(order.media_dates, []);
  const datesLines = sessions.map((s, i) => `   ${i + 1}. ${s.date} · ${s.timeWindow} · ${s.spot || '—'}${mediaDates.includes(s.date) ? ' 📸' : ''}`).join('\n');
  const addonLines = addonsBreakdown.map(a => `   ${a.label} — $${a.amount}`).join('\n');
  return `🆕 <b>Order #${order.id}</b>\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `${emoji} <b>${order.sport_type}</b> · ${order.skill_level}\n` +
    `👥 ${order.participants} rider(s)\n` +
    `📅 <b>${c(lang, 'sessions')}:</b>\n${datesLines}\n` +
    (addonLines ? `\n🧾 <b>${c(lang, 'addons')}:</b>\n${addonLines}\n` : '') +
    (order.instructor_lang_pref ? `\n🌐 ${c(lang, 'clientPrefers')}: ${order.instructor_lang_pref}\n` : '') +
    `\n💰 <b>$${instructorEarnings(order)}</b>`;
}

function fullOrderMessage(order, opts = {}) {
  const lang = opts.lang;
  const emoji = SPORT_EMOJI[order.sport_type] || '🏄';
  const sessions = parseJson(order.sessions, []);
  const addonsBreakdown = parseJson(order.addons, []);
  const mediaDates = parseJson(order.media_dates, []);
  const datesLines = sessions.map((s, i) => `   ${i + 1}. ${s.date} · ${s.timeWindow} · ${s.spot || '—'}${mediaDates.includes(s.date) ? ' 📸' : ''}`).join('\n');
  const addonLines = addonsBreakdown.map(a => `   ${a.label} — $${a.amount}`).join('\n');
  return `<b>Order #${order.id}</b> (${order.booking_id})\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `👤 <b>${order.client_name}</b>${order.age ? ' (' + order.age + 'y)' : ''}\n` +
    `📞 ${order.client_phone}\n` +
    `📧 ${order.client_email}\n` +
    `${emoji} <b>${order.sport_type}</b> · ${c(lang, 'level')}: ${order.skill_level} · ${c(lang, 'language')}: ${order.instructor_lang_pref || '—'}\n` +
    `👥 ${order.participants} rider(s)\n` +
    `📅 <b>${c(lang, 'sessions')}:</b>\n${datesLines}\n` +
    (addonLines ? `\n🧾 <b>${c(lang, 'addons')}:</b>\n${addonLines}\n(${c(lang, 'addonsSubtotal')}: $${addonsSubtotal(addonsBreakdown)})\n` : '') +
    (order.additional_info ? `\n💬 ${order.additional_info}\n` : '') +
    `\n💰 ${c(lang, 'sessionPrice')}: $${order.session_price} · ${c(lang, 'total')}: $${order.total_price}\n` +
    `💳 ${c(lang, 'deposit')} $${order.deposit_price} (${order.deposit_payment_method}${order.deposit_paid ? ', ' + c(lang, 'paid') : ', ' + c(lang, 'unpaid')})\n` +
    `📌 ${c(lang, 'status')}: <b>${order.status}</b>` +
    (opts.showEarnings ? `\n💵 <b>${c(lang, 'yourEarnings80Only')}: $${instructorEarnings(order)}</b>` : '');
}

// One line per order — used by the paginated "All orders" list.
function compactOrderLine(order, lang) {
  const emoji = SPORT_EMOJI[order.sport_type] || '🏄';
  const sessions = parseJson(order.sessions, []);
  const first = sessions[0] || {};
  const statusEmoji = { pending_review: '⏳', in_group: '📤', taken: '🤝', confirmed: '✅', completed: '🏱', cancelled: '❌', deposit_refund_pending: '↩️', deposit_refunded: '↩️', needs_admin_assignment: '⚠️' }[order.status] || '•';
  return `${statusEmoji} <b>#${order.id}</b> ${emoji} ${order.skill_level} · ${order.client_name} · ${first.date || '?'} · $${order.total_price} · <i>${order.status}</i>`;
}

function whatsappDeepLink(order, instructorName) {
  const sessions = parseJson(order.sessions, []);
  const first = sessions[0] || {};
  const msg = `Hi ${order.client_name}! This is ${instructorName} from EasyBali.surf — I'll be your ${order.sport_type} coach.\n\n` +
    `Session: ${first.date} · ${first.timeWindow} at ${first.spot || 'TBD'}\n\n` +
    `Let's confirm the exact meeting point — where are you staying / where should the transfer pick you up from?`;
  const cleanPhone = (order.client_phone || '').replace(/[^0-9]/g, '');
  return `https://wa.me/${cleanPhone}?text=${encodeURIComponent(msg)}`;
}

function trackedWhatsappUrl(order) {
  // Routes through our own redirect so we can record the click, then bounces to wa.me.
  return `${PUBLIC_BASE_URL}/wa/${order.id}`;
}

// ============================================================
// SCREEN MESSAGE TRACKING — auto-delete previous menu output when a new
// menu screen opens, so the chat doesn't fill up with stale order lists.
// Only used for browse/menu screens (Pending, Instructors, Finances, All
// orders, etc) — NEVER for order-flow messages (group cards, WhatsApp DMs,
// cron alerts), which must persist.
// ============================================================
const screenMessages = new Map(); // chatId -> message_id[]

async function clearScreen(chatId) {
  const ids = screenMessages.get(chatId) || [];
  for (const id of ids) {
    try { await bot.telegram.deleteMessage(chatId, id); } catch (e) { /* already gone / too old to delete */ }
  }
  screenMessages.set(chatId, []);
}

async function trackReply(ctx, text, extra) {
  const sent = await ctx.reply(text, extra);
  const arr = screenMessages.get(ctx.chat.id) || [];
  arr.push(sent.message_id);
  screenMessages.set(ctx.chat.id, arr);
  return sent;
}

// Also delete the user's own previous command message (e.g. tapping a reply-keyboard
// button) once a newer one arrives — keeps the chat down to just the latest request +
// its answer, same as clearing bot screens. Call once at the top of each menu handler
// (right after clearScreen, which removes anything left from BEFORE this request),
// then this stashes the CURRENT user message so the next request clears it in turn.
function trackUserMessage(ctx) {
  if (!ctx.message) return;
  const arr = screenMessages.get(ctx.chat.id) || [];
  arr.push(ctx.message.message_id);
  screenMessages.set(ctx.chat.id, arr);
}

function calendarUrl(order) {
  const sessions = parseJson(order.sessions, []);
  const first = sessions[0]; if (!first) return 'https://calendar.google.com/calendar/';
  try {
    const start = time.baliToUtcDate(first.date, first.timeWindow.split(' – ')[0].trim());
    const end = new Date(start.getTime() + 2 * 60 * 60000);
    const fmt = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const params = new URLSearchParams({
      action: 'TEMPLATE',
      text: `${order.sport_type} session — ${order.client_name}`,
      dates: `${fmt(start)}/${fmt(end)}`,
      location: first.spot || 'Bali',
      ctz: 'Asia/Makassar'
    });
    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  } catch (e) { return 'https://calendar.google.com/calendar/'; }
}

async function notifyRole(role, messageOrFn, extraOrFn) {
  const pool = db.getPool();
  const [rows] = await pool.execute('SELECT * FROM users WHERE role = ? AND is_active = 1 AND telegram_chat_id IS NOT NULL', [role]);
  for (const u of rows) {
    const msg = typeof messageOrFn === 'function' ? messageOrFn(u) : messageOrFn;
    const extra = typeof extraOrFn === 'function' ? extraOrFn(u) : extraOrFn;
    try { await bot.telegram.sendMessage(u.telegram_chat_id, msg, { parse_mode: 'HTML', ...extra }); } catch (e) { /* user hasn't /start'd yet */ }
  }
}

function adminReviewKeyboard(orderId, role, lang) {
  const rows = [[Markup.button.callback(t(lang, 'send_to_group_btn'), `admin_send_${orderId}`)]];
  if (role === 'super_admin') {
    rows.push([Markup.button.callback(t(lang, 'cancel_refund_btn'), `admin_cancelrefund_${orderId}`)]);
  }
  rows.push([Markup.button.callback(t(lang, 'delete_btn'), `admin_delete_${orderId}`)]);
  return Markup.inlineKeyboard(rows);
}

// Shared button shown inside the instructors GROUP chat, where members may have different
// languages set individually — so it's bilingual rather than picked per-viewer.
const TAKE_BTN_GROUP_LABEL = '✅ TAKE';

// ============================================================
// AUTH MIDDLEWARE-ish HELPERS
// ============================================================

async function requireUser(ctx) {
  const u = ctx.from.username;
  if (!u) { await ctx.reply('❌ Set a Telegram @username first / Установите @username в Telegram.'); return null; }
  const user = await db.getUserByUsername(u);
  if (!user || !user.is_active) { await ctx.reply('❌ You are not authorized. Contact the super admin. / Вы не авторизованы. Обратитесь к супер-админу.'); return null; }
  return user;
}

function mainKeyboard(user) {
  const lang = user.language || 'en';
  if (user.role === 'super_admin') {
    return Markup.keyboard([
      [t(lang, 'menu_pending'), t(lang, 'menu_all_orders')],
      [t(lang, 'menu_finances'), t(lang, 'menu_statistics')],
      [t(lang, 'menu_instructors'), t(lang, 'menu_admins')],
      [t(lang, 'menu_settings')]
    ]).resize();
  }
  if (user.role === 'admin') {
    return Markup.keyboard([
      [t(lang, 'menu_pending'), t(lang, 'menu_all_orders')],
      [t(lang, 'menu_finances'), t(lang, 'menu_statistics')],
      [t(lang, 'menu_instructors'), t(lang, 'menu_settings')]
    ]).resize();
  }
  return Markup.keyboard([
    [t(lang, 'menu_my_orders'), t(lang, 'menu_finances')],
    [t(lang, 'menu_settings')]
  ]).resize();
}

// Every submenu screen (Pending/All orders/Statistics/Finances/Instructors/Admins) ends with
// this same « Back button — matches the reference bot's back_to_main pattern: delete the
// submenu screen, re-show the welcome text + persistent main reply-keyboard.
function backRow(lang) { return [Markup.button.callback(t(lang, 'menu_back'), 'back_to_main')]; }

bot.action('back_to_main', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return ctx.answerCbQuery();
  allOrdersPagination.delete(ctx.chat.id);
  await clearScreen(ctx.chat.id);
  try { await ctx.deleteMessage(); } catch (e) {}
  await ctx.answerCbQuery();
  const lang = user.language || 'en';
  const welcomeKey = user.role === 'super_admin' ? 'welcome_super' : user.role === 'admin' ? 'welcome_admin' : 'welcome_instructor';
  await ctx.reply(t(lang, welcomeKey), { parse_mode: 'HTML', ...mainKeyboard(user) });
});

// ============================================================
// BOT: /start + auth
// ============================================================

bot.start(async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  const pool = db.getPool();
  await pool.execute('UPDATE users SET telegram_chat_id = ? WHERE id = ?', [ctx.chat.id, user.id]);
  const lang = user.language || 'en';
  const welcomeKey = user.role === 'super_admin' ? 'welcome_super' : user.role === 'admin' ? 'welcome_admin' : 'welcome_instructor';
  await ctx.reply(t(lang, welcomeKey), { parse_mode: 'HTML', ...mainKeyboard(user) });
});

// ============================================================
// PENDING REVIEW (admin + super_admin)
// ============================================================

bot.hears(/⏰ Pending review|⏰ На рассмотрении/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) return ctx.reply(t(user?.language, 'access_denied'));
  await clearScreen(ctx.chat.id);
  trackUserMessage(ctx);
  const pool = db.getPool();
  const [orders] = await pool.execute("SELECT * FROM orders WHERE status = 'pending_review' ORDER BY created_at ASC");
  if (orders.length === 0) return trackReply(ctx, m(user.language, 'nothing_pending'));
  for (const order of orders) {
    await trackReply(ctx, fullOrderMessage(order, { lang: user.language }), { parse_mode: 'HTML', ...adminReviewKeyboard(order.id, user.role, user.language) });
  }
  await trackReply(ctx, '⬅️', Markup.inlineKeyboard([backRow(user.language)]));
});

bot.action(/admin_send_(\d+)/, async (ctx) => {
  const orderId = ctx.match[1];
  const user = await requireUser(ctx);
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) return ctx.answerCbQuery(t(user?.language, 'access_denied'));
  const pool = db.getPool();
  const [rows] = await pool.execute('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!rows.length) return ctx.answerCbQuery(t(user.language, 'order_not_found'));
  const order = rows[0];

  const sent = await bot.telegram.sendMessage(INSTRUCTORS_GROUP_ID, groupCardMessage(order), {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([[Markup.button.callback(TAKE_BTN_GROUP_LABEL, `take_${orderId}`)]])
  });

  await pool.execute(
    "UPDATE orders SET status = 'in_group', group_message_id = ?, pool_expires_at = ? WHERE id = ?",
    [sent.message_id, time.nowBaliString(POOL_WINDOW_MIN), orderId]
  );
  await db.logAction(ctx.from.username, user.role, 'sent_to_group', orderId, null);
  await ctx.answerCbQuery(t(user.language, 'sent_to_group'));
  try { await ctx.editMessageReplyMarkup(undefined); } catch (e) {}
});

bot.action(/admin_delete_(\d+)/, async (ctx) => {
  const orderId = ctx.match[1];
  const user = await requireUser(ctx);
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) return ctx.answerCbQuery(t(user?.language, 'access_denied'));
  const pool = db.getPool();
  const [rows] = await pool.execute('SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = rows[0];
  await pool.execute("UPDATE orders SET status = 'cancelled' WHERE id = ?", [orderId]);
  await db.logAction(ctx.from.username, user.role, 'deleted_order', orderId, null);
  // Deleting from Pending only removes the admin's own review card (no group/instructor
  // ever saw it). But if it had already gone further — posted to the group, or taken by an
  // instructor — those need cleaning up too, otherwise the order looks "not deleted" from
  // their side (still shows a live TAKE button / still sits in the instructor's chat).
  if (order) {
    if (order.group_message_id) { try { await bot.telegram.deleteMessage(INSTRUCTORS_GROUP_ID, order.group_message_id); } catch (e) {} }
    if (order.instructor_id) {
      const [[instructor]] = await pool.execute('SELECT * FROM users WHERE id = ?', [order.instructor_id]);
      if (instructor && instructor.telegram_chat_id) {
        if (order.instructor_message_id) { try { await bot.telegram.deleteMessage(instructor.telegram_chat_id, order.instructor_message_id); } catch (e) {} }
        await bot.telegram.sendMessage(instructor.telegram_chat_id, `❌ Order #${orderId} was cancelled by an admin.`, { parse_mode: 'HTML' }).catch(() => {});
      }
    }
  }
  await ctx.answerCbQuery('✅ Deleted');
  try { await ctx.deleteMessage(); } catch (e) {}
});

// Cancel + refund deposit — super_admin only.
bot.action(/admin_cancelrefund_(\d+)/, async (ctx) => {
  const orderId = ctx.match[1];
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.answerCbQuery(t(user?.language, 'access_denied'));
  const pool = db.getPool();
  const [rows] = await pool.execute('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!rows.length) return ctx.answerCbQuery(t(user.language, 'order_not_found'));
  const order = rows[0];

  const refund = await processDepositRefund(order);
  const newStatus = refund.auto ? 'deposit_refunded' : 'deposit_refund_pending';
  await pool.execute("UPDATE orders SET status = ? WHERE id = ?", [newStatus, orderId]);
  await db.logAction(ctx.from.username, user.role, 'cancel_refund', orderId, refund);
  if (order.group_message_id) { try { await bot.telegram.deleteMessage(INSTRUCTORS_GROUP_ID, order.group_message_id); } catch (e) {} }
  if (refund.auto) { await email.depositRefundedEmail(order); await ctx.answerCbQuery(t(user.language, 'refund_done_auto')); }
  else await ctx.answerCbQuery(t(user.language, 'refund_manual_needed'));
  try { await ctx.editMessageReplyMarkup(undefined); } catch (e) {}
});

// ============================================================
// GROUP: instructor takes an order
// ============================================================

bot.action(/take_(\d+)/, async (ctx) => {
  const orderId = ctx.match[1];
  const user = await requireUser(ctx);
  if (!user) return ctx.answerCbQuery('❌ Not authorized / Не авторизован');
  const pool = db.getPool();
  const [rows] = await pool.execute('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!rows.length) return ctx.answerCbQuery(t(user.language, 'order_not_found'));
  const order = rows[0];
  if (order.status !== 'in_group') return ctx.answerCbQuery(t(user.language, 'already_taken'));
  if (!isEligible(user, order)) return ctx.answerCbQuery(t(user.language, 'not_eligible'));

  await pool.execute(
    "UPDATE orders SET status = 'taken', instructor_id = ?, whatsapp_deadline_at = ?, whatsapp_clicked = 0 WHERE id = ?",
    [user.id, time.nowBaliString(WHATSAPP_WINDOW_MIN), orderId]
  );
  await db.logAction(ctx.from.username, user.role, 'took_order', orderId, null);

  if (order.group_message_id) { try { await bot.telegram.deleteMessage(INSTRUCTORS_GROUP_ID, order.group_message_id); } catch (e) {} }

  const updated = { ...order, status: 'taken', instructor_id: user.id };
  const kb = Markup.inlineKeyboard([[
    Markup.button.url(t(user.language, 'whatsapp_btn'), trackedWhatsappUrl(order)),
    Markup.button.url(t(user.language, 'calendar_btn'), calendarUrl(order))
  ]]);
  const sent = await bot.telegram.sendMessage(
    user.telegram_chat_id,
    fullOrderMessage(updated, { showEarnings: true, lang: user.language }) + '\n\n' + c(user.language, 'messageClientReminder'),
    { parse_mode: 'HTML', ...kb }
  );
  await pool.execute('UPDATE orders SET instructor_message_id = ? WHERE id = ?', [sent.message_id, orderId]);
  await ctx.answerCbQuery(t(user.language, 'order_taken'));
});

// Express redirect used by the WhatsApp button — records the click, then bounces to wa.me.
function registerWhatsappRedirect(app) {
  app.get('/wa/:orderId', async (req, res) => {
    const pool = db.getPool();
    const [rows] = await pool.execute('SELECT o.*, u.name AS instructor_name FROM orders o LEFT JOIN users u ON u.id = o.instructor_id WHERE o.id = ?', [req.params.orderId]);
    const order = rows[0];
    if (!order) return res.redirect('https://wa.me/');
    if (!order.whatsapp_clicked) {
      await pool.execute("UPDATE orders SET whatsapp_clicked = 1, whatsapp_clicked_at = NOW(), status = 'confirmed' WHERE id = ?", [order.id]);
      await email.bookingConfirmedEmail(order);
    }
    res.redirect(whatsappDeepLink(order, order.instructor_name || 'your coach'));
  });
}

// ============================================================
// FINANCES
// ============================================================

bot.hears(/💰 Finances|💰 Финансы/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  await clearScreen(ctx.chat.id);
  trackUserMessage(ctx);
  const pool = db.getPool();
  if (user.role === 'super_admin') {
    const [[totals]] = await pool.execute(
      "SELECT COUNT(*) n, COALESCE(SUM(total_price),0) revenue, COALESCE(SUM(deposit_price),0) deposits FROM orders WHERE status NOT IN ('cancelled','deposit_refunded','deposit_refund_pending')"
    );
    const [[refunded]] = await pool.execute("SELECT COUNT(*) n, COALESCE(SUM(deposit_price),0) sum FROM orders WHERE status IN ('deposit_refunded','deposit_refund_pending')");
    return trackReply(ctx,
      `💰 <b>${m(user.language, 'finances_title')}</b>\n\n${m(user.language, 'active_orders')}: ${totals.n}\n${m(user.language, 'gross_revenue')}: $${totals.revenue}\n${m(user.language, 'deposits_collected')}: $${totals.deposits}\n\n${m(user.language, 'refunded_pending')}: ${refunded.n} ($${refunded.sum})`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([backRow(user.language)]) }
    );
  }
  if (user.role === 'instructor') {
    const [[mine]] = await pool.execute(
      "SELECT COUNT(*) n, COALESCE(SUM(session_price),0) rev FROM orders WHERE instructor_id = ? AND status IN ('confirmed','completed')",
      [user.id]
    );
    return trackReply(ctx, `💰 <b>${m(user.language, 'your_earnings_title')}</b>\n\n${m(user.language, 'orders_word')}: ${mine.n}\n${m(user.language, 'earnings_total')}: $${Math.round(mine.rev * 0.8)}`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([backRow(user.language)]) });
  }
  // plain admin — no % anymore, just visibility into instructor totals
  const [rows] = await pool.execute(
    `SELECT u.name, u.telegram_username, COUNT(o.id) n, COALESCE(SUM(o.session_price),0) rev
     FROM users u LEFT JOIN orders o ON o.instructor_id = u.id AND o.status IN ('confirmed','completed')
     WHERE u.role = 'instructor' GROUP BY u.id`
  );
  const lines = rows.map(r => `${r.name || r.telegram_username}: ${r.n} ${m(user.language, 'orders_suffix')}, $${Math.round(r.rev * 0.8)}`).join('\n') || m(user.language, 'no_instructor_activity');
  return trackReply(ctx, `💰 <b>${m(user.language, 'instructor_earnings_title')}</b>\n\n${lines}`, { parse_mode: 'HTML', ...Markup.inlineKeyboard([backRow(user.language)]) });
});

// ============================================================
// STATISTICS (admin + super_admin)
// ============================================================

const STATS_LABELS = {
  en: { title: 'STATISTICS', pending: 'Pending review', in_group: 'In group pool', taken: 'Taken', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled', refund_pending: 'Refund pending', refunded: 'Refunded', total_active: 'Total active', revenue: 'Gross revenue (active)' },
  ru: { title: 'СТАТИСТИКА', pending: 'На рассмотрении', in_group: 'В пуле группы', taken: 'Взяты', confirmed: 'Подтверждены', completed: 'Завершены', cancelled: 'Отменены', refund_pending: 'Ожидают возврата', refunded: 'Возвращены', total_active: 'Всего активных', revenue: 'Выручка (активные)' }
};
function sl(lang, key) { return (STATS_LABELS[lang] && STATS_LABELS[lang][key]) || STATS_LABELS.en[key]; }

bot.hears(/📊 Statistics|📊 Статистика/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) return ctx.reply(t(user?.language, 'access_denied'));
  await clearScreen(ctx.chat.id);
  trackUserMessage(ctx);
  const pool = db.getPool();
  const [rows] = await pool.execute(
    `SELECT status, COUNT(*) n, COALESCE(SUM(total_price),0) rev FROM orders GROUP BY status`
  );
  const byStatus = Object.fromEntries(rows.map(r => [r.status, r]));
  const g = s => (byStatus[s] && byStatus[s].n) || 0;
  const activeStatuses = ['pending_review', 'in_group', 'taken', 'confirmed', 'completed'];
  const totalActive = activeStatuses.reduce((sum, s) => sum + g(s), 0);
  const totalRevenue = activeStatuses.reduce((sum, s) => sum + ((byStatus[s] && byStatus[s].rev) || 0), 0);
  const lang = user.language || 'en';
  await trackReply(ctx,
    `📊 <b>${sl(lang, 'title')}</b>\n\n` +
    `⏳ ${sl(lang, 'pending')}: ${g('pending_review')}\n` +
    `📤 ${sl(lang, 'in_group')}: ${g('in_group')}\n` +
    `🤝 ${sl(lang, 'taken')}: ${g('taken')}\n` +
    `✅ ${sl(lang, 'confirmed')}: ${g('confirmed')}\n` +
    `🏱 ${sl(lang, 'completed')}: ${g('completed')}\n` +
    `❌ ${sl(lang, 'cancelled')}: ${g('cancelled')}\n` +
    `↩️ ${sl(lang, 'refund_pending')}: ${g('deposit_refund_pending')}\n` +
    `↩️ ${sl(lang, 'refunded')}: ${g('deposit_refunded')}\n\n` +
    `📈 ${sl(lang, 'total_active')}: ${totalActive}\n` +
    `💰 ${sl(lang, 'revenue')}: $${totalRevenue}`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard([backRow(lang)]) }
  );
});

// ============================================================
// ALL ORDERS (admin + super_admin) / MY ORDERS (instructor)
// ============================================================

function orderStatusKeyboard(order, user) {
  // super_admin can cancel+refund from anywhere; plain admin can only resend/delete while pending-ish.
  const rows = [];
  if (order.status === 'pending_review') rows.push([Markup.button.callback(t(user.language, 'send_to_group_btn'), `admin_send_${order.id}`)]);
  if (['pending_review', 'in_group', 'taken', 'confirmed'].includes(order.status) && user.role === 'super_admin') {
    rows.push([Markup.button.callback(t(user.language, 'cancel_refund_btn'), `admin_cancelrefund_${order.id}`)]);
  }
  if (user.role === 'super_admin' || user.role === 'admin') rows.push([Markup.button.callback(t(user.language, 'delete_btn'), `admin_delete_${order.id}`)]);
  return rows.length ? Markup.inlineKeyboard(rows) : undefined;
}

// ============================================================
// ALL ORDERS — skischool.ge-style: one paginated inline-keyboard list,
// most recent first, Prev/Next + page indicator, with a toggle to the
// grouped detailed view (in-group / taken / cancelled / refunds).
// ============================================================
const ALL_ORDERS_PAGE_SIZE = 10;
const allOrdersPagination = new Map(); // chatId -> { orders, page }

function pageLabel(lang) { return `${t(lang, 'page_word')} %PAGE% ${t(lang, 'of_word')} %TOTAL%`; }

function renderAllOrdersPage(chatId, lang) {
  const state = allOrdersPagination.get(chatId);
  if (!state || !state.orders.length) return { text: m(lang, 'no_orders'), keyboard: undefined };
  const totalPages = Math.ceil(state.orders.length / ALL_ORDERS_PAGE_SIZE);
  const page = Math.min(Math.max(1, state.page), totalPages);
  state.page = page;
  const slice = state.orders.slice((page - 1) * ALL_ORDERS_PAGE_SIZE, page * ALL_ORDERS_PAGE_SIZE);
  const title = lang === 'ru' ? 'Все заказы' : 'All orders';
  const text = `<b>${title} (${state.orders.length})</b>\n\n` +
    slice.map(o => compactOrderLine(o, lang)).join('\n') +
    `\n\n${t(lang, 'page_word')} ${page} ${t(lang, 'of_word')} ${totalPages}`;
  const rows = [];
  // Prev+Next always shown together (like skischool.ge) when there's more than one page —
  // tapping past an edge just answers the callback with nothing to do rather than hiding the button.
  if (totalPages > 1) rows.push([Markup.button.callback(t(lang, 'prev_page_btn'), 'all_orders_prev'), Markup.button.callback(t(lang, 'next_page_btn'), 'all_orders_next')]);
  rows.push([Markup.button.callback(t(lang, 'menu_current_orders'), 'orders_current')]);
  rows.push(backRow(lang));
  return { text, keyboard: Markup.inlineKeyboard(rows) };
}

bot.hears(/📋 All orders|📋 Все заказы/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) return ctx.reply(t(user?.language, 'access_denied'));
  await clearScreen(ctx.chat.id);
  trackUserMessage(ctx);
  const pool = db.getPool();
  const [orders] = await pool.execute("SELECT * FROM orders WHERE status != 'cancelled' ORDER BY created_at DESC LIMIT 200");
  allOrdersPagination.set(ctx.chat.id, { orders, page: 1 });
  const { text, keyboard } = renderAllOrdersPage(ctx.chat.id, user.language);
  await trackReply(ctx, text, { parse_mode: 'HTML', ...(keyboard || {}) });
});

bot.action(/all_orders_(prev|next)/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) return ctx.answerCbQuery(t(user?.language, 'access_denied'));
  const state = allOrdersPagination.get(ctx.chat.id);
  if (!state) return ctx.answerCbQuery();
  const totalPages = Math.ceil(state.orders.length / ALL_ORDERS_PAGE_SIZE);
  const delta = ctx.match[1] === 'next' ? 1 : -1;
  const nextPage = state.page + delta;
  if (nextPage < 1 || nextPage > totalPages) return ctx.answerCbQuery(); // already at an edge, no-op like the reference bot
  state.page = nextPage;
  const { text, keyboard } = renderAllOrdersPage(ctx.chat.id, user.language);
  await ctx.answerCbQuery();
  try { await ctx.editMessageText(text, { parse_mode: 'HTML', ...(keyboard || {}) }); } catch (e) {}
});

// "Detailed" view — grouped by the statuses that still need eyes on them: in the
// group pool, taken by an instructor, then cancelled/refund side-states for visibility.
bot.action('orders_current', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) return ctx.answerCbQuery(t(user?.language, 'access_denied'));
  await ctx.answerCbQuery();
  await clearScreen(ctx.chat.id);
  const pool = db.getPool();
  const groups = [
    { statuses: ['in_group'], label: { en: '📤 In group pool', ru: '📤 В пуле группы' } },
    { statuses: ['taken', 'confirmed'], label: { en: '🤝 Taken by instructor', ru: '🤝 Взяты инструктором' } },
    { statuses: ['cancelled'], label: { en: '❌ Cancelled', ru: '❌ Отменены' } },
    { statuses: ['deposit_refund_pending', 'deposit_refunded'], label: { en: '↩️ Refunds', ru: '↩️ Возвраты' } }
  ];
  const lang = user.language || 'en';
  let any = false;
  for (const g of groups) {
    const placeholders = g.statuses.map(() => '?').join(',');
    const [orders] = await pool.execute(
      `SELECT o.*, u.name AS instructor_name, u.telegram_username AS instructor_username
       FROM orders o LEFT JOIN users u ON u.id = o.instructor_id
       WHERE o.status IN (${placeholders}) ORDER BY o.created_at DESC LIMIT 15`,
      g.statuses
    );
    if (!orders.length) continue;
    any = true;
    await trackReply(ctx, `<b>${g.label[lang] || g.label.en} (${orders.length})</b>`, { parse_mode: 'HTML' });
    for (const order of orders) {
      const who = order.instructor_name ? `\n👤 ${c(user.language, 'instructor')}: ${order.instructor_name} (${order.instructor_username})` : '';
      await trackReply(ctx, fullOrderMessage(order, { lang: user.language }) + who, { parse_mode: 'HTML', ...(orderStatusKeyboard(order, user) || {}) });
    }
  }
  if (!any) await trackReply(ctx, m(user.language, 'no_orders'));
  await trackReply(ctx, '⬅️', Markup.inlineKeyboard([backRow(lang)]));
});

bot.hears(/📋 My orders|📋 Мои заказы/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  await clearScreen(ctx.chat.id);
  trackUserMessage(ctx);
  const pool = db.getPool();
  if (user.role === 'instructor') {
    const [orders] = await pool.execute(
      "SELECT * FROM orders WHERE instructor_id = ? ORDER BY created_at DESC LIMIT 30",
      [user.id]
    );
    if (!orders.length) return trackReply(ctx, m(user.language, 'no_my_orders'));
    for (const order of orders) {
      const kb = order.status === 'taken' ? Markup.inlineKeyboard([[
        Markup.button.url(t(user.language, 'whatsapp_btn'), trackedWhatsappUrl(order)),
        Markup.button.url(t(user.language, 'calendar_btn'), calendarUrl(order))
      ]]) : undefined;
      await trackReply(ctx, fullOrderMessage(order, { showEarnings: true, lang: user.language }), { parse_mode: 'HTML', ...(kb || {}) });
    }
    await trackReply(ctx, '⬅️', Markup.inlineKeyboard([backRow(user.language)]));
    return;
  }
  // admin / super_admin tapping "My orders" — show orders THEY sent to the group or reviewed
  // (there's no per-admin ownership column, so this just aliases to All orders for those roles).
  const [orders] = await pool.execute("SELECT * FROM orders WHERE status != 'cancelled' ORDER BY created_at DESC LIMIT 30");
  if (!orders.length) return trackReply(ctx, m(user.language, 'no_orders'));
  for (const order of orders) await trackReply(ctx, fullOrderMessage(order, { lang: user.language }), { parse_mode: 'HTML', ...(orderStatusKeyboard(order, user) || {}) });
  await trackReply(ctx, '⬅️', Markup.inlineKeyboard([backRow(user.language)]));
});

// ============================================================
// SETTINGS (all roles) — language switch
// ============================================================

bot.hears(/⚙️ Settings|⚙️ Настройки/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return;
  await ctx.reply('🌐 Choose language / Выберите язык:', Markup.inlineKeyboard([
    [Markup.button.callback('🇬🇧 English', 'setlang_en'), Markup.button.callback('🇷🇺 Русский', 'setlang_ru')]
  ]));
});

bot.action(/setlang_(en|ru)/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user) return ctx.answerCbQuery('❌');
  const pool = db.getPool();
  const lang = ctx.match[1];
  await pool.execute('UPDATE users SET language = ? WHERE id = ?', [lang, user.id]);
  await ctx.answerCbQuery('✅');
  const welcomeKey = user.role === 'super_admin' ? 'welcome_super' : user.role === 'admin' ? 'welcome_admin' : 'welcome_instructor';
  await ctx.reply(t(lang, welcomeKey), { parse_mode: 'HTML', ...mainKeyboard({ ...user, language: lang }) });
});

// ============================================================
// ADMINS MANAGEMENT (super_admin only) — add/remove plain admins
// ============================================================

bot.hears(/🛠 Admins|🛠 Админы/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.reply(t(user?.language, 'access_denied'));
  await clearScreen(ctx.chat.id);
  trackUserMessage(ctx);
  const pool = db.getPool();
  const [rows] = await pool.execute("SELECT * FROM users WHERE role = 'admin' ORDER BY name");
  if (!rows.length) await trackReply(ctx, m(user.language, 'no_admins'));
  for (const a of rows) {
    await trackReply(ctx, `🛠 <b>${a.name || a.telegram_username}</b> (${a.telegram_username})`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback(m(user.language, 'remove_btn'), `admin_remove_${a.id}`)]])
    });
  }
  await trackReply(ctx, m(user.language, 'add_new_admin'), Markup.inlineKeyboard([[Markup.button.callback(m(user.language, 'add_admin_btn'), 'admin_add')]]));
  await trackReply(ctx, '⬅️', Markup.inlineKeyboard([backRow(user.language)]));
});

bot.action('admin_add', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.answerCbQuery(t(user?.language, 'access_denied'));
  conversationState.set(ctx.from.id, { step: 'add_admin_username' });
  await ctx.answerCbQuery();
  await ctx.reply(m(user.language, 'send_admin_username'));
});

bot.action(/admin_remove_(\d+)/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.answerCbQuery(t(user?.language, 'access_denied'));
  const pool = db.getPool();
  await pool.execute('DELETE FROM users WHERE id = ? AND role = "admin"', [ctx.match[1]]);
  await db.logAction(ctx.from.username, user.role, 'remove_admin', null, { adminId: ctx.match[1] });
  await ctx.answerCbQuery(m(user.language, 'removed'));
});

// ============================================================
// INSTRUCTOR MANAGEMENT (super_admin: add/remove/edit; instructor: self-edit gear/level/lang)
// ============================================================

bot.hears(/👥 Instructors|👥 Инструкторы/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) return ctx.reply(t(user?.language, 'access_denied'));
  await clearScreen(ctx.chat.id);
  trackUserMessage(ctx);
  const pool = db.getPool();
  const [rows] = await pool.execute("SELECT * FROM users WHERE role = 'instructor' ORDER BY name");
  if (!rows.length) return trackReply(ctx, m(user.language, 'no_instructors'), user.role === 'super_admin' ? addInstructorKeyboard(user.language) : undefined);
  for (const i of rows) {
    const gear = parseJson(i.gear, []).join(', ') || '—';
    const langs = parseJson(i.spoken_languages, []).join(', ') || '—';
    const buttons = [
      [Markup.button.callback(i.is_active ? m(user.language, 'deactivate_btn') : m(user.language, 'activate_btn'), `inst_toggle_${i.id}`)],
      [Markup.button.callback(m(user.language, 'reset_strikes_btn'), `inst_resetstrikes_${i.id}`)]
    ];
    if (user.role === 'super_admin') buttons.push([Markup.button.callback(m(user.language, 'remove_btn'), `inst_remove_${i.id}`)]);
    await trackReply(ctx,
      `${i.is_active ? '✅' : '🚫'} <b>${i.name || i.telegram_username}</b> (${i.telegram_username})\n` +
      `${m(user.language, 'gear_label')}: ${gear} · ${m(user.language, 'level_label')}: ${i.level_min || '?'}–${i.level_max || '?'} · ${m(user.language, 'languages_label')}: ${langs} · ${m(user.language, 'strikes_label')}: ${i.rating_strikes}`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }
    );
  }
  if (user.role === 'super_admin') await trackReply(ctx, m(user.language, 'add_new_instructor'), addInstructorKeyboard(user.language));
  await trackReply(ctx, '⬅️', Markup.inlineKeyboard([backRow(user.language)]));
});

function addInstructorKeyboard(lang) {
  return Markup.inlineKeyboard([[Markup.button.callback(m(lang, 'add_instructor_btn'), 'inst_add')]]);
}

bot.action('inst_add', async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.answerCbQuery(t(user?.language, 'access_denied'));
  conversationState.set(ctx.from.id, { step: 'add_instructor_username' });
  await ctx.answerCbQuery();
  await ctx.reply(m(user.language, 'send_instructor_username'));
});

bot.action(/inst_toggle_(\d+)/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) return ctx.answerCbQuery(t(user?.language, 'access_denied'));
  const pool = db.getPool();
  await pool.execute('UPDATE users SET is_active = NOT is_active WHERE id = ?', [ctx.match[1]]);
  await db.logAction(ctx.from.username, user.role, 'toggle_instructor_active', null, { instructorId: ctx.match[1] });
  await ctx.answerCbQuery(m(user.language, 'updated'));
});

bot.action(/inst_resetstrikes_(\d+)/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || (user.role !== 'admin' && user.role !== 'super_admin')) return ctx.answerCbQuery(t(user?.language, 'access_denied'));
  const pool = db.getPool();
  await pool.execute('UPDATE users SET rating_strikes = 0, is_active = 1 WHERE id = ?', [ctx.match[1]]);
  await db.logAction(ctx.from.username, user.role, 'reset_strikes', null, { instructorId: ctx.match[1] });
  await ctx.answerCbQuery(m(user.language, 'strikes_reset'));
});

bot.action(/inst_remove_(\d+)/, async (ctx) => {
  const user = await requireUser(ctx);
  if (!user || user.role !== 'super_admin') return ctx.answerCbQuery(t(user?.language, 'access_denied'));
  const pool = db.getPool();
  await pool.execute('DELETE FROM users WHERE id = ? AND role = "instructor"', [ctx.match[1]]);
  await db.logAction(ctx.from.username, user.role, 'remove_instructor', null, { instructorId: ctx.match[1] });
  await ctx.answerCbQuery(m(user.language, 'removed'));
});

// Simple multi-step text conversation for adding an instructor + instructor self-editing gear.
bot.on('text', async (ctx, next) => {
  const state = conversationState.get(ctx.from.id);
  if (!state) return next();
  const user = await requireUser(ctx);
  if (!user) return;
  const text = ctx.message.text.trim();

  if (state.step === 'add_admin_username') {
    const username = db.normalizeUsername(text);
    const pool = db.getPool();
    const existing = await db.getUserByUsername(username);
    if (existing) {
      await pool.execute('UPDATE users SET role = "admin", is_active = 1 WHERE telegram_username = ?', [username]);
    } else {
      await pool.execute('INSERT INTO users (telegram_username, role, is_active) VALUES (?, "admin", 1)', [username]);
    }
    await db.logAction(ctx.from.username, user.role, 'add_admin', null, { username });
    conversationState.delete(ctx.from.id);
    return ctx.reply(`✅ ${username} ${m(user.language, 'added_as_admin')}`);
  }

  if (state.step === 'add_instructor_username') {
    state.username = db.normalizeUsername(text);
    state.step = 'add_instructor_name';
    return ctx.reply(m(user.language, 'ask_name'));
  }
  if (state.step === 'add_instructor_name') {
    state.name = text;
    state.step = 'add_instructor_gear';
    return ctx.reply(m(user.language, 'ask_gear'));
  }
  if (state.step === 'add_instructor_gear') {
    state.gear = text.split(',').map(s => s.trim()).filter(Boolean);
    state.step = 'add_instructor_levels';
    return ctx.reply(m(user.language, 'ask_levels'));
  }
  if (state.step === 'add_instructor_levels') {
    const [min, max] = text.split(',').map(s => s.trim());
    state.level_min = min; state.level_max = max || min;
    state.step = 'add_instructor_langs';
    return ctx.reply(m(user.language, 'ask_langs'));
  }
  if (state.step === 'add_instructor_langs') {
    state.spoken_languages = text.split(',').map(s => s.trim()).filter(Boolean);
    const pool = db.getPool();
    await pool.execute(
      'INSERT INTO users (telegram_username, role, name, gear, level_min, level_max, spoken_languages, is_active) VALUES (?, "instructor", ?, ?, ?, ?, ?, 1)',
      [state.username, state.name, JSON.stringify(state.gear), state.level_min, state.level_max, JSON.stringify(state.spoken_languages)]
    );
    await db.logAction(ctx.from.username, user.role, 'add_instructor', null, { username: state.username });
    conversationState.delete(ctx.from.id);
    return ctx.reply(`✅ ${state.username} ${m(user.language, 'added_as_instructor')}`);
  }
  return next();
});

// ============================================================
// CRON — pool expiry, WhatsApp deadline, 2h reminders, follow-ups
// ============================================================

cron.schedule('* * * * *', async () => {
  if (!db.isReady()) return;
  const pool = db.getPool();

  // 1) Unclaimed for 3h in the group → refund path
  try {
    const [expired] = await pool.execute("SELECT * FROM orders WHERE status = 'in_group' AND pool_expires_at < ?", [time.nowBaliString()]);
    for (const order of expired) {
      const refund = await processDepositRefund(order);
      const newStatus = refund.auto ? 'deposit_refunded' : 'deposit_refund_pending';
      await pool.execute('UPDATE orders SET status = ? WHERE id = ?', [newStatus, order.id]);
      if (order.group_message_id) { try { await bot.telegram.deleteMessage(INSTRUCTORS_GROUP_ID, order.group_message_id); } catch (e) {} }
      await db.logAction('system', 'system', 'pool_expired_refund', order.id, refund);
      if (refund.auto) await email.depositRefundedEmail(order);
      await notifyRole('super_admin',
        `⏰ Order #${order.id} unclaimed for 3h.\nDeposit $${order.deposit_price} via ${order.deposit_payment_method}.\n${refund.auto ? '✅ Auto-refunded via PayPal.' : '⚠️ Manual crypto refund needed.'}`
      );
      await notifyRole('admin', `⏰ Order #${order.id} unclaimed for 3h — moved to refund path.`);
    }
  } catch (e) { console.error('cron pool-expiry error:', e); }

  // 2) WhatsApp not clicked within 5 min → strike instructor, bounce back (or escalate)
  try {
    const [missed] = await pool.execute("SELECT * FROM orders WHERE status = 'taken' AND whatsapp_clicked = 0 AND whatsapp_deadline_at < ?", [time.nowBaliString()]);
    for (const order of missed) {
      const [[instructor]] = await pool.execute('SELECT * FROM users WHERE id = ?', [order.instructor_id]);
      if (instructor) {
        const newStrikes = instructor.rating_strikes - 1;
        const deactivate = newStrikes <= -3;
        await pool.execute('UPDATE users SET rating_strikes = ?, is_active = ? WHERE id = ?', [newStrikes, deactivate ? 0 : 1, instructor.id]);
        await db.logAction('system', 'system', 'strike_no_response', order.id, { instructorId: instructor.id, newStrikes });
        if (instructor.telegram_chat_id) {
          await bot.telegram.sendMessage(instructor.telegram_chat_id, `${t(instructor.language, 'strike_added')} (order #${order.id}). ${deactivate ? t(instructor.language, 'deactivated') : ''}`, { parse_mode: 'HTML' }).catch(() => {});
        }
      }

      const bounceCount = (order.bounce_count || 0) + 1;
      if (bounceCount >= MAX_BOUNCES) {
        await pool.execute("UPDATE orders SET status = 'needs_admin_assignment', bounce_count = ? WHERE id = ?", [bounceCount, order.id]);
        const escalationMsg = `⚠️ NEEDS MANUAL ASSIGNMENT / ТРЕБУЕТСЯ РУЧНОЕ НАЗНАЧЕНИЕ — order #${order.id}`;
        await notifyRole('admin', escalationMsg);
        await notifyRole('super_admin', escalationMsg);
      } else {
        const sent = await bot.telegram.sendMessage(INSTRUCTORS_GROUP_ID, groupCardMessage(order), {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[Markup.button.callback(TAKE_BTN_GROUP_LABEL, `take_${order.id}`)]])
        });
        await pool.execute(
          "UPDATE orders SET status = 'in_group', instructor_id = NULL, group_message_id = ?, pool_expires_at = ?, bounce_count = ? WHERE id = ?",
          [sent.message_id, time.nowBaliString(POOL_WINDOW_MIN), bounceCount, order.id]
        );
      }
    }
  } catch (e) { console.error('cron whatsapp-deadline error:', e); }

  // 3) 2h reminder to instructor (email to client too) before the first upcoming session
  try {
    const [rows] = await pool.execute(
      `SELECT o.*, u.telegram_chat_id, u.language FROM orders o JOIN users u ON u.id = o.instructor_id
       WHERE o.status IN ('confirmed','taken') AND o.reminder_2h_sent = 0`
    );
    for (const order of rows) {
      const sessions = parseJson(order.sessions, []);
      const first = sessions[0]; if (!first) continue;
      const sessionUtc = time.baliToUtcDate(first.date, first.timeWindow.split(' – ')[0].trim());
      const minsUntil = (sessionUtc.getTime() - Date.now()) / 60000;
      if (minsUntil <= 120 && minsUntil > 0) {
        if (order.telegram_chat_id) {
          await bot.telegram.sendMessage(order.telegram_chat_id, `⏰ Reminder: order #${order.id} starts in ~2h (${first.date} ${first.timeWindow}).`, { parse_mode: 'HTML' }).catch(() => {});
        }
        await email.reminder2hEmail(order, `${first.date} ${first.timeWindow}`);
        await pool.execute('UPDATE orders SET reminder_2h_sent = 1 WHERE id = ?', [order.id]);
      }
    }
  } catch (e) { console.error('cron 2h-reminder error:', e); }

  // 4) Mark completed after the last session has passed, then send the follow-up email once.
  try {
    const [rows] = await pool.execute("SELECT * FROM orders WHERE status = 'confirmed'");
    for (const order of rows) {
      const sessions = parseJson(order.sessions, []);
      const last = sessions[sessions.length - 1]; if (!last) continue;
      const lastEnd = new Date(time.baliToUtcDate(last.date, last.timeWindow.split(' – ')[1]?.trim() || last.timeWindow).getTime());
      if (Date.now() > lastEnd.getTime()) {
        await pool.execute("UPDATE orders SET status = 'completed', completed_at = NOW() WHERE id = ?", [order.id]);
        if (!order.followup_email_sent) {
          await email.followUpEmail(order);
          await pool.execute('UPDATE orders SET followup_email_sent = 1 WHERE id = ?', [order.id]);
        }
      }
    }
  } catch (e) { console.error('cron completion error:', e); }
});

// ============================================================
// HTTP: booking intake webhook + WhatsApp-click redirect
// ============================================================

const app = express();
app.use(cors());
app.use(express.json());

app.post('/webhook/booking', async (req, res) => {
  if (req.headers['x-booking-secret'] !== BOOKING_WEBHOOK_SECRET) return res.status(401).json({ error: 'unauthorized' });
  try {
    const orderId = await db.insertOrderFromWebhook(req.body);
    const pool = db.getPool();
    const [[order]] = await pool.execute('SELECT * FROM orders WHERE id = ?', [orderId]);
    await notifyRole('admin', u => fullOrderMessage(order, { lang: u.language }), u => adminReviewKeyboard(orderId, 'admin', u.language));
    await notifyRole('super_admin', u => fullOrderMessage(order, { lang: u.language }), u => adminReviewKeyboard(orderId, 'super_admin', u.language));
    res.json({ ok: true, orderId });
  } catch (e) {
    console.error('webhook intake error:', e);
    res.status(500).json({ error: 'internal_error' });
  }
});

registerWhatsappRedirect(app);
app.get('/health', (req, res) => res.json({ ok: true, db: db.isReady() }));

// ============================================================
// BOOT
// ============================================================

(async () => {
  // Start the HTTP server FIRST, before DB and Telegram — both of those can
  // hang or throw if env vars are wrong/missing (e.g. MySQL vars not linked
  // in Railway), and until something is listening on PORT, Railway's proxy
  // returns 502/connection-refused for every request, including /health.
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`🌐 HTTP listening on :${port}`));

  try {
    await db.init();
  } catch (e) {
    console.error('❌ db.init() failed (check MYSQLHOST/MYSQLUSER/MYSQLPASSWORD/MYSQLDATABASE variables):', e.message);
  }

  try {
    await bot.launch();
    console.log('🤖 Admin bot launched');
  } catch (e) {
    // Don't let a Telegram-side failure take the whole process down — the
    // webhook intake should keep working even if bot.launch() can't connect.
    console.error('❌ bot.launch() failed (Telegram bot inactive, HTTP still up):', e.message);
  }
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
