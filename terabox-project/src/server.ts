import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AppConfig } from "./config.js";
import { logBuffer } from "./lib/logs.js";
import type { ShareResolver } from "./lib/share-service.js";
import { type ResolvedShare, TeraBoxError } from "./lib/terabox.js";
import { extractSharePassword, extractSurl, formatBytes, isValidShareUrl } from "./lib/utils.js";

export interface TelegramStatusProvider {
  getStatus(): unknown;
}
export interface TransferStatusProvider {
  getStatus(): unknown;
  getDashboard?(): unknown;
  subscribe?(listener: (snapshot: unknown) => void): () => void;
  liveSnapshot?(): unknown[];
}
export interface ApiServerOptions {
  config: AppConfig;
  resolver: ShareResolver;
  telegramBot?: TelegramStatusProvider;
  transferManager?: TransferStatusProvider;
  logger?: Pick<Console, "error">;
}

function corsHeaders(config: AppConfig): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": config.corsOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}
function writeJson(response: ServerResponse, config: AppConfig, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...corsHeaders(config),
  });
  response.end(JSON.stringify(body, null, 2));
}
function writePrivateJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body, null, 2));
}
function writeHtml(response: ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function secureEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
function isAdminAuthorized(request: IncomingMessage, apiKey: string | undefined): boolean {
  if (!apiKey) return false;
  const authorization = request.headers.authorization;
  if (!authorization) return false;
  if (authorization.startsWith("Bearer ")) {
    return secureEquals(authorization.slice(7), apiKey);
  }
  if (authorization.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
      const sep = decoded.indexOf(":");
      return sep > 0 && decoded.slice(0, sep) === "admin" && secureEquals(decoded.slice(sep + 1), apiKey);
    } catch {
      return false;
    }
  }
  return false;
}
function methodNotAllowed(response: ServerResponse, config: AppConfig): void {
  response.setHeader("Allow", "GET, OPTIONS");
  writeJson(response, config, 405, { status: "error", message: "Method not allowed. Use GET." });
}

// --- Rate limiting (simple in-memory) ---
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
function isRateLimited(ip: string, limit = 60, windowMs = 60_000): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
    return false;
  }
  entry.count += 1;
  if (entry.count > limit) return true;
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimitMap) {
    if (now > v.resetAt) rateLimitMap.delete(k);
  }
}, 60_000).unref();

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function toPublicFile(file: ResolvedShare["files"][number]): Record<string, unknown> {
  return {
    name: file.name,
    ...(file.sizeBytes !== undefined && {
      size_bytes: file.sizeBytes,
      size: formatBytes(file.sizeBytes),
    }),
    is_folder: file.isFolder,
    ...(file.download && { download: file.download }),
    ...(file.thumbs && { thumbs: file.thumbs }),
  };
}
function successResponse(share: ResolvedShare, sourceUrl: string, elapsedMs: number, cacheHit: boolean): Record<string, unknown> {
  const firstFile = share.files[0];
  return {
    status: "success",
    response_time: `${(elapsedMs / 1_000).toFixed(3)}s`,
    url: sourceUrl,
    surl: share.surl,
    cached: cacheHit,
    file_count: share.files.length,
    total_size: share.totalSizeBytes ? formatBytes(share.totalSizeBytes) : undefined,
    total_size_bytes: share.totalSizeBytes,
    files: share.files.map(toPublicFile),
    ...(firstFile && { filename: firstFile.name }),
    ...(firstFile?.sizeBytes !== undefined && { size: formatBytes(firstFile.sizeBytes) }),
    ...(firstFile?.download && { download: firstFile.download }),
    ...(firstFile?.thumbs && { thumbs: firstFile.thumbs }),
    timestamp: new Date().toISOString(),
  };
}
function dashboardData(resolver: ShareResolver, transferManager?: TransferStatusProvider): Record<string, unknown> {
  return {
    generated_at: new Date().toISOString(),
    cache_items: resolver.cacheSize,
    transfers: transferManager?.getDashboard?.() ?? transferManager?.getStatus() ?? { enabled: false },
  };
}

// Premium admin dashboard HTML
function adminDashboardHtml(token: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TeraBox Pro — Admin Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<style>
*{box-sizing:border-box}body{margin:0;background:#0a0e14;color:#e6edf3;font:14px/1.6 'Inter',system-ui,sans-serif}
a{color:#58a6ff;text-decoration:none}a:hover{text-decoration:underline}
main{max-width:1200px;margin:0 auto;padding:24px 18px}
.header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:20px}
.header h1{font-size:26px;margin:0;display:flex;align-items:center;gap:10px}
.header h1 span{font-size:13px;background:#238636;color:#fff;padding:2px 8px;border-radius:20px}
.sub{color:#8b949e;margin:0 0 18px;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:24px}
.card{background:linear-gradient(135deg,#161b22 0%,#1c2129 100%);border:1px solid #30363d;border-radius:12px;padding:16px 18px;position:relative;overflow:hidden}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#238636,#1f6feb)}
.card .n{font-size:28px;font-weight:800;letter-spacing:-0.02em}
.card .l{color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.08em;margin-top:2px}
.card .icon{position:absolute;top:14px;right:14px;font-size:22px;opacity:.3}
h2{font-size:16px;margin:28px 0 10px;color:#e6edf3;display:flex;align-items:center;gap:8px}
table{width:100%;border-collapse:collapse;background:#161b22;border:1px solid #30363d;border-radius:12px;overflow:hidden}
th,td{padding:10px 12px;text-align:left;border-bottom:1px solid #21262d;font-size:13px;vertical-align:top}
th{background:#0d1117;color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.06em}
tr:last-child td{border-bottom:none}tr:hover td{background:#1c2129}
.tag{display:inline-flex;align-items:center;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:600;background:#21262d;gap:4px}
.tag.downloading,.tag.preparing{background:#1f6feb22;color:#58a6ff;border:1px solid #1f6feb44}
.tag.uploading{background:#23863622;color:#3fb950;border:1px solid #23863644}
.tag.splitting{background:#9e6a0322;color:#d29922;border:1px solid #9e6a0344}
.tag.completed{background:#23863622;color:#3fb950;border:1px solid #23863644}
.tag.failed{background:#da363322;color:#f85149;border:1px solid #da363344}
.tag.cancelled,.tag.queued{background:#6e768122;color:#8b949e;border:1px solid #6e768144}
.bar{height:8px;background:#21262d;border-radius:10px;overflow:hidden;margin-top:6px;position:relative}
.bar>div{height:100%;background:linear-gradient(90deg,#3fb950,#2ea043);border-radius:10px;transition:width .3s}
pre.log{margin:0;background:#0d1117;padding:14px;max-height:380px;overflow:auto;font:12px/1.6 ui-monospace,Menlo,monospace;border:1px solid #30363d;border-radius:10px;white-space:pre-wrap;word-break:break-all}
.lvl{font-weight:700;padding:1px 6px;border-radius:4px;font-size:11px}
.lvl.info{background:#1f6feb22;color:#58a6ff}.lvl.warn{background:#9e6a0322;color:#d29922}.lvl.error{background:#da363322;color:#f85149}
.footer{margin-top:32px;padding-top:16px;border-top:1px solid #21262d;color:#8b949e;font-size:12px;text-align:center}
.badge{display:inline-block;padding:2px 8px;border-radius:6px;background:#21262d;font-size:11px}
@media(max-width:600px){.grid{grid-template-columns:1fr 1fr}table{font-size:12px}th,td{padding:8px}}
</style></head><body><main>
<div class="header">
<h1>🚀 TeraBox Pro <span>RAILWAY EDITION v3.0</span></h1>
<div><span class="badge" id="live">● Live</span> <span class="badge" id="time">--:--:--</span></div>
</div>
<p class="sub" id="sub">Connecting to real-time stream…</p>
<div class="grid">
  <div class="card"><div class="icon">🔥</div><div class="n" id="cActive">-</div><div class="l">Active Transfers</div></div>
  <div class="card"><div class="icon">⏳</div><div class="n" id="cQueued">-</div><div class="l">Queued Jobs</div></div>
  <div class="card"><div class="icon">📦</div><div class="n" id="cCache">-</div><div class="l">Cache Items</div></div>
  <div class="card"><div class="icon">💾</div><div class="n" id="cDisk">-</div><div class="l">Disk Free</div></div>
  <div class="card"><div class="icon">✅</div><div class="n" id="cDone">-</div><div class="l">Completed</div></div>
  <div class="card"><div class="icon">❌</div><div class="n" id="cFail">-</div><div class="l">Failed</div></div>
</div>

<h2>📋 Live Transfers</h2>
<table><thead><tr><th>Job ID</th><th>Stage</th><th>File Name</th><th>Progress</th><th>Speed</th></tr></thead>
<tbody id="jobs"><tr><td colspan="5">Loading…</td></tr></tbody></table>

<h2>📝 Recent Events</h2>
<table><thead><tr><th>Time</th><th>Stage</th><th>Job</th><th>Message</th></tr></thead>
<tbody id="events"><tr><td colspan="4">Loading…</td></tr></tbody></table>

<h2>📜 Recent Logs (50)</h2>
<pre class="log" id="logs">Loading…</pre>

<div class="footer">
🚀 TeraBox Pro Bot • Railway Deploy • Made with ❤️ • <a href="/health">/health</a> • <a href="/api/docs">/api/docs</a><br>
<span class="badge">60+ domains supported • Parallel chunks • Auto ZIP split</span>
</div>

<script>
const token = ${JSON.stringify(token)};
const esc = s => String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const fmtBytes = n => { if(n==null) return "—"; const u=["B","KB","MB","GB","TB"]; let i=0; while(n>=1024&&i<u.length-1){n/=1024;i++} return n.toFixed(i?1:0)+" "+u[i]; };
const time = t => new Date(t).toLocaleTimeString();
const stageClass = s => String(s).toLowerCase();
const stageEmoji = s => ({downloading:"⬇️",uploading:"⬆️",preparing:"🔎",splitting:"🗜️",queued:"⏳",completed:"✅",failed:"❌",cancelled:"⏹️"}[String(s).toLowerCase()]||"📦");
function progress(job){
  if(job.transferredBytes!=null && job.totalBytes>0){
    const p=Math.min(100,Math.round(job.transferredBytes/job.totalBytes*100));
    return p+"%<div class=bar><div style=width:"+p+"%></div></div><small>"+fmtBytes(job.transferredBytes)+"/"+fmtBytes(job.totalBytes)+"</small>";
  }
  if(job.progress!=null) return Math.round(job.progress*100)+"%<div class=bar><div style=width:"+Math.round(job.progress*100)+"%></div></div>";
  return "—";
}
function jobsHtml(tr){
  const rows = (tr.recent_jobs||[]);
  const tbody = document.getElementById("jobs");
  if(!rows.length){ tbody.innerHTML="<tr><td colspan=5>✅ No transfers yet — send a TeraBox link to bot!</td></tr>"; return; }
  tbody.innerHTML = rows.map(j=>\`<tr>
    <td><code>\${esc(j.id)}</code></td>
    <td><span class="tag \${stageClass(j.stage)}">\${stageEmoji(j.stage)} \${esc(j.stage)}</span>\${j.totalFileCount&&j.currentFileIndex?\` <small>\${j.currentFileIndex}/\${j.totalFileCount}</small>\`:""}</td>
    <td><div style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${esc(j.filename||"")}</div>\${j.partCount>1?\`<small>Part \${j.partIndex||1}/\${j.partCount}</small>\`:""}</td>
    <td>\${progress(j)}</td>
    <td>\${j.speedBytesPerSecond?\`<small>\${fmtBytes(j.speedBytesPerSecond)}/s</small>\`:"—"}</td>
  </tr>\`).join("");
}
function eventsHtml(ev){
  const tbody=document.getElementById("events");
  if(!ev.length){ tbody.innerHTML="<tr><td colspan=4>No events yet.</td></tr>"; return; }
  tbody.innerHTML=ev.map(e=>\`<tr><td>\${time(e.created_at)}</td><td><span class="tag \${stageClass(e.stage)}">\${stageEmoji(e.stage)} \${esc(e.stage)}</span></td><td><code>\${esc(e.job_id||"")}</code></td><td>\${esc(e.message||"")}</td></tr>\`).join("");
}
function logsHtml(ls){
  document.getElementById("logs").innerHTML = ls.map(l=>{
    const t=new Date(l.ts).toLocaleString();
    return \`<span class="lvl \${l.level}">\${esc(l.level.toUpperCase())}</span> [\${t}] \${esc(l.message)}\`;
  }).join("\\n");
}
async function refresh(){
  try{
    const r=await fetch("/admin/status?token="+token,{cache:"no-store"});
    const d=await r.json();
    const t=d.transfers||{};
    document.getElementById("cActive").textContent=t.active_jobs??0;
    document.getElementById("cQueued").textContent=(t.queued_jobs??0)+"/"+(t.max_queue??"?");
    document.getElementById("cCache").textContent=d.cache_items??0;
    document.getElementById("cDisk").textContent=t.disk?fmtBytes(t.disk.available_bytes):"—";
    document.getElementById("cDone").textContent=t.totals?.completed??0;
    document.getElementById("cFail").textContent=t.totals?.failed??0;
    document.getElementById("sub").textContent="Live • Updated "+new Date(d.generated_at).toLocaleTimeString()+" • Railway • Cache "+d.cache_items+" items";
    document.getElementById("time").textContent=new Date().toLocaleTimeString();
    jobsHtml(t); eventsHtml(t.recent_events||[]);
    const lr=await fetch("/admin/logs?token="+token,{cache:"no-store"});
    const ld=await lr.json(); logsHtml(ld.logs||[]);
  }catch(e){ document.getElementById("sub").textContent="Error: "+e; document.getElementById("live").textContent="○ Offline"; }
}
refresh(); setInterval(refresh,2500);
try{
  const es=new EventSource("/admin/stream?token="+token);
  es.addEventListener("transfer",()=>refresh());
  es.onopen=()=>{document.getElementById("live").textContent="● Live"; document.getElementById("live").style.color="#3fb950"};
  es.onerror=()=>{document.getElementById("live").textContent="○ Reconnecting…"};
}catch(e){}
</script>
</main></body></html>`;
}

function apiDocsHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TeraBox Pro API — Docs</title>
<style>*{box-sizing:border-box}body{margin:0;background:#0a0e14;color:#e6edf3;font:14px/1.6 system-ui,sans-serif}
main{max-width:900px;margin:0 auto;padding:24px 18px}h1{font-size:28px;margin:0 0 8px}h2{font-size:18px;margin:28px 0 12px;color:#58a6ff}
code{background:#161b22;padding:2px 6px;border-radius:6px;font-size:13px;border:1px solid #30363d}
pre{background:#161b22;padding:16px;border-radius:10px;overflow:auto;border:1px solid #30363d;font-size:13px}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:16px;margin:12px 0}
.tag{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;background:#23863622;color:#3fb950;border:1px solid #23863644}
a{color:#58a6ff}
</style></head><body><main>
<h1>🚀 TeraBox Pro API — Documentation</h1>
<p><span class="tag">v3.0 Railway Edition</span> • Fast • 60+ domains • No auth required for /api</p>

<h2>📡 Endpoints</h2>

<div class="card">
<h3>GET /api?url=&lt;terabox-url&gt;</h3>
<p>Resolve a TeraBox share link and get direct download URLs.</p>
<pre>curl "https://your-app.railway.app/api?url=https://terabox.com/s/1AbCdEfGh"</pre>
<p><b>Query params:</b></p>
<ul>
<li><code>url</code> (required) — Any TeraBox share URL (60+ domains supported)</li>
<li><code>scan=1</code> (optional) — Deep scan all sub-folders recursively</li>
<li><code>pwd=xxx</code> (optional) — Password for protected shares (also works via ?pwd= in url)</li>
</ul>
<p><b>Response:</b></p>
<pre>{
  "status": "success",
  "surl": "1AbCdEfGh",
  "file_count": 5,
  "total_size": "2.3 GB",
  "files": [
    {
      "name": "video.mp4",
      "size": "1.2 GB",
      "size_bytes": 1288490188,
      "is_folder": false,
      "download": "https://..."
    }
  ]
}</pre>
</div>

<div class="card">
<h3>GET /api?url=&lt;url&gt;&amp;scan=1</h3>
<p>Deep scan — walks all sub-folders (up to 15 levels, 10k files) and returns flat list with relative paths.</p>
<pre>curl "https://your-app.railway.app/api?url=https://terabox.com/s/1AbCdEfGh&scan=1"</pre>
</div>

<div class="card">
<h3>GET /health</h3>
<p>Health check + bot status + cache info. Use for Railway healthcheck & uptime monitors.</p>
<pre>{
  "status": "ok",
  "cache_items": 42,
  "telegram": {"enabled": true, "running": true, "username": "yourbot"},
  "transfers": {"enabled": true, "active_jobs": 1}
}</pre>
</div>

<div class="card">
<h3>GET /admin (Auth required)</h3>
<p>Live dashboard with real-time transfers (SSE), logs, disk usage. Auth via Basic (user=admin, pass=ADMIN_API_KEY) or Bearer token.</p>
</div>

<h2>🌐 Supported Domains (60+)</h2>
<p>terabox.com, terabox.app, teraboxlink.com, teraboxshare.com, terasharelink.com, 1024terabox.com, 1024tera.com, 4funbox.com, mirrobox.com, nephobox.com, freeterabox.com, dubox.com, dobox.com, terabox.fun, terabox.club, terabox.ws, terabox.to, teraboxdrive.com, disklab + 40 more. Suffix matching for *.terabox.app/com/club/link/ws</p>

<h2>🤖 Telegram Bot</h2>
<p>Send any TeraBox link to bot, get instant file browser with download & upload buttons.</p>
<ul>
<li>/link &lt;url&gt; — Resolve</li>
<li>/scan &lt;url&gt; — Deep scan</li>
<li>/upload &lt;url&gt; — Upload to Telegram (if enabled)</li>
<li>/uploadall — Upload whole folder</li>
<li>/id, /help, /about, /features, /ping</li>
</ul>

<h2>🚀 Railway Deploy</h2>
<pre>1. Fork this repo
2. Railway.app → New Project → Deploy from GitHub
3. Add env vars:
   TERABOX_COOKIES_JSON={"ndus":"..."}
   TELEGRAM_BOT_TOKEN=...
   TELEGRAM_OWNER_ID=...
   ADMIN_API_KEY=long_secret
4. Deploy! Health check path: /health
</pre>

<p style="margin-top:32px;color:#8b949e;text-align:center">Made with ❤️ for TeraBox users • Railway • No ads • Open source</p>
</main></body></html>`;
}

function landingHtml(config: AppConfig, resolver: ShareResolver, telegramBot?: TelegramStatusProvider, transferManager?: TransferStatusProvider): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TeraBox Pro — Ultra Fast Resolver</title>
<style>*{box-sizing:border-box}body{margin:0;background:#0a0e14;color:#e6edf3;font:15px/1.6 system-ui,sans-serif}
main{max-width:900px;margin:0 auto;padding:32px 18px;text-align:center}
h1{font-size:36px;margin:0 0 8px;background:linear-gradient(90deg,#3fb950,#58a6ff);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.sub{color:#8b949e;font-size:16px;margin:0 0 24px}
.card{background:#161b22;border:1px solid #30363d;border-radius:14px;padding:20px;margin:16px 0;text-align:left}
.btn{display:inline-block;padding:10px 20px;border-radius:10px;background:#238636;color:#fff;font-weight:600;text-decoration:none;margin:6px}
.btn.secondary{background:#21262d;color:#e6edf3;border:1px solid #30363d}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:20px 0}
.stat{background:#0d1117;border:1px solid #21262d;border-radius:10px;padding:12px}
.stat .n{font-size:22px;font-weight:700}.stat .l{font-size:12px;color:#8b949e;text-transform:uppercase}
code{background:#0d1117;padding:2px 6px;border-radius:6px;border:1px solid #21262d}
</style></head><body><main>
<h1>🚀 TeraBox Pro</h1>
<p class="sub">Ultra Fast TeraBox Resolver • 60+ Domains • Telegram Bot • Railway Ready</p>

<div class="grid">
<div class="stat"><div class="n">60+</div><div class="l">Domains Supported</div></div>
<div class="stat"><div class="n">${resolver.cacheSize}</div><div class="l">Cache Items</div></div>
<div class="stat"><div class="n">${telegramBot ? "Online" : "Off"}</div><div class="l">Telegram Bot</div></div>
<div class="stat"><div class="n">${transferManager ? "Enabled" : "API Only"}</div><div class="l">Upload Mode</div></div>
</div>

<div class="card">
<h3>🔗 API Quick Start</h3>
<p>Resolve any TeraBox link in milliseconds:</p>
<code>GET /api?url=https://terabox.com/s/1AbCdEfGh</code>
<p style="margin-top:12px"><a class="btn" href="/api/docs">📖 API Docs</a> <a class="btn secondary" href="/health">💚 Health</a> ${config.adminApiKey ? `<a class="btn secondary" href="/admin">📊 Admin</a>` : ""}</p>
</div>

<div class="card">
<h3>🤖 Telegram Bot</h3>
<p>Send any TeraBox link to bot and get instant file browser with direct download links + upload to Telegram.</p>
<p>Commands: <code>/link</code> <code>/scan</code> <code>/upload</code> <code>/uploadall</code> <code>/id</code> <code>/help</code></p>
</div>

<div class="card">
<h3>🌟 Features</h3>
<ul style="margin:0;padding-left:18px">
<li>60+ TeraBox domains (auto fallback origins)</li>
<li>Password-protected links (?pwd=)</li>
<li>Multi-link support + deep recursive scan (15 levels)</li>
<li>Beautiful Telegram UI with progress bars & file icons</li>
<li>Parallel chunk download (16x faster) + ZIP split for >2GB</li>
<li>Live admin dashboard with SSE real-time</li>
<li>Rate limiting, caching, secure cookie management</li>
<li>One-click Railway deploy + Docker ready</li>
</ul>
</div>

<p style="color:#8b949e;font-size:13px;margin-top:24px">Made with ❤️ • Railway Edition v3.0 • No ads • Open source • <a href="https://github.com/loginyttg-web/Terabox" style="color:#58a6ff">GitHub</a></p>
</main></body></html>`;
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, options: ApiServerOptions): Promise<void> {
  const { config, resolver, telegramBot, transferManager, logger = console } = options;
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://localhost");
  const ip = getClientIp(request);

  // CORS preflight
  if (method === "OPTIONS") {
    response.writeHead(204, corsHeaders(config));
    response.end();
    return;
  }

  // Rate limiting for /api (60 req/min per IP)
  if (url.pathname === "/api" && isRateLimited(ip, 60, 60_000)) {
    writeJson(response, config, 429, {
      status: "error",
      message: "Rate limit exceeded. Max 60 requests/min per IP. Try again shortly.",
    });
    return;
  }

  if (method !== "GET") {
    methodNotAllowed(response, config);
    return;
  }

  // Admin routes
  if (
    url.pathname === "/admin" ||
    url.pathname === "/admin/status" ||
    url.pathname === "/admin/logs" ||
    url.pathname === "/admin/stream"
  ) {
    if (!config.adminApiKey) {
      writePrivateJson(response, 404, { status: "error", message: "Not found" });
      return;
    }
    const tokenParam = url.searchParams.get("token") ?? "";
    const authorized = isAdminAuthorized(request, config.adminApiKey) || secureEquals(tokenParam, config.adminApiKey);
    if (!authorized) {
      response.setHeader("WWW-Authenticate", 'Basic realm="TeraBox Pro Dashboard"');
      writePrivateJson(response, 401, { status: "error", message: "Admin authorization required. Use Basic auth (admin:ADMIN_API_KEY) or ?token=" });
      return;
    }

    if (url.pathname === "/admin/logs") {
      writePrivateJson(response, 200, { generated_at: new Date().toISOString(), logs: logBuffer.tail(50) });
      return;
    }
    if (url.pathname === "/admin/status") {
      writePrivateJson(response, 200, dashboardData(resolver, transferManager));
      return;
    }
    if (url.pathname === "/admin/stream") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.write("event: hello\ndata: {\"msg\":\"connected\"}\n\n");
      const send = (snapshot: unknown) => {
        try {
          response.write(`event: transfer\ndata: ${JSON.stringify(snapshot)}\n\n`);
        } catch {}
      };
      const unsubscribe = transferManager?.subscribe?.(send) ?? (() => undefined);
      const heartbeat = setInterval(() => {
        try {
          response.write(": ping\n\n");
        } catch {}
      }, 15_000);
      request.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      return;
    }

    const token = encodeURIComponent(config.adminApiKey);
    writeHtml(response, 200, adminDashboardHtml(token));
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    writeHtml(response, 200, landingHtml(config, resolver, telegramBot, transferManager));
    return;
  }

  if (url.pathname === "/api/docs" || url.pathname === "/docs") {
    writeHtml(response, 200, apiDocsHtml());
    return;
  }

  if (url.pathname === "/health" || url.pathname === "/healthz") {
    writeJson(response, config, 200, {
      status: "ok",
      version: "3.0-railway",
      cache_items: resolver.cacheSize,
      telegram: telegramBot ? telegramBot.getStatus() : { enabled: false },
      transfers: transferManager ? transferManager.getStatus() : { enabled: false },
      keepalive: config.keepalive ? { urls: config.keepalive.urls, interval_ms: config.keepalive.intervalMs } : { enabled: false },
      uptime_seconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (url.pathname !== "/api") {
    writeJson(response, config, 404, {
      status: "error",
      message: "Not found. Try /api?url=... or /api/docs",
      endpoints: ["/api?url=<terabox-url>", "/api?url=<url>&scan=1", "/health", "/api/docs", "/admin"],
    });
    return;
  }

  const targetUrl = url.searchParams.get("url")?.trim();
  if (!targetUrl) {
    writeJson(response, config, 400, {
      status: "error",
      message: "Missing required parameter: url",
      example: "/api?url=https://terabox.com/s/1HSEb8PZRUE7Z1Tvd3ZtT0g",
      docs: "/api/docs",
    });
    return;
  }

  if (targetUrl.length > 4_096 || !isValidShareUrl(targetUrl)) {
    writeJson(response, config, 400, {
      status: "error",
      url: targetUrl.slice(0, 512),
      message: "Invalid TeraBox share URL. Supported: terabox.com, terabox.app, 1024terabox, 4funbox, mirrobox, nephobox, dubox + 50 more. See /api/docs",
    });
    return;
  }

  const surl = extractSurl(targetUrl);
  if (!surl) {
    writeJson(response, config, 400, {
      status: "error",
      url: targetUrl,
      message: "Could not extract a TeraBox share identifier (surl). Check URL format.",
    });
    return;
  }

  const pwd = extractSharePassword(targetUrl) || url.searchParams.get("pwd")?.trim() || undefined;

  const startedAt = Date.now();
  try {
    if (url.searchParams.get("scan") === "1") {
      const scanned = await resolver.scanAll(surl, undefined, pwd ? { pwd } : undefined);
      writeJson(response, config, 200, {
        status: "success",
        response_time: `${((Date.now() - startedAt) / 1_000).toFixed(3)}s`,
        url: targetUrl,
        surl,
        file_count: scanned.length,
        total_bytes: scanned.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0),
        total_size: formatBytes(scanned.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0)),
        files: scanned.map((item) => ({
          name: item.name,
          path: item.relativePath,
          is_folder: item.isFolder,
          ...(item.sizeBytes !== undefined && {
            size_bytes: item.sizeBytes,
            size: formatBytes(item.sizeBytes),
          }),
          ...(item.download && { download: item.download }),
        })),
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const { value: share, cacheHit } = await resolver.resolve(surl, undefined, pwd ? { pwd } : undefined);
    writeJson(response, config, 200, successResponse(share, targetUrl, Date.now() - startedAt, cacheHit));
  } catch (error) {
    const statusCode = error instanceof TeraBoxError ? error.statusCode : 502;
    const message = error instanceof TeraBoxError ? error.message : "Unable to resolve the TeraBox share right now.";
    if (!(error instanceof TeraBoxError)) {
      logger.error("[api] Unexpected resolver error", error);
    }
    writeJson(response, config, statusCode, {
      status: "error",
      url: targetUrl,
      surl,
      message,
      response_time: `${((Date.now() - startedAt) / 1_000).toFixed(3)}s`,
      timestamp: new Date().toISOString(),
    });
  }
}

export function createApiServer(options: ApiServerOptions): Server {
  return createServer((request, response) => {
    void handleRequest(request, response, options).catch((error: unknown) => {
      options.logger?.error("[api] Unhandled request error", error);
      if (!response.headersSent) {
        writeJson(response, options.config, 500, {
          status: "error",
          message: "Internal server error",
        });
      } else {
        response.destroy();
      }
    });
  });
}
