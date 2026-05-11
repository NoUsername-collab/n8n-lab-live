# n8n Lab Live

Live playground for learning n8n with:
- webhook testing UI
- auth (register/login with JWT)
- mock e-commerce APIs (products, orders, events)
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

3. Start:

```bash
npm start
```

4. Open:
- `http://localhost:3000`

## API endpoints

- `GET /api/health`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/me` (auth)
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
5. Deploy.

After deploy, open your URL and set **API Base URL** to the same URL.

## n8n real-world tests you can do now

- `Webhook -> Validate -> Google Sheets -> Gmail`
- `Order created event -> Slack/Email alert`
- `Lead event simulation -> CRM route by score`
- `RAG question payload -> vector flow`
