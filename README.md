# CampusMarketplace — WhatsApp Bot (Supabase edition)

Baileys-based WhatsApp bot. No MongoDB, no Flutterwave — uses **Supabase**
(Postgres + Storage) and **manual bank transfer** payments reviewed by you,
exactly like your Telegram bot's receipt-approval flow.

---

## What changed from the first draft

- ❌ MongoDB → ✅ **Supabase** (Postgres tables + file storage, one dashboard for both)
- ❌ Flutterwave automated checkout → ✅ **Manual payment**: user sees your bank
  account, transfers, sends a screenshot, you approve/reject it from WhatsApp
- Buyers **never pay anything**. Only sellers optionally pay to pin a listing (Pro).

---

## Step-by-step setup

### 1. Create your Supabase project
1. Go to `supabase.com` → Sign up / log in → **New project**
2. Pick a name, a strong database password, and a region close to Nigeria (e.g. `eu-west` or `ap-south`)
3. Wait ~2 minutes for it to provision

### 2. Run the database schema
1. In your Supabase project, open **SQL Editor** (left sidebar)
2. Click **New query**
3. Open `schema.sql` from this project, paste the entire contents in, click **Run**
4. This creates all tables (`users`, `products`, `settings`, `payment_receipts`, `auth_state`) and two storage buckets (`product-media`, `payment-receipts`)

### 3. Add your bank account details
1. Go to **Table Editor** → `settings` table
2. Open the one existing row, edit the `bank_accounts` column (it's JSON), e.g.:
   ```json
   [
     { "bankName": "GTBank", "accountNumber": "0123456789", "accountName": "Daniel ...", "active": true }
   ]
   ```
3. Save. This is what sellers see when upgrading to Pro.

### 4. Get your Supabase API keys
1. **Project Settings** → **API**
2. Copy the **Project URL** → this is `SUPABASE_URL`
3. Copy the **service_role** key (NOT the `anon` key — service_role bypasses
   security rules since this bot runs as a trusted server, not a browser) → `SUPABASE_SERVICE_ROLE_KEY`

### 5. Fill in `.env`
Copy `.env.example` to `.env` and fill in:
```
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
ADMIN_WHATSAPP=234...        (your number, digits only, no +)
PORT=3000
```
Note: there's no `BOT_PHONE_NUMBER` variable anymore — you enter that number
from the web dashboard instead (step 7).

### 6. Deploy to Railway
1. Push this project to a GitHub repo
2. Railway → **New Project → Deploy from GitHub** → select the repo
3. Railway auto-detects Node.js and deploys
4. Go to **Variables** tab → add the 3 vars from your `.env`
5. Once deployed, Railway gives you a live URL like `https://your-app.up.railway.app`

### 7. Link WhatsApp from the dashboard (no terminal, no laptop needed)
1. Open your Railway URL in any browser (works fine on your phone)
2. You'll see a live status dot (🔴 not connected) and a **"Link WhatsApp"** box
3. Type in the number the bot should run on (country code, no +) — use a
   **dedicated SIM, not your main number** — and tap **Get Pairing Code**
4. An 8-character code appears on the page
5. On the phone with that number: WhatsApp → **Settings → Linked Devices →
   Link a Device → "Link with phone number instead"** → type the code
6. The status dot turns 🟢 within a few seconds — the dashboard polls
   automatically, no refresh needed

Once linked, the session is saved into your Supabase `auth_state` table (and
the connection status is mirrored there too), so:
- Redeploys don't disconnect the bot
- If the bot ever does disconnect, reopen the dashboard and you'll immediately
  see the red status and can re-link right there

### 8. Test it
- Message the bot number from any other WhatsApp number → should ask your name → email → show main menu
- Reply `2` to test the sell flow → fill in details → send a photo → reply `done`
- On your admin number, you should get a "New Listing Pending Review" message — reply `approve <id>`
- Reply `1` (Buy) as a test user → the approved listing should now show

---

## How the money flow works (manual, matches your Telegram bot)

1. Seller replies `4` (Upgrade a Listing to Pro) from the main menu
2. Bot shows their eligible listings → picks one → picks number of days
3. Bot calculates the amount (`days × pro_price_per_day` from `settings`) and
   shows your bank account details
4. Seller transfers, then **sends a screenshot** in the chat
5. Bot uploads the screenshot to Supabase Storage (`payment-receipts` bucket)
   and creates a `payment_receipts` row with status `pending`
6. You (admin) get the screenshot forwarded to your WhatsApp with the receipt ID
7. You reply `approve receipt <id>` → listing gets pinned (`is_premium = true`)
   for the paid number of days, seller gets notified
   — or `reject receipt <id> [reason]` → seller gets notified with the reason

Buyers never see a payment step anywhere in the Buy flow.

---

## Web dashboard (new)

Your Railway URL now serves a small dashboard (`public/index.html`) with:

- **Live connection status** — green/yellow/red dot, auto-refreshes every 5s,
  shows the linked number and when it was last updated
- **Link/re-link WhatsApp** — type a number, get a pairing code, right in the browser
- **Quick stats** — pending listings, active listings, pending receipts, total
  users, refreshing every 15s, so you can check bot health from your phone
  without needing to message it

Endpoints behind it, if you want to build on them:
- `GET /api/status` → `{ status: 'open'|'close'|'connecting', phone, updatedAt }`
- `GET /api/stats` → counts for the dashboard cards
- `POST /api/link` `{ phone }` → returns `{ code }` or `{ alreadyLinked: true }`

## Admin commands (all plain text, no menu needed)

| Command | Effect |
|---|---|
| `pending` | List listings awaiting review |
| `approve <id>` / `reject <id> [reason]` | Review a listing |
| `listings` | Show active listings |
| `sold <id>` | Mark a listing sold |
| `receipts` | List pending payment receipts |
| `approve receipt <id>` / `reject receipt <id> [reason]` | Review a payment |
| `settings` | View bank/pricing settings |
| `setbank Bank Name \| Account Number \| Account Name` | Add a bank account (no more editing the Supabase table by hand) |
| `removebank <number>` | Remove a bank account — number is shown in `settings` |
| `setprice <amount>` | Set the Pro price per day, in ₦ |

Example: `setbank GTBank | 0123456789 | Daniel Adebayo`

---

## Interactive buttons (with automatic text fallback)

The main menu and the "view item" screen now try to send real tappable
WhatsApp buttons instead of a plain numbered list.

**Important honesty check:** WhatsApp has been inconsistent about rendering
these outside its official paid Business API — they show up fine on some
phones/app versions and just don't appear at all on others, and WhatsApp can
change this at any time without warning since it's not an officially
supported feature for third-party tools like Baileys. This is not a bug in
this bot; it's a platform-level limitation of every unofficial WhatsApp
library (Baileys, WAHA, whatsapp-web.js, WireWeb — all of them).

Because of that, `utils/buttons.js` sends the buttons but **every option still
accepts the plain typed number too** ("1", "2", etc.) — so if a user's
WhatsApp doesn't render the buttons, they just type the number they see in
the message body and the bot works exactly the same either way. Nothing
breaks either way.

---

## What's intentionally left for you to extend

- Full product field set (brand, subcategory, warranty, repairs — the
  `products` table already has room in `schema.sql` if you add more STEPS
  entries in `handlers/sell.js`)
- Broadcast messaging to all users
- Keyword search in Buy flow (Supabase full-text search or `ilike`)
- Rate limiting on the sell flow

## A word of caution

Baileys is an unofficial WhatsApp client — same category as WireWeb, WAHA,
whatsapp-web.js. WhatsApp doesn't officially support bots built this way.
Fine for a campus-scale marketplace, but **use a dedicated SIM** for
`BOT_PHONE_NUMBER`, never your personal daily-driver number.
