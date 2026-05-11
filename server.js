const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { nanoid } = require("nanoid");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret_change_me";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const DATA_FILE = path.join(__dirname, "data", "db.json");

app.use(cors());
app.use(express.json({ limit: "1mb" }));

function ensureDataFile() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(DATA_FILE)) {
    const initial = {
      users: [],
      products: [
        { id: "prod_1", name: "Starter Automation Audit", price: 79, currency: "EUR", stock: 20 },
        { id: "prod_2", name: "Lead Capture Workflow Pack", price: 149, currency: "EUR", stock: 12 },
        { id: "prod_3", name: "n8n Support Retainer (monthly)", price: 199, currency: "EUR", stock: 99 }
      ],
      orders: [],
      events: []
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2), "utf8");
  }
}

function readDb() {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function writeDb(db) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), "utf8");
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
    createdAt: user.createdAt
  };
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "n8n-lab-live", now: new Date().toISOString() });
});

app.post("/api/auth/register", async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
  if (String(password).length < 6) return res.status(400).json({ error: "Password must be at least 6 chars" });

  const db = readDb();
  const existing = db.users.find((u) => u.email.toLowerCase() === String(email).toLowerCase());
  if (existing) return res.status(409).json({ error: "User already exists" });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = { id: nanoid(10), email, name: name || "User", passwordHash, createdAt: new Date().toISOString() };
  db.users.push(user);
  writeDb(db);

  res.status(201).json(publicUser(user));
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });

  const db = readDb();
  const user = db.users.find((u) => u.email.toLowerCase() === String(email).toLowerCase());
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  const token = jwt.sign({ sub: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user: publicUser(user) });
});

app.get("/api/admin/users", adminGuard, (req, res) => {
  const db = readDb();
  res.json({ items: db.users.map(publicUser) });
});

app.post("/api/admin/users", adminGuard, async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
  if (String(password).length < 6) return res.status(400).json({ error: "Password must be at least 6 chars" });

  const db = readDb();
  const existing = db.users.find((u) => u.email.toLowerCase() === String(email).toLowerCase());
  if (existing) return res.status(409).json({ error: "User already exists" });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = { id: nanoid(10), email, name: name || "User", passwordHash, createdAt: new Date().toISOString() };
  db.users.push(user);
  writeDb(db);

  res.status(201).json(publicUser(user));
});

app.get("/api/me", authRequired, (req, res) => {
  res.json({ user: req.user });
});

app.get("/api/products", (_req, res) => {
  const db = readDb();
  res.json({ items: db.products });
});

app.post("/api/orders", authRequired, (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "items[] is required" });
  }

  const db = readDb();
  const lineItems = [];
  let total = 0;

  for (const line of items) {
    const product = db.products.find((p) => p.id === line.productId);
    if (!product) return res.status(400).json({ error: `Unknown product: ${line.productId}` });

    const qty = Number(line.qty || 1);
    if (!Number.isFinite(qty) || qty < 1) return res.status(400).json({ error: "qty must be >= 1" });

    lineItems.push({
      productId: product.id,
      name: product.name,
      qty,
      unitPrice: product.price,
      lineTotal: Number((qty * product.price).toFixed(2))
    });
    total += qty * product.price;
  }

  const order = {
    id: "ord_" + nanoid(8),
    userId: req.user.sub,
    items: lineItems,
    total: Number(total.toFixed(2)),
    currency: "EUR",
    status: "created",
    createdAt: new Date().toISOString()
  };
  db.orders.push(order);

  const event = {
    id: "evt_" + nanoid(10),
    type: "order.created",
    orderId: order.id,
    payload: order,
    createdAt: new Date().toISOString()
  };
  db.events.push(event);

  writeDb(db);
  res.status(201).json({ order, event });
});

app.get("/api/orders", authRequired, (req, res) => {
  const db = readDb();
  const items = db.orders.filter((o) => o.userId === req.user.sub);
  res.json({ items });
});

app.get("/api/events", authRequired, (_req, res) => {
  const db = readDb();
  res.json({ items: db.events.slice(-50).reverse() });
});

app.post("/api/events/simulate", authRequired, (req, res) => {
  const db = readDb();
  const type = req.body?.type || "lead.created";
  const payload = req.body?.payload || { source: "manual", score: 78 };
  const event = {
    id: "evt_" + nanoid(10),
    type,
    payload,
    createdAt: new Date().toISOString()
  };
  db.events.push(event);
  writeDb(db);
  res.status(201).json({ event });
});

app.get("/api/n8n/webhook-payload/order-created/:id", authRequired, (req, res) => {
  const db = readDb();
  const order = db.orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: "Order not found" });

  res.json({
    event: "order.created",
    emittedAt: new Date().toISOString(),
    data: order
  });
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`n8n-lab-live running on http://localhost:${PORT}`);
});
