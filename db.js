// db.js — MySQL pool, schema, and data-access helpers for the admin bot.
// Mirrors the connection conventions from the reference SkiSchool bot (Railway
// MySQL plugin auto-injects MYSQLHOST/PORT/USER/PASSWORD/DATABASE).

const mysql = require('mysql2/promise');

let pool;
let ready = false;

async function init() {
  const dbConfig = {
    host: process.env.MYSQLHOST || 'localhost',
    port: process.env.MYSQLPORT || 3306,
    user: process.env.MYSQLUSER || 'root',
    password: process.env.MYSQLPASSWORD || '',
    database: process.env.MYSQLDATABASE || 'railway',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    connectTimeout: 30000,
    timezone: '+08:00', // Bali (WITA, UTC+8) — see time.js for the offset math this implies
    ...(process.env.NODE_ENV === 'production' && { ssl: { rejectUnauthorized: false } })
  };
  pool = mysql.createPool(dbConfig);
  const conn = await pool.getConnection();
  await conn.query("SET time_zone = '+08:00'");
  conn.release();
  await createTables();
  ready = true;
  console.log('🎉 Database ready');
}

async function createTables() {
  // Roles: 'super_admin' | 'admin' | 'instructor'
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      telegram_username VARCHAR(255) UNIQUE NOT NULL,
      telegram_chat_id BIGINT,
      role VARCHAR(20) NOT NULL DEFAULT 'instructor',
      name VARCHAR(255),
      phone VARCHAR(100),
      language VARCHAR(10) DEFAULT 'en',
      -- Instructor-only matching fields (super_admin approves access; the
      -- instructor or super_admin can fill these in from inside the bot)
      gear JSON,               -- e.g. ["surf","sup"]
      level_min VARCHAR(20),   -- 'first-timer' | 'beginner' | 'intermediate' | 'advanced'
      level_max VARCHAR(20),
      spoken_languages JSON,   -- e.g. ["en","ru"]
      rating_strikes INT NOT NULL DEFAULT 0, -- 0 .. -3, no-response strikes only
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_username (telegram_username),
      INDEX idx_role (role)
    ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      booking_id VARCHAR(100) UNIQUE NOT NULL,

      -- Client contact — visible to admin/super_admin only, NEVER sent to the
      -- instructors group card (group card shows booking_id/order number only).
      client_name VARCHAR(255) NOT NULL,
      client_phone VARCHAR(100) NOT NULL,
      client_email VARCHAR(255) NOT NULL,

      age INT,
      additional_info TEXT,                  -- free-text notes from the client (goals, injuries, etc.)

      sport_type VARCHAR(50) NOT NULL,       -- surf | kite | wing | sup
      skill_level VARCHAR(20) NOT NULL,      -- first-timer | beginner | intermediate | advanced
      required_languages JSON,               -- instructor spoken-language requirement, e.g. ["en"] — derived from preferredLanguage
      participants INT NOT NULL DEFAULT 1,
      sessions JSON NOT NULL,                -- [{date,timeWindow,spot}, ...] — normalized from selectedDates/sessions on intake
      session_price INT NOT NULL DEFAULT 0,  -- base coaching price ONLY (no add-ons) — this is what the 80% instructor cut is computed from
      addons JSON,                           -- [{label, amount}, ...] line-item breakdown (media, rental, transfers) — shown to the instructor for info, NOT part of their 80%
      media_dates JSON,                      -- session dates the photo/video/drone add-on covers, e.g. ["2026-08-01"] — for the "shoot days" line on the order card
      instructor_lang_pref VARCHAR(20),       -- raw preferredLanguage from the form (english/russian/...)

      total_price INT NOT NULL,
      deposit_price INT NOT NULL,
      deposit_payment_method VARCHAR(20) NOT NULL, -- 'paypal' | 'crypto' (mapped from paymentProvider)
      deposit_paid TINYINT(1) NOT NULL DEFAULT 0,  -- from paymentStatus === 'COMPLETED'
      deposit_payment_ref VARCHAR(255),      -- PayPal capture/order id (for refunds) or paymentId for crypto

      status VARCHAR(30) NOT NULL DEFAULT 'pending_review',
      -- pending_review -> in_group -> taken -> confirmed -> completed
      -- side states: deposit_refund_pending, deposit_refunded, cancelled, needs_admin_assignment

      instructor_id INT,
      group_message_id INT,
      instructor_message_id INT,
      whatsapp_clicked TINYINT(1) NOT NULL DEFAULT 0,
      whatsapp_clicked_at TIMESTAMP NULL,

      pool_expires_at DATETIME NULL,         -- 3h window while sitting in the group unclaimed
      whatsapp_deadline_at DATETIME NULL,    -- 5min window after taking, to message the client
      bounce_count INT NOT NULL DEFAULT 0,   -- how many times it's been kicked back to the group

      reminder_2h_sent TINYINT(1) NOT NULL DEFAULT 0,
      followup_email_sent TINYINT(1) NOT NULL DEFAULT 0,

      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP NULL,

      INDEX idx_status (status),
      INDEX idx_instructor (instructor_id)
    ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  // Additive migrations for columns introduced after the initial CREATE TABLE above
  // (kept idempotent — ER_DUP_FIELDNAME is swallowed).
  const migrations = [
    'ALTER TABLE orders ADD COLUMN age INT AFTER client_email',
    'ALTER TABLE orders ADD COLUMN additional_info TEXT AFTER age',
    'ALTER TABLE orders ADD COLUMN session_price INT NOT NULL DEFAULT 0 AFTER sessions',
    'ALTER TABLE orders ADD COLUMN media_dates JSON AFTER addons'
  ];
  for (const m of migrations) {
    try { await pool.execute(m); } catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') console.log('⚠️ migration warning:', e.message); }
  }

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      actor_username VARCHAR(255),
      actor_role VARCHAR(20),
      action VARCHAR(100) NOT NULL,
      order_id INT NULL,
      details TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_order (order_id)
    ) ENGINE=InnoDB CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);

  // Bootstrap the super_admin from env on first boot.
  const superAdminUsername = normalizeUsername(process.env.SUPER_ADMIN_USERNAME);
  if (superAdminUsername) {
    const [rows] = await pool.execute('SELECT id FROM users WHERE telegram_username = ?', [superAdminUsername]);
    if (rows.length === 0) {
      await pool.execute(
        'INSERT INTO users (telegram_username, role, is_active) VALUES (?, ?, 1)',
        [superAdminUsername, 'super_admin']
      );
      console.log('✅ super_admin created:', superAdminUsername);
    } else {
      await pool.execute('UPDATE users SET role = ?, is_active = 1 WHERE telegram_username = ?', ['super_admin', superAdminUsername]);
    }
  }
}

function normalizeUsername(u) {
  if (!u) return null;
  return u.startsWith('@') ? u : `@${u}`;
}

function isReady() { return ready; }
function getPool() { return pool; }

async function logAction(actorUsername, actorRole, action, orderId, details) {
  try {
    await pool.execute(
      'INSERT INTO audit_log (actor_username, actor_role, action, order_id, details) VALUES (?, ?, ?, ?, ?)',
      [actorUsername || null, actorRole || null, action, orderId || null, details ? JSON.stringify(details) : null]
    );
  } catch (e) {
    console.error('audit_log insert failed:', e.message);
  }
}

async function getUserByUsername(username) {
  const formatted = normalizeUsername(username);
  // LOWER() comparison as a defensive belt-and-suspenders match — works regardless of
  // the table's actual collation (in case it was created case-sensitive before the
  // utf8mb4_unicode_ci spec was in place).
  const [rows] = await pool.execute('SELECT * FROM users WHERE LOWER(telegram_username) = LOWER(?)', [formatted]);
  return rows[0] || null;
}

// Maps the LANGUAGE label the booking form sends ('english'|'russian'|'georgian'|'other',
// same vocabulary as the reference ski-school form/bot) to the short code the instructor
// roster's spoken_languages matching uses ('en'|'ru'|...). Unknown labels fall through as-is
// so a new language added to the form doesn't silently vanish — it just won't match anyone yet.
const LANG_LABEL_TO_CODE = { english: 'en', russian: 'ru', georgian: 'ka', other: null };

// Maps the display-text skill level the booking form sends ('First timer'|'Beginner'|
// 'Intermediate'|'Advanced', from i18n.js levelOpts) to the slug used everywhere else in
// this bot (instructor level_min/level_max, isEligible's levels array). Without this, a
// display string never matches the slug and instructors can never take the order.
const SKILL_LEVEL_MAP = {
  'first timer': 'first-timer', 'beginner': 'beginner', 'intermediate': 'intermediate', 'advanced': 'advanced',
  'новичок': 'first-timer', 'начинающий': 'beginner', 'средний': 'intermediate', 'продвинутый': 'advanced'
};
function normalizeSkillLevel(label) {
  if (!label) return 'first-timer';
  const key = String(label).trim().toLowerCase();
  return SKILL_LEVEL_MAP[key] || key; // already a slug (e.g. re-processed order) — pass through
}

function normalizeLangPref(label) {
  if (!label) return null;
  const key = String(label).toLowerCase();
  return Object.prototype.hasOwnProperty.call(LANG_LABEL_TO_CODE, key) ? LANG_LABEL_TO_CODE[key] : key;
}

// Real intake payload, exactly as sent by the booking form (app.js `sendToBot` / `botData`)
// and forwarded verbatim by the client Telegram bot after a confirmed crypto payment
// (index.js `order` object in finalizeConfirmedPayment) — same field names in both places:
// {
//   bookingId, fullName, phone, email, age, skillLevel, preferredLanguage, additionalInfo,
//   sport, participants,
//   selectedDates: [{date, time}]  -- ski form's shape (single time, duration implies length)
//   sessions:      [{date, timeWindow, spot}] -- surf site's richer shape; either key is accepted
//   sessionPrice,        -- base coaching price ONLY, before add-ons (drives the instructor's 80% cut)
//   addonsBreakdown: [{label, amount}], -- line items for media/rental/transfers, shown but not part of the cut
//   total, deposit, remaining,
//   paymentStatus: 'COMPLETED', payerEmail,
//   paymentId, paymentProvider: 'paypal' | 'cryptobot'
// }
function normalizeBookingPayload(p) {
  const rawSessions = p.sessions || p.selectedDates || [];
  const sessions = rawSessions.map(s => ({
    date: s.date,
    timeWindow: s.timeWindow || s.time || s.slot || '',
    spot: s.spot || p.spot || null
  }));
  const langCode = normalizeLangPref(p.preferredLanguage);
  const providerRaw = (p.paymentProvider || 'paypal').toLowerCase();
  const depositPaymentMethod = providerRaw.includes('crypto') ? 'crypto' : 'paypal';

  const addonsBreakdown = p.addonsBreakdown || p.addons_breakdown || [];
  const addonsTotal = addonsBreakdown.reduce((sum, a) => sum + (Number(a.amount) || 0), 0);
  // sessionPrice must be the coaching-only line — never fall back to `total` (that would
  // silently pay the instructor 80% of add-ons too). If the caller genuinely omits it,
  // back it out from total - addons instead of trusting total wholesale.
  const totalPrice = p.total ?? p.totalPrice ?? 0;
  const sessionPrice = p.sessionPrice ?? Math.max(0, totalPrice - addonsTotal);

  return {
    bookingId: p.bookingId,
    clientName: p.fullName,
    clientPhone: p.phone,
    clientEmail: p.email,
    age: p.age ?? null,
    additionalInfo: p.additionalInfo || '',
    sportType: p.sport,
    skillLevel: normalizeSkillLevel(p.skillLevel),
    requiredLanguages: langCode ? [langCode] : [],
    instructorLangPref: p.preferredLanguage || null,
    participants: p.participants || 1,
    sessions,
    sessionPrice,
    addonsBreakdown,
    mediaDates: p.mediaDates || [],
    totalPrice,
    depositPrice: p.deposit ?? p.depositPrice,
    depositPaymentMethod,
    // PayPal: the form only calls the webhook after PayPal itself reports COMPLETED, and a
    // real integration should additionally re-verify server-side against PayPal's API before
    // trusting this flag — see refunds.js's comment on why deposit_payment_ref must be a real
    // capture id. Crypto: the client bot only forwards here from its own CryptoBot webhook
    // handler (i.e. already payment-confirmed), so COMPLETED is likewise expected either way.
    depositPaid: p.paymentStatus === 'COMPLETED',
    // Prefer an explicit PayPal capture/order id if the form sends one; otherwise fall back to
    // paymentId (crypto invoice id) or payerEmail so there's still something to look up by.
    depositPaymentRef: p.captureId || p.paymentId || p.payerEmail || null
  };
}

async function insertOrderFromWebhook(rawPayload) {
  const p = normalizeBookingPayload(rawPayload);
  const [result] = await pool.execute(
    `INSERT INTO orders
      (booking_id, client_name, client_phone, client_email, age, additional_info, sport_type, skill_level,
       required_languages, participants, sessions, session_price, addons, media_dates, instructor_lang_pref,
       total_price, deposit_price, deposit_payment_method, deposit_paid, deposit_payment_ref, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review')`,
    [
      p.bookingId, p.clientName, p.clientPhone, p.clientEmail, p.age, p.additionalInfo, p.sportType, p.skillLevel,
      JSON.stringify(p.requiredLanguages), p.participants, JSON.stringify(p.sessions), p.sessionPrice, JSON.stringify(p.addonsBreakdown), JSON.stringify(p.mediaDates), p.instructorLangPref,
      p.totalPrice, p.depositPrice, p.depositPaymentMethod, p.depositPaid ? 1 : 0, p.depositPaymentRef
    ]
  );
  return result.insertId;
}

module.exports = {
  init, isReady, getPool, logAction, getUserByUsername, normalizeUsername, insertOrderFromWebhook
};
