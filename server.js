const express = require("express");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { nanoid } = require("nanoid");
const { Pool } = require("pg");

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";
const DATABASE_URL = process.env.DATABASE_URL || "";
const LAB_STAFF_EMAIL = (process.env.LAB_STAFF_EMAIL || "").trim().toLowerCase();
const LAB_STAFF_PASSWORD = process.env.LAB_STAFF_PASSWORD || "";
const LAB_STAFF_NAME = process.env.LAB_STAFF_NAME || "Lab Staff";
const LAB_STAFF_PROMOTE = process.env.LAB_STAFF_PROMOTE === "true" || process.env.LAB_STAFF_PROMOTE === "1";
/** Doar dacă e true: POST /api/lab/admin/users poate crea clienți din lab. În producție lasă false — clienți reali doar din /store/register. */
const LAB_ALLOW_MANUAL_USERS = process.env.LAB_ALLOW_MANUAL_USERS === "true" || process.env.LAB_ALLOW_MANUAL_USERS === "1";
const STORE_HOST = (process.env.STORE_HOST || "").trim().toLowerCase();
const LAB_HOST = (process.env.LAB_HOST || "").trim().toLowerCase();
const N8N_ORDER_WEBHOOK_URL = (process.env.N8N_ORDER_WEBHOOK_URL || "").trim();
const N8N_LEAD_WEBHOOK_URL = (process.env.N8N_LEAD_WEBHOOK_URL || "").trim();
const N8N_BOOKING_WEBHOOK_URL = (process.env.N8N_BOOKING_WEBHOOK_URL || "").trim();
const N8N_WEBHOOK_SECRET = process.env.N8N_WEBHOOK_SECRET || "";
const STORE_PUBLIC_RATE_WINDOW_MS = Number(process.env.STORE_PUBLIC_RATE_WINDOW_MS) || 15 * 60 * 1000;
const STORE_PUBLIC_RATE_MAX = Number(process.env.STORE_PUBLIC_RATE_MAX) || 40;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required. Add a Postgres connection string in environment variables.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  const host = (req.get("host") || "").split(":")[0].toLowerCase();
  if (LAB_HOST && host === LAB_HOST && req.path === "/") return res.redirect(302, "/lab/");
  if (STORE_HOST && host === STORE_HOST && req.path === "/") return res.redirect(302, "/store/");
  next();
});

function createWindowLimiter({ windowMs, max }) {
  const hits = new Map();
  return function limit(key) {
    const now = Date.now();
    const row = hits.get(key);
    if (!row || now > row.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return { ok: true, remaining: max - 1, resetAt: now + windowMs };
    }
    if (row.count >= max) return { ok: false, remaining: 0, resetAt: row.resetAt };
    row.count += 1;
    return { ok: true, remaining: max - row.count, resetAt: row.resetAt };
  };
}

const publicFormLimiter = createWindowLimiter({ windowMs: STORE_PUBLIC_RATE_WINDOW_MS, max: STORE_PUBLIC_RATE_MAX });

function publicFormRateLimit(req, res, next) {
  const key = `pf:${req.ip || "unknown"}`;
  const r = publicFormLimiter(key);
  if (!r.ok) {
    const retryAfterSec = Math.max(1, Math.ceil((r.resetAt - Date.now()) / 1000));
    res.set("Retry-After", String(retryAfterSec));
    return res.status(429).json({ error: "Prea multe cereri. Incearca din nou peste cateva minute.", retryAfterSec });
  }
  res.set("X-RateLimit-Remaining", String(r.remaining));
  next();
}

async function dispatchN8nWebhook(kind, data) {
  const url =
    kind === "order" ? N8N_ORDER_WEBHOOK_URL : kind === "lead" ? N8N_LEAD_WEBHOOK_URL : kind === "booking" ? N8N_BOOKING_WEBHOOK_URL : "";
  if (!url) return;
  const envelope = { source: "n8n-lab-live", kind, emittedAt: new Date().toISOString(), data };
  const json = JSON.stringify(envelope);
  const headers = { "Content-Type": "application/json", "User-Agent": "n8n-lab-live/1" };
  if (N8N_WEBHOOK_SECRET) {
    const sig = crypto.createHmac("sha256", N8N_WEBHOOK_SECRET).update(json).digest("hex");
    headers["X-Lab-Signature"] = `sha256=${sig}`;
  }
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), 12000);
  try {
    const r = await fetch(url, { method: "POST", headers, body: json, signal: ac.signal });
    if (!r.ok) console.error(`[webhook ${kind}] HTTP ${r.status}`);
  } catch (e) {
    console.error(`[webhook ${kind}]`, e.name === "AbortError" ? "timeout" : e.message || e);
  } finally {
    clearTimeout(tid);
  }
}

async function query(text, params = []) {
  return pool.query(text, params);
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "item";
}

async function migrate() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'customer';`);
  await query(`UPDATE users SET role = 'customer' WHERE role IS NULL OR role = '';`);

  await query(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price NUMERIC(10,2) NOT NULL,
      currency TEXT NOT NULL DEFAULT 'EUR',
      stock INTEGER NOT NULL DEFAULT 0
    );
  `);
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS slug TEXT;`);
  await query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT;`);
  await query(
    `CREATE UNIQUE INDEX IF NOT EXISTS products_slug_unique ON products (lower(slug)) WHERE slug IS NOT NULL AND slug <> '';`
  );

  await query(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      total NUMERIC(10,2) NOT NULL,
      currency TEXT NOT NULL DEFAULT 'EUR',
      status TEXT NOT NULL DEFAULT 'created',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id BIGSERIAL PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id TEXT NOT NULL,
      name TEXT NOT NULL,
      qty INTEGER NOT NULL,
      unit_price NUMERIC(10,2) NOT NULL,
      line_total NUMERIC(10,2) NOT NULL
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      order_id TEXT,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT,
      message TEXT,
      product_id TEXT,
      source TEXT NOT NULL DEFAULT 'store',
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      email TEXT NOT NULL,
      name TEXT,
      check_in DATE NOT NULL,
      check_out DATE NOT NULL,
      guests INTEGER NOT NULL DEFAULT 1,
      room_type TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'requested',
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const prows = await query(`SELECT id, name, slug FROM products`);
  for (const row of prows.rows) {
    if (!row.slug) {
      const base = slugify(row.name);
      let slug = base;
      let n = 1;
      while (true) {
        const clash = await query(`SELECT 1 FROM products WHERE lower(slug) = lower($1) AND id <> $2 LIMIT 1`, [slug, row.id]);
        if (!clash.rowCount) break;
        slug = `${base}-${n++}`;
      }
      await query(`UPDATE products SET slug = $1 WHERE id = $2`, [slug, row.id]);
    }
  }

  const desc = {
    prod_1: "Audit rapid al fluxurilor tale de automatizare: inventar noduri, riscuri, quick wins.",
    prod_2: "Sablon n8n pentru formulare, validare, CRM si notificari — ideal pentru training.",
    prod_3: "Suport prioritar n8n: debugging workflow, review PR, consultanta lunara."
  };
  for (const [id, text] of Object.entries(desc)) {
    await query(`UPDATE products SET description = COALESCE(NULLIF(description, ''), $1) WHERE id = $2`, [text, id]);
  }

  const countResult = await query(`SELECT COUNT(*)::int AS count FROM products`);
  if (countResult.rows[0].count === 0) {
    await query(
      `
      INSERT INTO products (id, name, slug, price, currency, stock, description)
      VALUES
        ('prod_1', 'Starter Automation Audit', 'starter-automation-audit', 79, 'EUR', 20, $1),
        ('prod_2', 'Lead Capture Workflow Pack', 'lead-capture-workflow-pack', 149, 'EUR', 12, $2),
        ('prod_3', 'n8n Support Retainer (monthly)', 'n8n-support-retainer-monthly', 199, 'EUR', 99, $3)
      `,
      [desc.prod_1, desc.prod_2, desc.prod_3]
    );
  }
}

/**
 * Dacă emailul din LAB_STAFF_EMAIL exista deja ca **client**, ensureStaffUser nu îl crea.
 * Setează LAB_STAFF_PROMOTE=true ca la fiecare boot să faci UPDATE: role=staff + parola din env.
 */
async function promoteStaffFromEnv() {
  if (!LAB_STAFF_PROMOTE || !LAB_STAFF_EMAIL || !LAB_STAFF_PASSWORD) return;
  const passwordHash = await bcrypt.hash(LAB_STAFF_PASSWORD, 10);
  const r = await query(
    `UPDATE users SET role = 'staff', password_hash = $1, name = COALESCE(NULLIF(TRIM(name), ''), $3) WHERE lower(email) = lower($2)`,
    [passwordHash, LAB_STAFF_EMAIL, LAB_STAFF_NAME]
  );
  if (r.rowCount) console.log(`[init] LAB_STAFF_PROMOTE: ${LAB_STAFF_EMAIL} → staff (parola actualizată din env).`);
  else console.warn(`[init] LAB_STAFF_PROMOTE: niciun rând pentru ${LAB_STAFF_EMAIL} — se va încerca crearea cu ensureStaffUser.`);
}

async function ensureStaffUser() {
  if (!LAB_STAFF_EMAIL || !LAB_STAFF_PASSWORD) return;
  const existing = await query(`SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`, [LAB_STAFF_EMAIL]);
  if (existing.rowCount) return;
  const passwordHash = await bcrypt.hash(LAB_STAFF_PASSWORD, 10);
  await query(
    `INSERT INTO users (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'staff')`,
    [nanoid(10), LAB_STAFF_EMAIL, LAB_STAFF_NAME, passwordHash]
  );
  console.log(`[init] Staff user created: ${LAB_STAFF_EMAIL} (role=staff). Change password after first deploy.`);
}

async function initDb() {
  await migrate();
  await promoteStaffFromEnv();
  await ensureStaffUser();
}

function signUserToken(user) {
  const role = user.role || "customer";
  return jwt.sign({ sub: user.id, email: user.email, name: user.name, role }, JWT_SECRET, { expiresIn: "7d" });
}

function verifyToken(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (_) {
    res.status(401).json({ error: "Invalid token" });
  }
}

/** Rolul din JWT poate lipsi (token vechi) sau fi învechit; pentru autorizare folosim mereu Postgres. */
async function hydrateUserRole(req, res, next) {
  try {
    const id = req.user && req.user.sub;
    if (!id) return res.status(401).json({ error: "Missing token subject" });
    const r = await query(`SELECT role FROM users WHERE id = $1 LIMIT 1`, [id]);
    if (!r.rowCount) return res.status(401).json({ error: "User not found" });
    req.user.role = r.rows[0].role;
    next();
  } catch (e) {
    res.status(500).json({ error: "Failed to resolve user role", detail: e.message });
  }
}

function requireStaff(req, res, next) {
  if (req.user.role !== "staff") {
    return res.status(403).json({
      error: "Staff access required",
      resolvedRole: req.user.role || null,
      hint:
        req.user.role === "customer"
          ? "Contul tău în Postgres este customer. Folosește LAB_STAFF_PROMOTE + LAB_STAFF_EMAIL pentru același email sau schimbă rolul manual în DB."
          : undefined
    });
  }
  next();
}

function requireCustomer(req, res, next) {
  if (req.user.role !== "customer") return res.status(403).json({ error: "Customer token required — use the public store at /store/" });
  next();
}

function publicUser(user, { includeRole = false } = {}) {
  const o = {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.created_at || user.createdAt
  };
  if (includeRole) o.role = user.role || "customer";
  return o;
}

async function loginUserRow(email, password) {
  const result = await query(
    `SELECT id, email, name, password_hash, role, created_at FROM users WHERE lower(email) = lower($1) LIMIT 1`,
    [email]
  );
  if (!result.rowCount) return null;
  const user = result.rows[0];
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return null;
  return user;
}

async function insertEventRow(type, payload) {
  const id = "evt_" + nanoid(10);
  await query(`INSERT INTO events (id, type, payload) VALUES ($1, $2, $3::jsonb)`, [id, type, JSON.stringify(payload)]);
  return { id, type, payload, createdAt: new Date().toISOString() };
}

async function createOrderForUserId(userId, items, client) {
  const run = client ? client.query.bind(client) : query;
  if (!Array.isArray(items) || items.length === 0) throw new Error("items[] is required");
  const lineItems = [];
  let total = 0;

  for (const line of items) {
    const productResult = await run(`SELECT id, name, price::float AS price FROM products WHERE id = $1 LIMIT 1`, [line.productId]);
    if (!productResult.rowCount) throw new Error(`Unknown product: ${line.productId}`);
    const product = productResult.rows[0];
    const qty = Number(line.qty || 1);
    if (!Number.isFinite(qty) || qty < 1) throw new Error("qty must be >= 1");
    const lineTotal = Number((qty * Number(product.price)).toFixed(2));
    lineItems.push({
      productId: product.id,
      name: product.name,
      qty,
      unitPrice: Number(product.price),
      lineTotal
    });
    total += lineTotal;
  }

  const orderId = "ord_" + nanoid(8);
  await run(
    `INSERT INTO orders (id, user_id, total, currency, status) VALUES ($1, $2, $3, 'EUR', 'created')`,
    [orderId, userId, Number(total.toFixed(2))]
  );

  for (const item of lineItems) {
    await run(
      `INSERT INTO order_items (order_id, product_id, name, qty, unit_price, line_total) VALUES ($1, $2, $3, $4, $5, $6)`,
      [orderId, item.productId, item.name, item.qty, item.unitPrice, item.lineTotal]
    );
  }

  const order = {
    id: orderId,
    userId,
    items: lineItems,
    total: Number(total.toFixed(2)),
    currency: "EUR",
    status: "created",
    createdAt: new Date().toISOString()
  };

  const eventId = "evt_" + nanoid(10);
  await run(`INSERT INTO events (id, type, order_id, payload) VALUES ($1, $2, $3, $4::jsonb)`, [
    eventId,
    "order.created",
    order.id,
    JSON.stringify(order)
  ]);

  return { order, eventId };
}

// --- Public ---
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "n8n-lab-live",
    db: "postgres",
    now: new Date().toISOString(),
    hosts: { storeHost: STORE_HOST || null, labHost: LAB_HOST || null },
    lab: {
      manualUserCreate: LAB_ALLOW_MANUAL_USERS,
      staffFromEnv: Boolean(LAB_STAFF_EMAIL && LAB_STAFF_PASSWORD)
    },
    webhooks: {
      order: Boolean(N8N_ORDER_WEBHOOK_URL),
      lead: Boolean(N8N_LEAD_WEBHOOK_URL),
      booking: Boolean(N8N_BOOKING_WEBHOOK_URL),
      signed: Boolean(N8N_WEBHOOK_SECRET)
    },
    rateLimit: { publicFormsPerIp: STORE_PUBLIC_RATE_MAX, windowMs: STORE_PUBLIC_RATE_WINDOW_MS }
  });
});

// --- Store (public + customers) ---
app.get("/api/store/products", (_req, res) => {
  query(
    `SELECT id, name, slug, price::float AS price, currency, stock,
            LEFT(COALESCE(description, ''), 220) AS "summary"
     FROM products ORDER BY name ASC`
  )
    .then((result) => res.json({ items: result.rows }))
    .catch((error) => res.status(500).json({ error: "Failed to fetch products", detail: error.message }));
});

app.get("/api/store/products/:idOrSlug", (req, res) => {
  const key = req.params.idOrSlug;
  query(
    `
    SELECT id, name, slug, description, price::float AS price, currency, stock
    FROM products
    WHERE id = $1 OR lower(slug) = lower($1)
    LIMIT 1
    `,
    [key]
  )
    .then((result) => {
      if (!result.rowCount) return res.status(404).json({ error: "Product not found" });
      const row = result.rows[0];
      res.json({
        product: {
          id: row.id,
          name: row.name,
          slug: row.slug,
          description: row.description || "",
          price: row.price,
          currency: row.currency,
          stock: row.stock
        }
      });
    })
    .catch((error) => res.status(500).json({ error: "Failed to fetch product", detail: error.message }));
});

app.post("/api/store/auth/register", async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
  if (String(password).length < 6) return res.status(400).json({ error: "Password must be at least 6 chars" });

  try {
    const existing = await query(`SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`, [email]);
    if (existing.rowCount) return res.status(409).json({ error: "User already exists" });

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await query(
      `INSERT INTO users (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'customer') RETURNING id, email, name, role, created_at`,
      [nanoid(10), email, name || "Client", passwordHash]
    );

    const user = result.rows[0];
    const token = signUserToken(user);
    res.status(201).json({ token, user: publicUser(user) });
  } catch (error) {
    res.status(500).json({ error: "Failed to create user", detail: error.message });
  }
});

app.post("/api/store/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });

  try {
    const user = await loginUserRow(email, password);
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    if (user.role === "staff") return res.status(403).json({ error: "Staff accounts use /lab/ (POST /api/lab/auth/login)" });

    const token = signUserToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (error) {
    res.status(500).json({ error: "Login failed", detail: error.message });
  }
});

app.post("/api/store/leads", publicFormRateLimit, async (req, res) => {
  const { email, name, message, productId, source } = req.body || {};
  if (!email || typeof email !== "string") return res.status(400).json({ error: "email is required" });

  try {
    const leadId = "lead_" + nanoid(10);
    const meta = { ...(req.body?.meta || {}) };
    await query(
      `INSERT INTO leads (id, email, name, message, product_id, source, meta) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [leadId, email.trim(), name || null, message || null, productId || null, source || "store", JSON.stringify(meta)]
    );

    const payload = { leadId, email: email.trim(), name: name || null, message: message || null, productId: productId || null, source: source || "store" };
    await insertEventRow("lead.created", payload);
    void dispatchN8nWebhook("lead", payload);

    res.status(201).json({ ok: true, leadId });
  } catch (error) {
    res.status(500).json({ error: "Failed to save lead", detail: error.message });
  }
});

function parseISODate(d) {
  if (!d || typeof d !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.trim());
  if (!m) return null;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

app.post("/api/store/bookings", publicFormRateLimit, async (req, res) => {
  const { email, name, checkIn, checkOut, guests, roomType, notes } = req.body || {};
  if (!email || typeof email !== "string") return res.status(400).json({ error: "email is required" });
  if (!checkIn || !checkOut) return res.status(400).json({ error: "checkIn and checkOut (YYYY-MM-DD) are required" });

  const dIn = parseISODate(checkIn);
  const dOut = parseISODate(checkOut);
  if (!dIn || !dOut) return res.status(400).json({ error: "Invalid date format (use YYYY-MM-DD)" });
  if (dOut <= dIn) return res.status(400).json({ error: "checkOut must be after checkIn" });
  const nights = Math.round((dOut - dIn) / 86400000);
  if (nights > 30) return res.status(400).json({ error: "Maximum 30 nights for demo" });

  const g = Number(guests) || 1;
  if (!Number.isInteger(g) || g < 1 || g > 20) return res.status(400).json({ error: "guests must be 1–20" });

  let userId = null;
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token) {
    try {
      const p = jwt.verify(token, JWT_SECRET);
      if (p.role === "customer") userId = p.sub;
    } catch (_) {
      /* optional link */
    }
  }

  try {
    const bookingId = "bkg_" + nanoid(10);
    const cin = checkIn.trim();
    const cout = checkOut.trim();
    await query(
      `INSERT INTO bookings (id, user_id, email, name, check_in, check_out, guests, room_type, notes, status, meta) VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,$8,$9,'requested',$10::jsonb)`,
      [
        bookingId,
        userId,
        email.trim(),
        name || null,
        cin,
        cout,
        g,
        roomType || null,
        notes || null,
        JSON.stringify({ ...(req.body?.meta || {}) })
      ]
    );

    const payload = {
      bookingId,
      userId,
      email: email.trim(),
      name: name || null,
      checkIn: cin,
      checkOut: cout,
      nights,
      guests: g,
      roomType: roomType || null,
      notes: notes || null
    };
    await insertEventRow("booking.requested", payload);
    void dispatchN8nWebhook("booking", payload);

    res.status(201).json({ ok: true, bookingId, nights });
  } catch (error) {
    res.status(500).json({ error: "Failed to save booking", detail: error.message });
  }
});

app.get("/api/store/bookings/me", verifyToken, hydrateUserRole, requireCustomer, (req, res) => {
  query(
    `SELECT id, email, name, check_in AS "checkIn", check_out AS "checkOut", guests, room_type AS "roomType", status, created_at AS "createdAt" FROM bookings WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [req.user.sub]
  )
    .then((result) => res.json({ items: result.rows }))
    .catch((error) => res.status(500).json({ error: "Failed to fetch bookings", detail: error.message }));
});

app.get("/api/store/account", verifyToken, hydrateUserRole, requireCustomer, (req, res) => {
  query(`SELECT id, email, name, role, created_at FROM users WHERE id = $1 LIMIT 1`, [req.user.sub])
    .then((result) => {
      if (!result.rowCount) return res.status(404).json({ error: "User not found in database" });
      res.json({ account: publicUser(result.rows[0]) });
    })
    .catch((error) => res.status(500).json({ error: "Failed to load account", detail: error.message }));
});

app.post("/api/store/orders", verifyToken, hydrateUserRole, requireCustomer, (req, res) => {
  (async () => {
    const { items } = req.body || {};
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { order } = await createOrderForUserId(req.user.sub, items, client);
      await client.query("COMMIT");
      void dispatchN8nWebhook("order", order);
      res.status(201).json({ order });
    } catch (error) {
      await client.query("ROLLBACK");
      const msg = error.message || String(error);
      if (msg.includes("items") || msg.includes("Unknown") || msg.includes("qty")) return res.status(400).json({ error: msg });
      res.status(500).json({ error: "Failed to create order", detail: msg });
    } finally {
      client.release();
    }
  })();
});

app.get("/api/store/orders", verifyToken, hydrateUserRole, requireCustomer, (req, res) => {
  query(
    `
    SELECT
      o.id,
      o.user_id AS "userId",
      o.total::float AS total,
      o.currency,
      o.status,
      o.created_at AS "createdAt",
      COALESCE(
        json_agg(
          json_build_object(
            'productId', oi.product_id,
            'name', oi.name,
            'qty', oi.qty,
            'unitPrice', oi.unit_price::float,
            'lineTotal', oi.line_total::float
          )
        ) FILTER (WHERE oi.id IS NOT NULL),
        '[]'::json
      ) AS items
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    WHERE o.user_id = $1
    GROUP BY o.id
    ORDER BY o.created_at DESC
    `,
    [req.user.sub]
  )
    .then((result) => res.json({ items: result.rows }))
    .catch((error) => res.status(500).json({ error: "Failed to fetch orders", detail: error.message }));
});

// --- Lab (staff JWT) ---
app.post("/api/lab/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });

  try {
    const user = await loginUserRow(email, password);
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    if (user.role !== "staff") return res.status(403).json({ error: "Not a staff account — customers use /store/" });

    const token = signUserToken(user);
    res.json({ token, user: publicUser(user, { includeRole: true }) });
  } catch (error) {
    res.status(500).json({ error: "Login failed", detail: error.message });
  }
});

app.get("/api/lab/me", verifyToken, hydrateUserRole, requireStaff, (req, res) => {
  res.json({ user: req.user });
});

app.get("/api/lab/account", verifyToken, hydrateUserRole, requireStaff, (req, res) => {
  query(`SELECT id, email, name, role, created_at FROM users WHERE id = $1 LIMIT 1`, [req.user.sub])
    .then((result) => {
      if (!result.rowCount) return res.status(404).json({ error: "User not found in database" });
      res.json({ account: publicUser(result.rows[0], { includeRole: true }) });
    })
    .catch((error) => res.status(500).json({ error: "Failed to load account", detail: error.message }));
});

app.get("/api/lab/events", verifyToken, hydrateUserRole, requireStaff, (_req, res) => {
  query(`SELECT id, type, order_id AS "orderId", payload, created_at AS "createdAt" FROM events ORDER BY created_at DESC LIMIT 100`)
    .then((result) => res.json({ items: result.rows }))
    .catch((error) => res.status(500).json({ error: "Failed to fetch events", detail: error.message }));
});

app.post("/api/lab/events/simulate", verifyToken, hydrateUserRole, requireStaff, (req, res) => {
  const type = req.body?.type || "lead.created";
  const payload = req.body?.payload || { source: "lab", score: 78 };
  insertEventRow(type, payload)
    .then((event) => res.status(201).json({ event }))
    .catch((error) => res.status(500).json({ error: "Failed to simulate event", detail: error.message }));
});

app.get("/api/lab/orders", verifyToken, hydrateUserRole, requireStaff, (_req, res) => {
  query(
    `
    SELECT
      o.id,
      o.user_id AS "userId",
      u.email AS "userEmail",
      u.name AS "userName",
      o.total::float AS total,
      o.currency,
      o.status,
      o.created_at AS "createdAt",
      COALESCE(
        json_agg(
          json_build_object(
            'productId', oi.product_id,
            'name', oi.name,
            'qty', oi.qty,
            'unitPrice', oi.unit_price::float,
            'lineTotal', oi.line_total::float
          )
        ) FILTER (WHERE oi.id IS NOT NULL),
        '[]'::json
      ) AS items
    FROM orders o
    LEFT JOIN users u ON u.id = o.user_id
    LEFT JOIN order_items oi ON oi.order_id = o.id
    GROUP BY o.id, u.id, u.email, u.name
    ORDER BY o.created_at DESC
    LIMIT 200
    `
  )
    .then((result) => res.json({ items: result.rows }))
    .catch((error) => res.status(500).json({ error: "Failed to fetch orders", detail: error.message }));
});

app.post("/api/lab/orders", verifyToken, hydrateUserRole, requireStaff, (req, res) => {
  (async () => {
    const { customerUserId, items } = req.body || {};
    if (!customerUserId) return res.status(400).json({ error: "customerUserId is required" });

    const u = await query(`SELECT id, role FROM users WHERE id = $1 LIMIT 1`, [customerUserId]);
    if (!u.rowCount) return res.status(404).json({ error: "Customer not found" });
    if (u.rows[0].role !== "customer") return res.status(400).json({ error: "Target user must be a customer" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { order } = await createOrderForUserId(customerUserId, items, client);
      await client.query("COMMIT");
      void dispatchN8nWebhook("order", order);
      res.status(201).json({ order });
    } catch (error) {
      await client.query("ROLLBACK");
      const msg = error.message || String(error);
      if (msg.includes("items") || msg.includes("Unknown") || msg.includes("qty")) return res.status(400).json({ error: msg });
      res.status(500).json({ error: "Failed to create order", detail: msg });
    } finally {
      client.release();
    }
  })();
});

app.get("/api/lab/bookings", verifyToken, hydrateUserRole, requireStaff, (_req, res) => {
  query(
    `
    SELECT b.id, b.user_id AS "userId", u.email AS "userEmail", b.email, b.name,
           b.check_in AS "checkIn", b.check_out AS "checkOut", b.guests, b.room_type AS "roomType",
           b.status, b.created_at AS "createdAt"
    FROM bookings b
    LEFT JOIN users u ON u.id = b.user_id
    ORDER BY b.created_at DESC
    LIMIT 200
    `
  )
    .then((result) => res.json({ items: result.rows }))
    .catch((error) => res.status(500).json({ error: "Failed to fetch bookings", detail: error.message }));
});

app.get("/api/lab/leads", verifyToken, hydrateUserRole, requireStaff, (_req, res) => {
  query(
    `SELECT id, email, name, message, product_id AS "productId", source, meta, created_at AS "createdAt" FROM leads ORDER BY created_at DESC LIMIT 200`
  )
    .then((result) => res.json({ items: result.rows }))
    .catch((error) => res.status(500).json({ error: "Failed to fetch leads", detail: error.message }));
});

app.get("/api/lab/admin/users", verifyToken, hydrateUserRole, requireStaff, (_req, res) => {
  query(`SELECT id, email, name, role, created_at FROM users ORDER BY created_at DESC`)
    .then((result) => res.json({ items: result.rows.map((row) => publicUser(row, { includeRole: true })) }))
    .catch((error) => res.status(500).json({ error: "Failed to fetch users", detail: error.message }));
});

app.post("/api/lab/admin/users", verifyToken, hydrateUserRole, requireStaff, async (req, res) => {
  const { email, password, name, role } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
  if (String(password).length < 6) return res.status(400).json({ error: "Password must be at least 6 chars" });
  if (role === "staff") {
    return res.status(403).json({
      error: "Staff cannot be created via API",
      hint: "Singurul staff automat este din LAB_STAFF_EMAIL + LAB_STAFF_PASSWORD la boot; client existent → LAB_STAFF_PROMOTE."
    });
  }
  if (!LAB_ALLOW_MANUAL_USERS) {
    return res.status(403).json({
      error: "Lab manual user creation is disabled",
      hint: "Clienți reali: POST /api/store/auth/register sau formularul din /store/. Pentru dev local setează LAB_ALLOW_MANUAL_USERS=true."
    });
  }

  try {
    const existing = await query(`SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`, [email]);
    if (existing.rowCount) return res.status(409).json({ error: "User already exists" });

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await query(
      `INSERT INTO users (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'customer') RETURNING id, email, name, role, created_at`,
      [nanoid(10), email, name || "User", passwordHash]
    );

    res.status(201).json(publicUser(result.rows[0], { includeRole: true }));
  } catch (error) {
    res.status(500).json({ error: "Failed to create user", detail: error.message });
  }
});

app.get("/api/lab/n8n/webhook-payload/order-created/:id", verifyToken, hydrateUserRole, requireStaff, (req, res) => {
  query(
    `
    SELECT
      o.id,
      o.user_id AS "userId",
      o.total::float AS total,
      o.currency,
      o.status,
      o.created_at AS "createdAt",
      COALESCE(
        json_agg(
          json_build_object(
            'productId', oi.product_id,
            'name', oi.name,
            'qty', oi.qty,
            'unitPrice', oi.unit_price::float,
            'lineTotal', oi.line_total::float
          )
        ) FILTER (WHERE oi.id IS NOT NULL),
        '[]'::json
      ) AS items
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    WHERE o.id = $1
    GROUP BY o.id
    LIMIT 1
    `,
    [req.params.id]
  )
    .then((result) => {
      if (!result.rowCount) return res.status(404).json({ error: "Order not found" });
      res.json({
        event: "order.created",
        emittedAt: new Date().toISOString(),
        data: result.rows[0]
      });
    })
    .catch((error) => res.status(500).json({ error: "Failed to prepare webhook payload", detail: error.message }));
});

// Legacy shims (same JWT shape; prefer /api/store/* and /api/lab/*)
app.get("/api/products", (_req, res) => {
  query(`SELECT id, name, slug, price::float AS price, currency, stock FROM products ORDER BY name ASC`)
    .then((result) => res.json({ items: result.rows }))
    .catch((error) => res.status(500).json({ error: "Failed to fetch products", detail: error.message }));
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
  try {
    const user = await loginUserRow(email, password);
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    if (user.role === "staff") {
      return res.status(403).json({
        error: "Staff must use POST /api/lab/auth/login — legacy /api/auth/login is customer-only."
      });
    }
    const token = signUserToken(user);
    res.json({
      token,
      user: publicUser(user, { includeRole: true }),
      hint: "Prefer POST /api/store/auth/login (customers) or POST /api/lab/auth/login (staff)."
    });
  } catch (error) {
    res.status(500).json({ error: "Login failed", detail: error.message });
  }
});

const publicDir = path.join(__dirname, "public");
const storeDir = path.join(publicDir, "store");
const labDir = path.join(publicDir, "lab");

app.get("/", (_req, res) => res.redirect(302, "/store/"));

function noStoreForIndexHtml(res, filePath) {
  if (filePath.replace(/\\/g, "/").endsWith("/index.html")) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
  }
}

app.use(
  "/store",
  express.static(storeDir, {
    fallthrough: true,
    setHeaders: (res, filePath) => noStoreForIndexHtml(res, filePath)
  })
);
app.use("/store", (_req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.sendFile(path.join(storeDir, "index.html"));
});

app.use(
  "/lab",
  express.static(labDir, {
    fallthrough: true,
    setHeaders: (res, filePath) => noStoreForIndexHtml(res, filePath)
  })
);
app.use("/lab", (_req, res) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.sendFile(path.join(labDir, "index.html"));
});

app.use(express.static(publicDir, { index: false }));

app.get("*", (req, res) => {
  if (req.path.startsWith("/api")) return res.status(404).json({ error: "Not found" });
  res.redirect(302, "/store/");
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`n8n-lab-live on http://localhost:${PORT}  (store: /store/  lab: /lab/)`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize database:", error);
    process.exit(1);
  });
