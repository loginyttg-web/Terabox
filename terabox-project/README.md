# TeraBox Telegram Bot + API

TeraBox share-link resolver with an optional Telegram bot and (opt-in) file
upload to Telegram. Runs as a Node.js web service.

## Features

- **All TeraBox link domains** — terabox.app, terabox.com, 1024terabox.com,
  terasharelink.com, 4funbox.com, mirrobox.com, nephobox.com, freeterabox.com,
  teraboxlink.com and 40+ official/mirror domains. A share URL kisi bhi in
  domains me ho, kaam karega.
- **Sub-folder scan** — `/scan` (Telegram) ya `?scan=1` (API) recursively
  folder ke andar ki saari files nikal deta hai (depth up to 12, 5000 items).
- **Whole-folder upload** — `/uploadall` poore share (saare sub-folders samet)
  ko Telegram par upload karta hai.
- **>2GB file split** — 2GB se badi file ko 1.9GB ke ZIP parts me split karke
  upload karta hai (Telegram bot raw MTProto limit ~2GB ke liye safe).
- **Live admin dashboard** — `/admin` (Basic auth) real-time transfer progress
  bars + events + logs dikhata hai; SSE (`/admin/stream`) se instant updates.
- **Cookie update on the fly** — Telegram me `/setcookie` se bina redeploy
  cookies badlo.
- **Logs** — Telegram me `/logs` (aakhri 40 lines) ya `/admin/logs`.
- **Custom bot command menu** — bot start hote hi `/setcommands` auto-register
  karta hai (Telegram ke "/" button me dikhte hain).
- **Multiple concurrent jobs per chat** — `TRANSFER_MAX_JOBS_PER_CHAT` (default 1).
- **Keep-alive** — `KEEPALIVE_URLS` + `KEEPALIVE_INTERVAL_SECONDS`.
- **Dump channel + user tracking** — `TELEGRAM_DEST_CHANNEL_ID`: har naye user ka
  `/start` (user id/name/chat id) aur har resolved content ki copy dump channel
  me jati hai.
- **Access management** — owner `TELEGRAM_OWNER_ID` `/access <id>` se kisi bhi
  user ko runtime me access de sakta hai (persist hone ke liye disk-backed host
  chahiye; free /tmp pe restart par env-seed wapas aata hai).

## API Endpoints

- `GET /api?url=<terabox-share-url>` — TeraBox link resolve karo, download URL milega
- `GET /api?url=<terabox-share-url>&scan=1` — saare sub-folders scan karke full file list
- `GET /health` — Server + bot status
- `GET /` — API info
- `GET /admin` — Live dashboard (ADMIN_API_KEY required, Basic/Bearer auth)
- `GET /admin/status` — Dashboard JSON
- `GET /admin/logs` — Recent logs JSON
- `GET /admin/stream` — SSE real-time transfer updates (Basic auth ya `?token=`)

## Telegram commands

| Command | Kaam |
|---|---|
| `/start`, `/help` | Help message |
| `<TeraBox link>` (sirf bhejo) | Link resolve + file browser |
| `/link <URL>` | Link resolve karein |
| `/scan <URL>` | Saare sub-folders scan karein |
| `/setcookie <JSON>` | TeraBox cookies update karein |
| `/logs` | Aakhri 40 log lines |
| `/status` | Bot status |
| `/id` | Apna User ID + Chat ID dekhein |
| `/access <id>` | User ko access dein (owner only) |
| `/revoke <id>` | User ka access hatayein (owner only) |
| `/users` | Allowed users list (owner only) |
| `/upload <URL> [n]` | Ek file upload (upload on ho to) |
| `/uploadall <URL>` | Poore folder upload (upload on ho to) |
| `/jobs`, `/stats`, `/cancel` | Queue/stats/cancel (upload on ho to) |

## Requirements

- **Node.js 22+** (uses `node:sqlite`, `fetch`, streams)
- TeraBox cookies (see `.env.example`) for reliable resolution

## Local development

```bash
npm install
cp .env.example .env   # fill in your values
npm run dev            # tsx watch
# or
npm run build && npm start
```

## Cookie format (important)

`TERABOX_COOKIES_JSON` ek **JSON object** honi chahiye: cookie ka **name** → **value**.
Sabse zaroori cookie **`ndus`** hai (login session). Best hai ki browser se
**saari** TeraBox cookies paste karo (`ndus`, `browserid`, `TSID`, ...).

```
{"ndus":"abc...","browserid":"xyz...","TSID":"123..."}
```

Kisi specific cookie ki zaroorat nahi — jo bhi ho, sab JSON object me daal do.
`ndus` ke bina resolution reliable nahi hota. Deploy ke baad bhi Telegram me
`/setcookie {"ndus":"..."}` se runtime me update kar sakte ho (bina redeploy).

## Dump channel + access control

**Flow:**
1. Koi bhi user bot ko `/start` kare to uski **User ID, naam, Chat ID** dump
   channel (`TELEGRAM_DEST_CHANNEL_ID`) me jaati hai.
2. Agar user ke paas access nahi hai to use "restricted" reply milta hai.
3. Owner `TELEGRAM_OWNER_ID` ko `/users` se list, aur `/access <user-id>` se
   user ko allow karta hai (user `/id` se apna id bhejta hai).
4. Allowed user jab link resolve karta hai to **content ki copy** (file list +
   download links) dump channel me bhi jaati hai.
5. Upload enabled ho to upload ki file bhi dump channel me copy hoti hai.

**Setup:**
- `TELEGRAM_OWNER_ID` = owner ka Telegram id (required for /access).
- `TELEGRAM_DEST_CHANNEL_ID` = dump channel id (negative, e.g. `-100123...`).
- Bot ko dump channel me **admin** banao, warna wo wahan send nahi kar payega.
- Access grants SQLite me save hote hain. Free Render pe `/tmp` ephemeral hai,
  isliye restart par env-seeded users wapas aate hain (runtime grants reset).
  Persist karne ke liye disk-backed host (paid/`TRANSFER_DATABASE_PATH` persistent
  disk) use karo.

## Speed — parallel chunk download

`TRANSFER_DOWNLOAD_CHUNKS` env var se control karo (default: 16, max: 32).
16 parallel chunks usually improve throughput over a single connection, but
actual speed TeraBox, server bandwidth, and Telegram limits par depend karti hai. This only applies when
`TELEGRAM_UPLOAD_ENABLED=true`.

## Large-file upload (>2GB) — ZIP parts

- `TRANSFER_UPLOAD_LIMIT_MB` (default `1900`) = har part/ek file ka max size
  jo single upload me ja sakta hai.
- `TRANSFER_SPLIT_PART_MB` (default `1800`) = badi file ko kitne MB ke ZIP
  parts me todna hai. Telegram bot raw MTProto ~2GB limit ke andar rakhne ke
  liye 1900 MB se niche rakho.
- 2GB se badi koi file upload karte hi auto-split hokar `.z01`, `.z02` ...
  `.zip` parts me aati hai. Sab parts ek saath download karke rakho, phir
  final `.zip` kholo (parts unhi jagah honi chahiye).

## Deploy on Render (FREE — Web Service)

This project is meant to run as a **Web Service** (not a background worker).

> Note: `TELEGRAM_UPLOAD_ENABLED` (file upload to Telegram) needs large,
> always-on disk + a machine that never sleeps, so it is **off by default**.
> The API and the Telegram link resolver work great on the free plan.

### Option A — Blueprint (recommended)

1. Push this repo to GitHub.
2. Render.com → **New** → **Blueprint**.
3. Connect the GitHub repo. It reads `render.yaml` automatically.

### Option B — Manual Web Service

1. Render.com → **New** → **Web Service** → connect the GitHub repo.
2. Settings:
   - **Root Directory:** `terabox-project`
   - **Runtime:** Node
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `node dist/index.js`
   - **Instance Type:** Free
   - **Health Check Path:** `/health`
3. Add the **Environment Variables** from `.env.example`:
   - `TERABOX_COOKIES_JSON` (required for reliable resolution)
   - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS` (optional — enables bot)
   - `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` (only if uploads enabled)
   - `ADMIN_API_KEY` (optional — live dashboard + logs)
   - `KEEPALIVE_URLS` (optional — app khud apne URL ko ping kare)
4. Deploy. `PORT` is provided by Render automatically; the server binds `0.0.0.0`.

### Deploy ke baad check

- **Dashboard:** `https://your-app.onrender.com/admin` → user `admin`, password = `ADMIN_API_KEY`.
- **Health:** `https://your-app.onrender.com/health` (Render health check path).
- **Bot commands:** `/start` bhejke help dekho; `/logs` se logs; `/setcookie` se cookies badlo.

> **Free-plan keep-alive (zaroori):** Render free web services spin down after
> ~15 min of inactivity. Sleep ke liye **EXTERNAL** monitor chahiye jo `sleep`
> ko wake kare — `KEEPALIVE_URLS` (in-app) ye tabhi kaam karta hai jab service
> already awake ho. Isliye UptimeRobot/Cronitor se apne
> `https://your-app.onrender.com/health` ko har 10 min ping karo (free).
