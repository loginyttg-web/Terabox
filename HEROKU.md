# Heroku deployment

The repository includes a complete Heroku **container-stack** setup:

- `app.json` — Deploy to Heroku configuration and config-var prompts
- `heroku.yml` — tells Heroku how to build and run the web process
- `Dockerfile.heroku` — Node.js 22 production image with the `zip` binary
- `/health` — health/uptime endpoint

The existing Railway files are unchanged, so Railway deployments continue to work.

## Option 1: Deploy button

[![Deploy](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy?template=https://github.com/loginyttg-web/Terabox/tree/main)

1. Fork this repository first if you want Heroku to auto-deploy your future changes.
2. Click **Deploy to Heroku**.
3. Select an app name and region.
4. Fill at least `TERABOX_COOKIES_JSON`.
5. To enable the Telegram bot, also fill `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_ID` (or allowed users/public mode).
6. Deploy and open `https://YOUR-APP.herokuapp.com/health`.

`ADMIN_API_KEY` is generated automatically. Find it under **Settings → Config Vars** and use it for `/admin`.

## Option 2: GitHub integration

1. In Heroku, create an app.
2. Under **Settings → Stack**, choose **Container**. For an existing app, run:

   ```bash
   heroku stack:set container --app YOUR_APP
   ```

3. Under **Deploy → Deployment method**, connect GitHub and select this repository.
4. Add the config vars listed below.
5. Deploy `main` manually, or enable automatic deploys.

Heroku reads `heroku.yml` from the repository root and builds `Dockerfile.heroku`; no Heroku root-directory setting is needed.

## Option 3: Heroku CLI

```bash
heroku login
heroku create YOUR_APP --stack container

heroku config:set --app YOUR_APP \
  'TERABOX_COOKIES_JSON={"ndus":"YOUR_NDUS","browserid":"YOUR_BROWSER_ID"}' \
  HOST=0.0.0.0 \
  TELEGRAM_UPLOAD_ENABLED=false

# Telegram bot (optional)
heroku config:set --app YOUR_APP \
  TELEGRAM_BOT_TOKEN='123456:ABC...' \
  TELEGRAM_OWNER_ID='123456789' \
  TELEGRAM_ALLOW_PUBLIC=false

# Push the current repository branch to the Heroku app's main ref
git push heroku HEAD:main

heroku ps:scale web=1 --app YOUR_APP
heroku logs --tail --app YOUR_APP
```

If the CLI app was created without `--stack container`, run `heroku stack:set container --app YOUR_APP` before pushing.

## Config vars

### Resolver/API

| Variable | Required | Notes |
|---|---:|---|
| `TERABOX_COOKIES_JSON` | Recommended | JSON object containing TeraBox cookies; `ndus` is most important |
| `HOST` | No | Keep `0.0.0.0`; Heroku supplies `PORT` automatically |
| `CORS_ORIGIN` | No | Defaults to `*` |
| `ADMIN_API_KEY` | No | At least 16 non-space characters; enables `/admin` |

### Telegram bot

| Variable | Required | Notes |
|---|---:|---|
| `TELEGRAM_BOT_TOKEN` | To enable bot | Token from `@BotFather` |
| `TELEGRAM_OWNER_ID` | Private bot | Numeric owner ID; alternatively configure allowed users/public mode |
| `TELEGRAM_ALLOWED_USER_IDS` | No | Comma-separated IDs |
| `TELEGRAM_ALLOW_PUBLIC` | No | Defaults to `false` |
| `TELEGRAM_DEST_CHANNEL_ID` | No | Negative channel ID; bot must be channel admin |

### File uploads

Uploads are disabled by default. To enable them:

```bash
heroku config:set --app YOUR_APP \
  TELEGRAM_UPLOAD_ENABLED=true \
  TELEGRAM_API_ID='123456' \
  TELEGRAM_API_HASH='your_api_hash'
```

The Heroku image includes `zip`, so split archives work. However, Heroku's filesystem is **ephemeral**: transfer jobs, temporary files, SQLite access grants, and runtime cookie changes disappear after a restart or redeploy. Large downloads also need enough dyno disk space. For a resolver-only bot, keep `TELEGRAM_UPLOAD_ENABLED=false`. For reliable large uploads and persistent SQLite data, Railway with a volume or another host with persistent storage is a better fit.

Run only **one web dyno** while Telegram long polling is enabled. Multiple dynos using the same bot token can consume updates unpredictably.

## Verification

```bash
curl https://YOUR-APP.herokuapp.com/health
curl https://YOUR-APP.herokuapp.com/api/docs
heroku ps --app YOUR_APP
heroku logs --tail --app YOUR_APP
```

Expected health response starts with `{"status":"ok"}`.

## Troubleshooting

- **R10 / web process failed to bind:** don't set a fixed `PORT`; Heroku injects it. Keep `HOST=0.0.0.0`.
- **Bot exits at startup:** when a token is set, configure `TELEGRAM_OWNER_ID`, `TELEGRAM_ALLOWED_USER_IDS`, or `TELEGRAM_ALLOW_PUBLIC=true`.
- **401/403 from TeraBox:** refresh `TERABOX_COOKIES_JSON`; the session cookie likely expired.
- **Changes disappear after restart:** dyno storage is ephemeral. Store durable data externally or use Railway persistent volumes.
- **Bot receives updates inconsistently:** scale down to one web dyno: `heroku ps:scale web=1 --app YOUR_APP`.
- **Application sleeps:** choose a Heroku dyno plan appropriate for an always-on polling bot. An external health ping cannot guarantee Telegram polling while a dyno is asleep.
