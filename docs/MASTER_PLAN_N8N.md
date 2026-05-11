# Plan master: de la zero la „guru nivel 1” pe n8n-lab

Acest plan e gândit **doar** pentru ce există deja în proiect (magazin + lab + API). După ce îl parcurgi confortabil, extinzi spre servicii externe (Gmail, Slack, Sheets).

---

## Partea 0 — să nu te mai încurce capul (10 minute)

### Ce e **Magazinul** (`/store/`)?

- Pagina pentru **„clienți”** (testeri, prieteni, tu când vrei să simulezi un cumpărător).
- Aici: produse, coș, cont client, comandă, lead, rezervare.
- **Nu** e pentru webhook-uri tehnice sau listă de useri.

### Ce e **Lab-ul** (`/lab/`)?

- **Consola ta** (cont **staff** — `LAB_STAFF_EMAIL` / parola din Render).
- Aici: test webhook către **n8n** (trimiți JSON spre URL-ul tău), timeline cu **toate** evenimentele din DB, simulări, listă useri (cu Admin Key dacă e setat pe server).

### Ce e **API-ul** (`/api/...`)?

- **Limba** dintre browser și server (și între **n8n** și server).
- n8n nu „vede” magazinul; folosește **HTTP Request** sau **Webhook** la aceste URL-uri.

### Webhook — două sensuri (asta încurcă pe toată lumea)


| Sens             | Cine apelează pe cine                                  | În lab-ul tău                                                                                       |
| ---------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| **A → n8n**      | Serverul tău trimite ceva **către** n8n după o acțiune | Variabile `N8N_ORDER_WEBHOOK_URL`, `N8N_LEAD_WEBHOOK_URL`, `N8N_BOOKING_WEBHOOK_URL` (POST automat) |
| **n8n → server** | n8n trimite un request **către** API-ul tău            | De ex. n8n face `POST /api/store/leads` sau `GET /api/store/products`                               |


**Webhook node în n8n** = n8n **ascultă**; primește POST din exterior (inclusiv din aplicația ta dacă pui URL-ul acelui nod în `N8N_*_WEBHOOK_URL`).

**HTTP Request în n8n** = n8n **apelează** API-ul tău (magazin sau lab).

---

## Partea 1 — harta API (ce ai deja)

Baza URL: `https://<serviciul-tau>.onrender.com` (sau `http://localhost:3000`).

### Fără cont (public)


| Metodă | Rută                                  | Rol                                                                     |
| ------ | ------------------------------------- | ----------------------------------------------------------------------- |
| GET    | `/api/health`                         | Verifică că serviciul și DB merg                                        |
| GET    | `/api/store/products`                 | Lista produse                                                           |
| GET    | `/api/store/products/:id` sau `:slug` | Detaliu produs                                                          |
| POST   | `/api/store/leads`                    | Lead (rate limit)                                                       |
| POST   | `/api/store/bookings`                 | Rezervare (rate limit); opțional `Authorization: Bearer <token client>` |


### Cont **client** (după register/login în magazin)


| Metodă   | Rută                       | Header                          |
| -------- | -------------------------- | ------------------------------- |
| POST     | `/api/store/auth/register` | Body JSON                       |
| POST     | `/api/store/auth/login`    | Body JSON                       |
| GET      | `/api/store/account`       | `Authorization: Bearer <token>` |
| GET/POST | `/api/store/orders`        | Bearer                          |
| GET      | `/api/store/bookings/me`   | Bearer                          |


### Cont **staff** (login în `/lab/`)


| Metodă   | Rută                                                     | Header                                                |
| -------- | -------------------------------------------------------- | ----------------------------------------------------- |
| POST     | `/api/lab/auth/login`                                    | Body JSON → primești `token`                          |
| GET      | `/api/lab/events`                                        | Bearer staff                                          |
| GET      | `/api/lab/orders`, `/api/lab/leads`, `/api/lab/bookings` | Bearer staff                                          |
| POST     | `/api/lab/events/simulate`                               | Bearer staff                                          |
| GET/POST | `/api/lab/admin/users`                                   | Bearer staff |


---

## Partea 2 — plan pe săptămâni (poți comprima în zile dacă ai timp)

### Săptămâna 1 — „Înțeleg n8n și un singur API”

**Zi 1–2 (2 × 45 min)**  

1. Instalează / deschide **n8n** (cloud sau local).
2. Workflow nou: nod **Manual Trigger** → **HTTP Request** → `GET https://<host>/api/health` → rulează → citești JSON.
3. Al doilea nod: `GET .../api/store/products` → vezi lista.

**Zi 3–4**  
4. Workflow: **Manual** → **HTTP Request** `POST /api/store/auth/login` cu body `{ "email", "password" }` (un client creat din magazin).  
5. Extrage `token` din răspuns (în n8n: „Expression” sau nod **Set**).  
6. Nod următor: `GET /api/store/orders` cu header `Authorization: Bearer {{$json.token}}`.

**Rezultat săpt. 1:** știi să legi noduri, să citești JSON, să pui Bearer.

### Săptămâna 2 — Webhook (n8n ascultă)

**Zi 1–2**  
7. Workflow nou cu nod **Webhook** (POST), salvezi **Production URL**.  
8. În lab (`/lab/`), la „Webhook URL”, lipești acel URL, alegi template Lead, **Send** → în n8n vezi execuția cu body-ul primit.

**Zi 3–4**  
9. În Render pune `N8N_LEAD_WEBHOOK_URL` = același URL (sau alt workflow dedicat).  
10. Trimite un lead din **magazin** → verifici în n8n că a venit **POST**-ul de la server (envelope cu `kind: "lead"`).

**Rezultat săpt. 2:** înțelegi sensul „server → n8n” vs „lab trimite manual către n8n”.

### Săptămâna 3 — Staff și evenimente

**Zi 1–2**  
11. Workflow: `POST /api/lab/auth/login` (staff) → salvezi token staff.  
12. `GET /api/lab/events` cu Bearer → vezi `order.created`, `lead.created`, etc.

**Zi 3–4**  
13. **Schedule** (cron) în n8n la 5 min: login staff (sau token salvat în **Credentials** static — mai simplu la început: pui token manual în Credential și îl rotești când expiră) → `GET /api/lab/events` → **IF** pe `type` → ramuri diferite (ex. doar log / Telegram dacă îl conectezi mai târziu).

**Rezultat săpt. 3:** „monitor” pe evenimente, ca la un mic produs.

### Săptămâna 4 — Combinații (mini-proiecte)

1. **Lanț A:** Comandă în magazin → (webhook order deja pleacă dacă e configurat) → în n8n procesezi payload-ul.
2. **Lanț B:** Lead din magazin → n8n → (opțional) alt **HTTP Request** înapoi către un endpoint de test.
3. **Lanț C:** Rezervare în magazin → webhook booking → ramură după `roomType`.

**Rezultat săpt. 4:** ai 2–3 workflow-uri care nu sunt izolate.

---

## Partea 3 — „Guru nivel 1” — checklist final

Poți spune că ești nivel 1 pe **acest stack** dacă:

- Poți explora cuiva diferența **magazin vs lab** în 2 propoziții.  
- Deschizi **n8n** și faci **GET** la orice rută publică fără tutorial.  
- Obții **token client** și îl folosești la **GET orders** din n8n.  
- Obții **token staff** și îl folosești la **GET events**.  
- Ai un **Webhook** n8n care primește date din lab **Send** sau din server (lead/order/booking).  
- Ai făcut o **ramificare** (IF/Switch) după tip de eveniment sau după câmp din JSON.  
- Știi unde citești **erorile** (HTTP status, body, execuția din n8n).

---

## După nivel 1 — extensie naturală

- Google Sheets / Slack / Telegram ca acțiune după IF.  
- **Credential** n8n pentru token (nu hardcodat).  
- Retry și notificare la eșec.  
- Al doilea modul în app (ex. alt tip de business) — același tip de gândire: evenimente + API + webhook.

---

## Prima oră — fă astăzi, în ordine

1. Deschide magazinul → creează cont → o comandă mică.
2. Deschide lab → login staff → **Refresh feed** la evenimente.
3. n8n: **Manual** → **GET** `/api/health`.
4. n8n: **Manual** → **GET** `/api/store/products`.
5. n8n: workflow **Webhook** → copiază URL → lab → trimite o dată din „Webhook Lab”.

Dacă pașii 3–5 mergi fără panică, ești pe drumul corect; restul e repetare și combinații din planul pe săptămâni.