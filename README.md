# n8n Lab Live

Playground for learning **n8n** with a clean split:

| Surface | URL | Who | Purpose |
|--------|-----|-----|---------|
| **Magazin (demo e-commerce)** | `/store/` | Testers, clients | Catalog, coș, cont **client**, comenzi, **rezervări**, lead public |
| **Lab (staff)** | `/lab/` | Doar echipa | Webhook-uri, timeline, listă useri (fără creare automată de conturi în plus) |
| **API** | `/api/...` | Both | JSON pentru workflow-uri n8n |

## Arhitectură

- **`users.role`**: `customer` (magazin) sau `staff` (lab). **Clienți reali** doar prin **`/store/`** (`POST /api/store/auth/register`). **Un singur cont staff** poate fi creat automat la boot din **`LAB_STAFF_EMAIL`** + **`LAB_STAFF_PASSWORD`** dacă acel email **nu există** încă în DB. Nu există „înregistrare staff” în UI — nu se poate crea `staff` prin API.
- **`LAB_ALLOW_MANUAL_USERS`**: dacă **nu** e `true`, **`POST /api/lab/admin/users`** e dezactivat (implicit în producție fără env = oprit). În `.env` local pune `LAB_ALLOW_MANUAL_USERS=true` doar dacă vrei butonul din lab pentru conturi de test.
- **Store API** — prefix **`/api/store/`** (login/register doar clienți; lead fără auth).
- **Lab API** — prefix **`/api/lab/`** (JWT **staff**). Lista useri: **`GET /api/lab/admin/users`**. Creare user din lab: **`POST /api/lab/admin/users`** doar dacă **`LAB_ALLOW_MANUAL_USERS=true`** și creează **doar** `customer` (niciodată staff).
- **Staff vs „admin”** — există doar **rolul `staff` în Postgres** + login la `/lab/`. Nu mai există **`ADMIN_KEY`** / `x-admin-key` pentru acest proiect (era confuz și dublu). Dacă ai folosit același email ca la magazin înainte să fii staff, setează **`LAB_STAFF_PROMOTE=true`** în Render și redeploy: la boot, acel user devine `staff` și primește parola din **`LAB_STAFF_PASSWORD`**.
- **Evenimente** (`order.created`, `lead.created`, `booking.requested`, …) în **`events`**; staff le vede în lab. Leaduri în **`leads`**, rezervări în **`bookings`**.
- **Webhook-uri outbound** (opțional): după commit în DB, serverul trimite `POST` JSON către `N8N_*_WEBHOOK_URL`. Semnătură opțională HMAC-SHA256 în header **`X-Lab-Signature: sha256=<hex>`** dacă setezi **`N8N_WEBHOOK_SECRET`** (verifică în n8n cu Crypto node).
- **Rate limit** comun pentru **`POST /api/store/leads`** și **`POST /api/store/bookings`**: `STORE_PUBLIC_RATE_MAX` cereri / `STORE_PUBLIC_RATE_WINDOW_MS` per IP (implicit 40 / 15 min). Răspuns **429** + `retryAfterSec`.
- **Host-uri dedicate** (opțional): `STORE_HOST` / `LAB_HOST` (fără port) — cererea `GET /` pe acel host redirecționează către `/store/` sau `/lab/` (DNS CNAME către același serviciu Render).

## Run locally

```bash
npm install
copy .env.example .env
```

Setează în `.env`: `DATABASE_URL`, `JWT_SECRET`, și **obligatoriu pentru lab** `LAB_STAFF_EMAIL` + `LAB_STAFF_PASSWORD`.

```bash
npm start
```

- Magazin: http://localhost:3000/store/
- Lab staff: http://localhost:3000/lab/

## API (rezumat)

**Public / magazin**

- `GET /api/health` — `webhooks`, `hosts`, `rateLimit`, `lab.manualUserCreate`, `lab.staffFromEnv`
- `GET /api/store/products` · `GET /api/store/products/:idOrSlug`
- `POST /api/store/auth/register` · `POST /api/store/auth/login` (doar customer)
- `POST /api/store/leads` (fără auth, rate limit)
- `POST /api/store/bookings` (fără auth obligatoriu; rate limit; `Authorization: Bearer` opțional pentru legare cont)
- `GET /api/store/bookings/me` (JWT customer)
- `GET /api/store/account` · `POST /api/store/orders` · `GET /api/store/orders` (JWT customer)

**Lab (JWT staff)**

- `POST /api/lab/auth/login`
- `GET /api/lab/me` · `GET /api/lab/account`
- `GET /api/lab/events` · `POST /api/lab/events/simulate`
- `GET /api/lab/orders` (toate comenzile + email client)
- `POST /api/lab/orders` — body `{ "customerUserId", "items" }` (test din lab)
- `GET /api/lab/leads`
- `GET /api/lab/bookings`
- `GET /api/lab/admin/users` · `POST /api/lab/admin/users` (JWT staff; POST doar customer + doar dacă `LAB_ALLOW_MANUAL_USERS=true`)
- `GET /api/lab/n8n/webhook-payload/order-created/:id`

**Legacy (compat)**

- `GET /api/products` — același catalog ca store
- `POST /api/auth/login` — doar **customer** (staff trebuie `POST /api/lab/auth/login`).

## Deploy (Render)

Setează variabile: `DATABASE_URL`, `JWT_SECRET`, `LAB_STAFF_EMAIL`, `LAB_STAFF_PASSWORD`, opțional `LAB_STAFF_PROMOTE=true`, `LAB_STAFF_NAME`, webhook-uri `N8N_*`, `N8N_WEBHOOK_SECRET`, `STORE_HOST` / `LAB_HOST`, rate limit. **`LAB_ALLOW_MANUAL_USERS`** nu seta (sau `false`) pe producție ca să nu se mai poată crea conturi din lab. Poți șterge `ADMIN_KEY` dacă îl mai ai.

### Reset conturi în Postgres („supă” de useri de test)

Păstrezi produsele; ștergi toți userii și datele legate; la următorul restart se recreează **un singur** staff din `LAB_STAFF_*`:

```sql
TRUNCATE TABLE order_items, orders, bookings, leads, events, users RESTART IDENTITY CASCADE;
```

Apoi redeploy / restart app (rulează `ensureStaffUser` și inserează din nou staff-ul din env dacă emailul nu există).

După deploy: URL-ul serviciului = și **API Base** în lab, și originea pentru fetch în magazin (același host).

## n8n — idei de workflow

- Webhook magazin: `POST /api/store/leads` din formular extern sau din n8n HTTP Request către magazin.
- Polling: `GET /api/lab/events` cu token staff (după `POST /api/lab/auth/login`).
- Comandă nouă: eveniment `order.created` în DB după `POST /api/store/orders` sau `POST /api/lab/orders`; același flux poate declanșa și **webhook outbound** `N8N_ORDER_WEBHOOK_URL`.
- Rezervare: formular magazin → `booking.requested` + `N8N_BOOKING_WEBHOOK_URL`.
- Lead: `N8N_LEAD_WEBHOOK_URL`. Envelope JSON: `{ source, kind, emittedAt, data }`.
