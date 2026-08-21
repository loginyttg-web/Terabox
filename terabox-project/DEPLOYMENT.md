# 🚀 Deployment Guide — Railway, Heroku, Render, and Docker

> **Heroku:** This repository now includes a root-level `app.json`, `heroku.yml`, and `Dockerfile.heroku` because the application is nested in `terabox-project/`. See [`../HEROKU.md`](../HEROKU.md) for the complete one-click, GitHub integration, CLI, config-var, and troubleshooting guide. Existing Railway deployment behavior is unchanged.

## Railway — Recommended for Large Uploads (Persistent Volume Support)

### Why Railway?
- No sleep (unlike Render free)
- Better disk for uploads
- Fast builds, healthchecks, auto-restart
- Free tier + pay-as-you-go

### Steps

#### 1. Prepare Repo
- Fork this repo
- Ensure `terabox-project/` has Dockerfile, railway.json, etc. (already included)

#### 2. Create Project
- Go to https://railway.app → New Project → Deploy from GitHub Repo
- Select your fork
- Railway detects Dockerfile automatically. If not, set:
  - Root Directory: `terabox-project`
  - Builder: Dockerfile

#### 3. Variables
Railway → Your Service → Variables → Add:

```
TERABOX_COOKIES_JSON={"ndus":"YOUR_NDUS","browserid":"...","TSID":"..."}
TELEGRAM_BOT_TOKEN=123456:AAH...
TELEGRAM_OWNER_ID=123456789
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
TELEGRAM_DEST_CHANNEL_ID=-1001234567890
ADMIN_API_KEY=super_long_random_secret_at_least_32_chars
HOST=0.0.0.0
PORT=8080
# Optional:
TELEGRAM_ALLOW_PUBLIC=false
CACHE_TTL_SECONDS=7200
TERABOX_REQUEST_TIMEOUT_MS=25000
# For uploads:
TELEGRAM_API_ID=123456
TELEGRAM_API_HASH=your_api_hash
TELEGRAM_UPLOAD_ENABLED=false
TRANSFER_DOWNLOAD_CHUNKS=16
TRANSFER_MAX_JOBS_PER_CHAT=2
```

**How to get cookies:**
1. Login terabox.com in browser
2. F12 → Application → Cookies → https://www.terabox.com
3. Copy all cookies as JSON object, at least `ndus`
4. Paste as `TERABOX_COOKIES_JSON`

**How to get Bot Token:**
- @BotFather → /newbot → follow → copy token

**How to get Owner ID:**
- @userinfobot → /start → copy your ID

**Dump Channel:**
- Create private channel, add bot as admin
- Forward a message from channel to @userinfobot → get channel ID (negative)

#### 4. Deploy
- Railway auto-deploys on push
- Healthcheck path: `/health`
- Watch logs: Railway → Deployments → View Logs

#### 5. Verify
- `https://your-app.up.railway.app/` → landing page
- `https://your-app.up.railway.app/health` → should be `{"status":"ok"...}`
- `https://your-app.up.railway.app/api/docs` → API docs
- Telegram: send `/start` to bot → should reply with premium welcome

#### 6. Custom Domain (Optional)
- Railway → Settings → Domains → Add custom domain
- Update `CORS_ORIGIN` if needed

#### 7. Volume for Persistence (Optional but Recommended for Uploads)
- Railway → Add Volume → Mount at `/data`
- Set env:
  ```
  TRANSFER_TEMP_DIR=/data/transfers
  TRANSFER_DATABASE_PATH=/data/transfers/jobs.sqlite
  ACCESS_DATABASE_PATH=/data/transfers/access.sqlite
  ```
- This persists SQLite grants & temp files across deploys

---

## Render — Alternative (Free Web Service)

Render free sleeps after 15 min idle. Need external uptime monitor.

### Blueprint (Recommended)
1. Push repo to GitHub
2. Render.com → New → Blueprint → Connect repo → reads `render.yaml`
3. Add env vars in Render dashboard (same as Railway)
4. Deploy

### Manual
1. Render → New → Web Service → Connect repo
2. Settings:
   - Root Directory: `terabox-project`
   - Runtime: Node
   - Build: `npm install && npm run build`
   - Start: `node dist/index.js`
   - Plan: Free
   - Health Check: `/health`
3. Env vars: same as Railway
4. Deploy

**Keep-Alive for Render Free:**
- Use UptimeRobot (free) to ping `https://your-app.onrender.com/health` every 10 min
- In-app `KEEPALIVE_URLS` only works when already awake, not to wake sleeping service

---

## Docker — Local / VPS

```bash
cd terabox-project
docker build -t terabox-pro .
docker run -d \
  --name terabox \
  -p 8080:8080 \
  --env-file .env \
  -v terabox-data:/tmp/terabox-transfers \
  terabox-pro
```

Or docker-compose:

```yaml
services:
  terabox:
    build: ./terabox-project
    ports:
      - "8080:8080"
    env_file:
      - ./terabox-project/.env
    volumes:
      - data:/tmp/terabox-transfers
    restart: unless-stopped
volumes:
  data:
```

---

## Environment Variables Reference

See `.env.example` for full list with comments.

Critical:
- `TERABOX_COOKIES_JSON` — required for reliable resolving
- `TELEGRAM_BOT_TOKEN` — enables bot
- `TELEGRAM_OWNER_ID` — required for /access
- `ADMIN_API_KEY` — secures /admin

Optional but useful:
- `TELEGRAM_ALLOW_PUBLIC=true` for public bot
- `TELEGRAM_UPLOAD_ENABLED=true` + API_ID/HASH for uploads
- `TRANSFER_DOWNLOAD_CHUNKS=16` for speed

---

## Post-Deploy Checklist

- [ ] `/health` returns 200
- [ ] `/` shows landing page
- [ ] `/api?url=...` resolves a test link
- [ ] Telegram bot replies to `/start` with premium UI
- [ ] `/id` shows your ID
- [ ] Owner can `/access` / `/users`
- [ ] `/admin` dashboard works (admin:ADMIN_API_KEY)
- [ ] Logs show no errors
- [ ] If uploads enabled, test `/upload <link>`

---

## Updating

- Push to GitHub → Railway/Render auto-deploys
- Or Railway CLI: `railway up`
- To update cookies without redeploy: Telegram `/setcookie {...}`

---

## Support

- GitHub Issues
- Telegram: send /id to bot, contact owner
- Logs: /logs in Telegram or /admin/logs

Happy deploying! 🚀
