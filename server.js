const express = require("express");
const cors = require("cors");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { nanoid } = require("nanoid");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const DATABASE_URL = process.env.DATABASE_URL || "";

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required. Add a Postgres connection string in environment variables.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(express.json({ limit: "1mb" }));

async function query(text, params = []) {
  return pool.query(text, params);
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      price NUMERIC(10,2) NOT NULL,
      currency TEXT NOT NULL DEFAULT 'EUR',
      stock INTEGER NOT NULL DEFAULT 0
    );
  `);

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

  const countResult = await query(`SELECT COUNT(*)::int AS count FROM products`);
  if (countResult.rows[0].count === 0) {
    await query(
      `
      INSERT INTO products (id, name, price, currency, stock)
      VALUES
        ('prod_1', 'Starter Automation Audit', 79, 'EUR', 20),
        ('prod_2', 'Lead Capture Workflow Pack', 149, 'EUR', 12),
        ('prod_3', 'n8n Support Retainer (monthly)', 199, 'EUR', 99)
      `
    );
  }
}

function authRequired(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Missing token" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (_) {
    res.status(401).json({ error: "Invalid token" });
  }
}

function adminGuard(req, res, next) {
  if (!ADMIN_KEY) return next();
  const key = req.headers["x-admin-key"];
  if (key !== ADMIN_KEY) return res.status(403).json({ error: "Invalid admin key" });
  next();
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.created_at || user.createdAt
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "n8n-lab-live", db: "postgres", now: new Date().toISOString() });
});

app.post("/api/auth/register", async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
  if (String(password).length < 6) return res.status(400).json({ error: "Password must be at least 6 chars" });

  try {
    const existing = await query(`SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`, [email]);
    if (existing.rowCount) return res.status(409).json({ error: "User already exists" });

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await query(
      `
      INSERT INTO users (id, email, name, password_hash)
      VALUES ($1, $2, $3, $4)
      RETURNING id, email, name, created_at
      `,
      [nanoid(10), email, name || "User", passwordHash]
    );

    res.status(201).json(publicUser(result.rows[0]));
  } catch (error) {
    res.status(500).json({ error: "Failed to create user", detail: error.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });

  try {
    const result = await query(
      `SELECT id, email, name, password_hash, created_at FROM users WHERE lower(email) = lower($1) LIMIT 1`,
      [email]
    );
    if (!result.rowCount) return res.status(401).json({ error: "Invalid credentials" });

    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign({ sub: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: publicUser(user) });
  } catch (error) {
    res.status(500).json({ error: "Login failed", detail: error.message });
  }
});

app.get("/api/admin/users", adminGuard, (req, res) => {
  query(`SELECT id, email, name, created_at FROM users ORDER BY created_at DESC`)
    .then((result) => res.json({ items: result.rows.map(publicUser) }))
    .catch((error) => res.status(500).json({ error: "Failed to fetch users", detail: error.message }));
});

app.post("/api/admin/users", adminGuard, async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
  if (String(password).length < 6) return res.status(400).json({ error: "Password must be at least 6 chars" });

  try {
    const existing = await query(`SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`, [email]);
    if (existing.rowCount) return res.status(409).json({ error: "User already exists" });

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await query(
      `
      INSERT INTO users (id, email, name, password_hash)
      VALUES ($1, $2, $3, $4)
      RETURNING id, email, name, created_at
      `,
      [nanoid(10), email, name || "User", passwordHash]
    );

    res.status(201).json(publicUser(result.rows[0]));
  } catch (error) {
    res.status(500).json({ error: "Failed to create user", detail: error.message });
  }
});

app.get("/api/me", authRequired, (req, res) => {
  res.json({ user: req.user });
});

app.get("/api/account", authRequired, (req, res) => {
  query(`SELECT id, email, name, created_at FROM users WHERE id = $1 LIMIT 1`, [req.user.sub])
    .then((result) => {
      if (!result.rowCount) return res.status(404).json({ error: "User not found in database" });
      res.json({ account: publicUser(result.rows[0]) });
    })
    .catch((error) => res.status(500).json({ error: "Failed to load account", detail: error.message }));
});

app.get("/api/products", (_req, res) => {
  query(`SELECT id, name, price::float AS price, currency, stock FROM products ORDER BY name ASC`)
    .then((result) => res.json({ items: result.rows }))
    .catch((error) => res.status(500).json({ error: "Failed to fetch products", detail: error.message }));
});

app.post("/api/orders", authRequired, (req, res) => {
  (async () => {
    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items[] is required" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const lineItems = [];
      let total = 0;

      for (const line of items) {
        const productResult = await client.query(
          `SELECT id, name, price::float AS price FROM products WHERE id = $1 LIMIT 1`,
          [line.productId]
        );
        if (!productResult.rowCount) return res.status(400).json({ error: `Unknown product: ${line.productId}` });

        const product = productResult.rows[0];
        const qty = Number(line.qty || 1);
        if (!Number.isFinite(qty) || qty < 1) return res.status(400).json({ error: "qty must be >= 1" });

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
      await client.query(
        `
        INSERT INTO orders (id, user_id, total, currency, status)
        VALUES ($1, $2, $3, 'EUR', 'created')
        `,
        [orderId, req.user.sub, Number(total.toFixed(2))]
      );

      for (const item of lineItems) {
        await client.query(
          `
          INSERT INTO order_items (order_id, product_id, name, qty, unit_price, line_total)
          VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [orderId, item.productId, item.name, item.qty, item.unitPrice, item.lineTotal]
        );
      }

      const order = {
        id: orderId,
        userId: req.user.sub,
        items: lineItems,
        total: Number(total.toFixed(2)),
        currency: "EUR",
        status: "created",
        createdAt: new Date().toISOString()
      };

      const event = {
        id: "evt_" + nanoid(10),
        type: "order.created",
        orderId: order.id,
        payload: order,
        createdAt: new Date().toISOString()
      };

      await client.query(
        `INSERT INTO events (id, type, order_id, payload) VALUES ($1, $2, $3, $4::jsonb)`,
        [event.id, event.type, event.orderId, JSON.stringify(event.payload)]
      );

      await client.query("COMMIT");
      res.status(201).json({ order, event });
    } catch (error) {
      await client.query("ROLLBACK");
      res.status(500).json({ error: "Failed to create order", detail: error.message });
    } finally {
      client.release();
    }
  })();
});

app.get("/api/orders", authRequired, (req, res) => {
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

app.get("/api/events", authRequired, (_req, res) => {
  query(
    `
    SELECT id, type, order_id AS "orderId", payload, created_at AS "createdAt"
    FROM events
    ORDER BY created_at DESC
    LIMIT 50
    `
  )
    .then((result) => res.json({ items: result.rows }))
    .catch((error) => res.status(500).json({ error: "Failed to fetch events", detail: error.message }));
});

app.post("/api/events/simulate", authRequired, (req, res) => {
  const type = req.body?.type || "lead.created";
  const payload = req.body?.payload || { source: "manual", score: 78 };
  const event = {
    id: "evt_" + nanoid(10),
    type,
    payload,
    createdAt: new Date().toISOString()
  };

  query(
    `INSERT INTO events (id, type, payload) VALUES ($1, $2, $3::jsonb)`,
    [event.id, event.type, JSON.stringify(event.payload)]
  )
    .then(() => res.status(201).json({ event }))
    .catch((error) => res.status(500).json({ error: "Failed to simulate event", detail: error.message }));
});

app.get("/api/n8n/webhook-payload/order-created/:id", authRequired, (req, res) => {
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

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`n8n-lab-live running on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize database:", error);
    process.exit(1);
  });
