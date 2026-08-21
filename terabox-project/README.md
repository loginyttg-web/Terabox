# 🚀 TeraBox Pro Bot — v3.0 Railway Edition

Ultra fast TeraBox resolver with **premium Telegram UI**, **60+ domains**, **parallel downloads**, **Railway ready**. No ads, no spam, production-grade.

![Node](https://img.shields.io/badge/Node-22+-green) ![Railway](https://img.shields.io/badge/Deploy-Railway-blueviolet) ![Heroku](https://img.shields.io/badge/Deploy-Heroku-79589F) ![Telegram](https://img.shields.io/badge/Telegram-Bot-blue)

[![Deploy to Heroku](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy?template=https://github.com/loginyttg-web/Terabox/tree/main)

> Heroku support uses the root-level container configuration because this application is in a subdirectory. See [`../HEROKU.md`](../HEROKU.md) for the full setup. Railway configuration remains unchanged.

---

## ✨ What's New in v3.0?

### 🎨 Premium Telegram UI
- **Welcome screen** with personalized greeting + inline buttons (Help, Features, My ID, About)
- **File icons** by type: 🎬 video, 🎵 audio, 🖼️ image, 🗜️ zip, 📄 doc etc.
- **Progress bars**: `[██████░░░░] 60%` + speed + ETA in transfer messages
- **Rich browser**: breadcrumb, total size, folder/file count, pagination with emojis
- **Multi-link support**: send multiple TeraBox links at once, auto-detects all
- **Password support**: `?pwd=yourpass` in URL or `&pwd=` query param
- **Better error messages** in Hindi+English, with tips

### 🌐 60+ Domains Supported
Previously 40, now **60+** including:
- Primary: `terabox.com, terabox.app, terabox.link, terabox.ws, terabox.to, terabox.club, terabox.fun, teraboxdrive.com, teraboxcdn.app`
- 1024 variants: `1024terabox.com, 1024tera.com, 1024box.com, 1024terabox.link`
- Share: `teraboxshare.com, teraboxlink.com, terasharelink.com, terafileshare.com, freeterabox.com, freeterabox.link`
- Mirrors: `4funbox.com, mirrobox.com, nephobox.com, momerybox.com, tibibox.com, gibibox.com, pebibox.com, dubox.com, dobox.com, disklab, teraboxpro.com + 30 more`
- **Suffix matching**: `*.terabox.app, *.terabox.com, *.terabox.club, *.terabox.link, *.terabox.ws`

### ⚡ Performance & Reliability
- **Multi-origin fallback**: tries `dm.terabox.app → www.terabox.com → terabox.app → 1024tera.com` if one fails
- **Better jsToken extraction**: 8 patterns + yunData fallback
- **Parallel chunk download**: 16 connections by default (configurable 1-32), 16x faster on throttled links
- **Smart caching**: 2hr TTL, 1000 items, LRU eviction
- **Rate limiting**: 60 req/min per IP on `/api`
- **Deep scan**: 15 levels, 10k files (was 12 / 5k)

### 🚂 Railway Deployment Ready
- `Dockerfile` (Node 22 Alpine + zip)
- `railway.json` + `railway.toml` + `nixpacks.toml`
- Healthcheck at `/health`, auto-restart, `HOST=0.0.0.0`
- One-click deploy button

### 📊 Premium Admin Dashboard
- **Dark pro UI** with gradient cards, live badges, emojis
- Real-time via SSE (`/admin/stream`), fallback polling
- Shows active/queued/cache/disk/completed/failed
- Recent events + logs (50 lines) with color-coded levels
- Responsive mobile-friendly

### 🆕 New Commands
- `/about` — About bot, version, tech
- `/features` — Full feature list
- `/ping` — Latency + cache + time
- `/donate` — Support message
- Improved `/start` with inline keyboard
- Improved `/id`, `/status`, `/logs`, `/setcookie` with guides

---

## 🎯 Features (All)

- **Link Resolver**: any TeraBox URL → direct download links (no login needed for user)
- **File Browser**: interactive inline buttons, folder nav, pagination, download & upload
- **Deep Scan**: `/scan` or `?scan=1` → all files in all sub-folders with relative paths
- **Upload to Telegram**: optional MTProto upload, >2GB auto-split to ZIP parts (`.z01`, `.z02`, `.zip`)
- **Cookie Hot-Swap**: `/setcookie` updates cookies without restart
- **Access Control**: owner can `/access <id>` / `/revoke <id>` / `/users`, private bot support
- **Dump Channel**: logs new users + content copies to `TELEGRAM_DEST_CHANNEL_ID`
- **API**: `GET /api?url=...`, `?scan=1`, `?pwd=`, `/health`, `/admin`, `/api/docs`

---

## 📡 API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api?url=<terabox-url>` | Resolve link, get files + direct links |
| `GET /api?url=<url>&scan=1` | Deep scan all sub-folders |
| `GET /api?url=<url>&pwd=xxx` | Password-protected shares |
| `GET /health` | Health + bot + cache + uptime |
| `GET /` | Landing page with stats |
| `GET /api/docs` | API documentation HTML |
| `GET /admin` | Live dashboard (Basic/Bearer auth) |
| `GET /admin/status` | JSON status |
| `GET /admin/logs` | Last 50 logs |
| `GET /admin/stream` | SSE real-time |

Example:
```bash
curl "https://your-app.railway.app/api?url=https://terabox.com/s/1AbCdEfGh"
curl "https://your-app.railway.app/api?url=https://terabox.com/s/1AbCdEfGh&scan=1"
curl "https://your-app.railway.app/health"
```

---

## 🤖 Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome + inline menu |
| `/help` | Full guide |
| `/about` | About bot |
| `/features` | Feature list |
| `/ping` | Latency check |
| `/link <URL>` | Resolve link |
| `/scan <URL>` | Deep scan |
| `/id` | Your User ID + Chat ID |
| `/status` | Bot status |
| `/setcookie <JSON>` | Update cookies (admin) |
| `/logs` | Last 50 logs |
| `/upload <URL> [n]` | Upload file n to Telegram |
| `/uploadall <URL>` | Upload whole folder |
| `/jobs` | Transfer queue |
| `/stats` | Stats |
| `/cancel [id]` | Cancel job |
| `/access <id>` | Allow user (owner) |
| `/revoke <id>` | Revoke (owner) |
| `/users` | Allowed users (owner) |

Just send a TeraBox link directly — auto-detects!

---

## 🚀 Deploy on Railway (Recommended)

Railway doesn't sleep, has good disk, perfect for uploads.

### One-Click Deploy

1. Fork this repo to your GitHub
2. Go to [Railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select your fork, Root Directory: `terabox-project`
4. Railway auto-detects Dockerfile
5. Add Variables (Railway dashboard → Variables):

```
TERABOX_COOKIES_JSON={"ndus":"...","browserid":"..."}
TELEGRAM_BOT_TOKEN=123456:ABC...
TELEGRAM_OWNER_ID=123456789
TELEGRAM_ALLOWED_USER_IDS=123456789
ADMIN_API_KEY=your_super_long_secret_32+_chars
HOST=0.0.0.0
PORT=8080
# Optional uploads:
TELEGRAM_API_ID=12345
TELEGRAM_API_HASH=abc...
TELEGRAM_UPLOAD_ENABLED=false
```

6. Deploy! Railway gives you `https://your-app.up.railway.app`
7. Health check path: `/health`
8. Test: `https://your-app.up.railway.app/api/docs`

### Railway CLI

```bash
npm i -g @railway/cli
railway login
railway init
railway up
railway variables set TERABOX_COOKIES_JSON='{"ndus":"..."}'
```

### Docker Local

```bash
docker build -t terabox-pro .
docker run -p 8080:8080 --env-file .env terabox-pro
```

---

## 🛠️ Local Development

```bash
cd terabox-project
npm install
cp .env.example .env   # fill values
npm run dev            # tsx watch
# or
npm run build && npm start
```

Requirements: **Node.js 22+** (uses `node:sqlite`, native fetch)

---

## 🍪 Cookies — Important

`TERABOX_COOKIES_JSON` must be JSON object: `{"ndus":"...","browserid":"...","TSID":"..."}`

- `ndus` is most important (login session)
- Best: copy ALL cookies from browser: F12 → Application → Cookies → terabox.com
- Update at runtime: Telegram `/setcookie {"ndus":"...","browserid":"..."}`
- If resolving fails with 401/403, cookie expired → update

---

## 📦 Upload >2GB — ZIP Split

- `TRANSFER_UPLOAD_LIMIT_MB=1900` — max per Telegram message (keep <2000)
- `TRANSFER_SPLIT_PART_MB=1800` — split size
- File >2GB → auto ZIP: `file.zip.terabox.z01`, `z02`, ..., `zip`
- Recipient: download all parts to same folder, open `.zip`

---

## 🔒 Access Control Flow

1. User `/start` → info goes to dump channel (`TELEGRAM_DEST_CHANNEL_ID`)
2. If not allowed → "restricted" message with ID
3. Owner `/access <user-id>` → user can use bot
4. Allowed user resolves → content copy to dump channel
5. Grants stored in SQLite (`ACCESS_DATABASE_PATH`), persist if disk persistent (Railway volume)

---

## 📈 Improvements You Can Add Next

We already added premium UI + 60 domains + Railway. Here are more ideas:

### Implemented in v3.0
- ✅ 60+ domains + suffix matching
- ✅ Premium Telegram UI with icons & progress bars
- ✅ Multi-link support
- ✅ Password support (?pwd=)
- ✅ Multi-origin fallback
- ✅ Rate limiting
- ✅ Premium admin dashboard
- ✅ Railway Dockerfile + configs
- ✅ Landing page + API docs page

### Suggested Future Improvements
- **Web UI for users**: Simple frontend at `/` to paste link and get downloads (like playterabox.com)
- **Inline mode**: `@yourbot <link>` in any chat → instant results
- **Auto thumbnail**: Send first image as photo with caption + download button
- **User stats**: Track how many links each user resolved, leaderboard
- **Short link**: `/short <url>` → create short link via your own shortener
- **Batch API**: `POST /api/batch` with JSON array of URLs → resolve all
- **Webhook support**: Optional webhook instead of polling for lower latency
- **Language toggle**: `/lang en/hi` → user preference stored
- **Force join**: Require users to join channel before using bot
- **File preview**: For video files, generate 10s preview via ffmpeg (if disk)
- **Redis cache**: For multi-instance scaling
- **Prometheus metrics**: `/metrics` for Grafana
- **Auto cookie refresh**: Headless browser to auto-refresh ndus (puppeteer)
- **Donation integration**: Razorpay / UPI QR for Indian users

---

## 🐛 Troubleshooting

- **401/403**: Cookie expired → update via `/setcookie` or Railway Variables
- **404**: Link expired or invalid surl
- **Timeout**: TeraBox slow, retry. Check `/health`
- **Telegram not responding**: Check `TELEGRAM_BOT_TOKEN` valid, bot not blocked
- **Upload fails**: Need `TELEGRAM_API_ID/HASH` + `TELEGRAM_UPLOAD_ENABLED=true` + disk space

Logs: Telegram `/logs` or `/admin/logs` or Railway logs dashboard.

---

## 📄 License

MIT — Free for personal use. Don't abuse TeraBox TOS. Only resolve links you have permission to access.

---

## 💖 Credits

- Original: loginyttg-web/Terabox
- v3.0 Pro: Premium UI + Railway + 60 domains
- Built with Node 22, SQLite, MTProto

**Enjoy!** 🚀 Send feedback via Telegram /id → owner.
