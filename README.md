# n8n Lab Live

Live playground for learning n8n with:
- webhook testing UI
- auth (register/login with JWT)
- mock e-commerce APIs (products, orders, events)
- PostgreSQL persistence (users/orders/events)
- didactic roadmap and guided labs

## Run locally

1. Install dependencies:

```bash
npm install
```

2. Copy env:

```bash
copy .env.example .env
```

3. Set `DATABASE_URL` in `.env` (required, Postgres connection string).

4. Start:

```bash
npm start
```

5. Open:
- `http://localhost:3000`

## API endpoints

- `GET /api/health`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/me` (auth)
- `GET /api/account` (auth) — reads your row from `users` (no admin key; use this to confirm the account exists after login)

**Admin user list:** `GET /api/admin/users` is protected when `ADMIN_KEY` is set on the server. The lab UI must send the same value in **Admin Key** (`x-admin-key`). Without it, the list returns 403 even though login and `/api/account` work.
- `GET /api/products`
- `POST /api/orders` (auth)
- `GET /api/orders` (auth)
- `GET /api/events` (auth)
- `POST /api/events/simulate` (auth)
- `GET /api/n8n/webhook-payload/order-created/:id` (auth)

## Deploy on Render (quickest)

1. Push this folder to GitHub.
2. In Render, create a **new Blueprint** and select the repo.
3. Render auto-detects `render.yaml`.
4. Set/confirm environment variables:
   - `JWT_SECRET`
   - `ADMIN_KEY` (optional, recommended)
   - `DATABASE_URL` (required)
5. Deploy.

After deploy, open your URL and set **API Base URL** to the same URL.

## Render Postgres setup (Etapa 1)

1. In Render dashboard: **New +** -> **PostgreSQL**
2. Create database (free plan is fine for learning).
3. Open the DB and copy **External Database URL**.
4. In your `n8n-lab-live` web service -> **Environment**:
   - set `DATABASE_URL` to that value
   - keep `JWT_SECRET` and `ADMIN_KEY`
5. Redeploy latest commit.

## n8n real-world tests you can do now

- `Webhook -> Validate -> Google Sheets -> Gmail`
- `Order created event -> Slack/Email alert`
- `Lead event simulation -> CRM route by score`
- `RAG question payload -> vector flow`
