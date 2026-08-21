import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AppConfig } from "./config.js";
import { logBuffer } from "./lib/logs.js";
import type { ShareResolver } from "./lib/share-service.js";
import { type ResolvedShare, TeraBoxError } from "./lib/terabox.js";
import { extractSurl, formatBytes, isValidShareUrl } from "./lib/utils.js";

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
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function writeJson(
  response: ServerResponse,
  config: AppConfig,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...corsHeaders(config),
  });
  response.end(JSON.stringify(body));
}

function writePrivateJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
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
  if (!apiKey) {
    return false;
  }
  const authorization = request.headers.authorization;
  if (!authorization) {
    return false;
  }
  if (authorization.startsWith("Bearer ")) {
    return secureEquals(authorization.slice(7), apiKey);
  }
  if (authorization.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      return separator > 0 && decoded.slice(0, separator) === "admin" && secureEquals(decoded.slice(separator + 1), apiKey);
    } catch {
      return false;
    }
  }
  return false;
}

function methodNotAllowed(response: ServerResponse, config: AppConfig): void {
  response.setHeader("Allow", "GET, OPTIONS");
  writeJson(response, config, 405, { status: "error", message: "Method not allowed" });
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

function successResponse(
  share: ResolvedShare,
  sourceUrl: string,
  elapsedMs: number,
  cacheHit: boolean,
): Record<string, unknown> {
  const firstFile = share.files[0];

  return {
    status: "success",
    response_time: `${(elapsedMs / 1_000).toFixed(3)}s`,
    url: sourceUrl,
    surl: share.surl,
    cached: cacheHit,
    file_count: share.files.length,
    files: share.files.map(toPublicFile),
    // Keep the original API's first-item fields for existing clients.
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

/** Self-contained live dashboard (Basic-auth gated). Polls status/logs and
 * listens to the SSE stream for instant transfer updates. */
function adminDashboardHtml(token: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>TeraBox transfer dashboard</title>
<style>
*{box-sizing:border-box}
body{margin:0;background:#0d1117;color:#e6edf3;font:14px/1.5 system-ui,sans-serif}
main{max-width:1100px;margin:28px auto;padding:0 18px}
h1{font-size:22px;margin:0 0 4px}
.sub{color:#8b949e;margin:0 0 18px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:22px}
.card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:12px 14px}
.card .n{font-size:22px;font-weight:700}
.card .l{color:#8b949e;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
h2{font-size:15px;margin:22px 0 8px;color:#e6edf3}
table{width:100%;border-collapse:collapse;background:#161b22;border:1px solid #30363d;border-radius:10px;overflow:hidden}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #21262d;font-size:13px;vertical-align:top}
th{background:#21262d;color:#8b949e;font-size:12px;text-transform:uppercase}
tr:last-child td{border-bottom:none}
.tag{display:inline-block;padding:1px 8px;border-radius:20px;font-size:12px;background:#21262d}
.tag.downloading,.tag.preparing{background:#1f6feb33;color:#58a6ff}
.tag.uploading{background:#23863633;color:#3fb950}
.tag.splitting{background:#9e6a0333;color:#d29922}
.tag.completed{background:#23863633;color:#3fb950}
.tag.failed{background:#da363333;color:#f85149}
.tag.cancelled,.tag.queued{background:#6e768166;color:#8b949e}
.bar{height:6px;background:#21262d;border-radius:4px;overflow:hidden;margin-top:4px}
.bar>div{height:100%;background:#3fb950}
pre.log{margin:0;background:#0d1117;padding:10px;max-height:320px;overflow:auto;font:12px/1.5 ui-monospace,Menlo,monospace;border:1px solid #30363d;border-radius:8px}
.lvl{font-weight:700}
.lvl.warn{color:#d29922}.lvl.error{color:#f85149}
</style></head><body><main>
<h1>📊 TeraBox transfer dashboard</h1>
<p class="sub" id="sub">Loading…</p>
<div class="grid">
  <div class="card"><div class="n" id="cActive">-</div><div class="l">Active</div></div>
  <div class="card"><div class="n" id="cQueued">-</div><div class="l">Queued</div></div>
  <div class="card"><div class="n" id="cCache">-</div><div class="l">Cache items</div></div>
  <div class="card"><div class="n" id="cDisk">-</div><div class="l">Disk free</div></div>
</div>
<h2>Transfers</h2>
<table><thead><tr><th>Job</th><th>Stage</th><th>File</th><th>Progress</th></tr></thead>
<tbody id="jobs"><tr><td colspan="4">Loading…</td></tr></tbody></table>
<h2>Recent events</h2>
<table><thead><tr><th>Time</th><th>Stage</th><th>Message</th></tr></thead>
<tbody id="events"><tr><td colspan="3">Loading…</td></tr></tbody></table>
<h2>Recent logs</h2>
<pre class="log" id="logs">Loading…</pre>
<script>
const token = ${JSON.stringify(token)};
const esc = s => String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const fmtBytes = n => { if(n==null) return "—"; const u=["B","KB","MB","GB","TB"]; let i=0; while(n>=1024&&i<u.length-1){n/=1024;i++} return n.toFixed(i?1:0)+" "+u[i]; };
const time = t => new Date(t).toLocaleTimeString();
const stageClass = s => String(s).toLowerCase();
function progress(job){
  if(job.transferredBytes!=null && job.totalBytes>0){ const p=Math.min(100,Math.round(job.transferredBytes/job.totalBytes*100)); return p+"%<div class=bar><div style=width:"+p+"%></div></div>"; }
  return "—";
}
function jobsHtml(tr){
  const rows = (tr.recent_jobs||[]);
  const tbody = document.getElementById("jobs");
  if(!rows.length){ tbody.innerHTML="<tr><td colspan=4>No transfers yet.</td></tr>"; return; }
  tbody.innerHTML = rows.map(j=>\`<tr>
    <td><code>\${esc(j.id)}</code><br><small>\${esc(j.stage)}</small></td>
    <td><span class="tag \${stageClass(j.stage)}">\${esc(j.stage)}</span>\${j.totalFileCount&&j.currentFileIndex?\` <small>File \${j.currentFileIndex}/\${j.totalFileCount}</small>\`:""}</td>
    <td>\${esc(j.filename||"")}\${j.partCount>1?\`<br><small>Part \${j.partIndex||1}/\${j.partCount}</small>\`:""}</td>
    <td>\${progress(j)}\${j.speedBytesPerSecond?\`<small> · \${fmtBytes(j.speedBytesPerSecond)}/s</small>\`:""}</td>
  </tr>\`).join("");
}
function eventsHtml(ev){
  const tbody=document.getElementById("events");
  if(!ev.length){ tbody.innerHTML="<tr><td colspan=3>No events.</td></tr>"; return; }
  tbody.innerHTML=ev.map(e=>\`<tr><td>\${time(e.created_at)}</td><td><span class="tag \${stageClass(e.stage)}">\${esc(e.stage)}</span></td><td>\${esc(e.message||"")}</td></tr>\`).join("");
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
    document.getElementById("cQueued").textContent=(t.queued_jobs??0);
    document.getElementById("cCache").textContent=d.cache_items??0;
    document.getElementById("cDisk").textContent=t.disk?fmtBytes(t.disk.available_bytes):"—";
    document.getElementById("sub").textContent="Live · updated "+new Date(d.generated_at).toLocaleTimeString();
    jobsHtml(t); eventsHtml(t.recent_events||[]);
    const lr=await fetch("/admin/logs?token="+token,{cache:"no-store"});
    const ld=await lr.json(); logsHtml(ld.logs||[]);
  }catch(e){ document.getElementById("sub").textContent="Error loading: "+e; }
}
refresh(); setInterval(refresh,3000);
// Real-time push via SSE (falls back to 3s polling).
try{
  const es=new EventSource("/admin/stream?token="+token);
  es.addEventListener("transfer",()=>refresh());
}catch(e){}
</script>
</main></body></html>`;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ApiServerOptions,
): Promise<void> {
  const { config, resolver, telegramBot, transferManager, logger = console } = options;
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", "http://localhost");

  if (method === "OPTIONS") {
    response.writeHead(204, corsHeaders(config));
    response.end();
    return;
  }

  if (method !== "GET") {
    methodNotAllowed(response, config);
    return;
  }

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
    // Header auth (Basic/Bearer) OR an explicit ?token= for the SSE stream.
    const tokenParam = url.searchParams.get("token") ?? "";
    const authorized =
      isAdminAuthorized(request, config.adminApiKey) || secureEquals(tokenParam, config.adminApiKey);
    if (!authorized) {
      response.setHeader("WWW-Authenticate", 'Basic realm="TeraBox transfer dashboard"');
      writePrivateJson(response, 401, { status: "error", message: "Admin authorization required" });
      return;
    }

    if (url.pathname === "/admin/logs") {
      writePrivateJson(response, 200, { generated_at: new Date().toISOString(), logs: logBuffer.tail(40) });
      return;
    }

    if (url.pathname === "/admin/status") {
      writePrivateJson(response, 200, dashboardData(resolver, transferManager));
      return;
    }

    if (url.pathname === "/admin/stream") {
      // Server-Sent Events: push every live transfer snapshot in real time.
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.write("event: hello\ndata: {}\n\n");
      const send = (snapshot: unknown) => {
        try {
          response.write(`event: transfer\ndata: ${JSON.stringify(snapshot)}\n\n`);
        } catch {
          /* client gone */
        }
      };
      const unsubscribe = transferManager?.subscribe?.(send) ?? (() => undefined);
      // Heartbeat keeps proxies from dropping the idle connection.
      const heartbeat = setInterval(() => {
        try {
          response.write(": ping\n\n");
        } catch {
          /* ignore */
        }
      }, 15_000);
      request.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      return;
    }

    // /admin — live dashboard HTML.
    const token = encodeURIComponent(config.adminApiKey);
    writeHtml(response, 200, adminDashboardHtml(token));
    return;
  }

  if (url.pathname === "/") {
    writeJson(response, config, 200, {
      name: "TeraBox Telegram Bot API",
      version: "2.3",
      status: "operational",
      endpoints: {
        "/api?url=<terabox-share-url>": "Resolve a TeraBox share URL",
        "/api?url=<terabox-share-url>&scan=1": "Recursively scan all sub-folders",
        "/health": "Service health and Telegram polling status",
      },
      telegram_enabled: Boolean(telegramBot),
      telegram_upload_enabled: Boolean(transferManager),
      keepalive_enabled: Boolean(config.keepalive),
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (url.pathname === "/health") {
    writeJson(response, config, 200, {
      status: "ok",
      cache_items: resolver.cacheSize,
      telegram: telegramBot ? telegramBot.getStatus() : { enabled: false },
      transfers: transferManager ? transferManager.getStatus() : { enabled: false },
      keepalive: config.keepalive
        ? { urls: config.keepalive.urls, interval_ms: config.keepalive.intervalMs }
        : { enabled: false },
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (url.pathname !== "/api") {
    writeJson(response, config, 404, { status: "error", message: "Not found" });
    return;
  }

  const targetUrl = url.searchParams.get("url")?.trim();
  if (!targetUrl) {
    writeJson(response, config, 400, {
      status: "error",
      message: "Missing required parameter: url",
      example: "/api?url=https://terabox.app/s/1HSEb8PZRUE7Z1Tvd3ZtT0g",
    });
    return;
  }

  if (targetUrl.length > 4_096 || !isValidShareUrl(targetUrl)) {
    writeJson(response, config, 400, {
      status: "error",
      url: targetUrl.slice(0, 512),
      message: "Invalid TeraBox share URL",
    });
    return;
  }

  const surl = extractSurl(targetUrl);
  if (!surl) {
    writeJson(response, config, 400, {
      status: "error",
      url: targetUrl,
      message: "Could not extract a TeraBox share identifier",
    });
    return;
  }

  const startedAt = Date.now();
  try {
    // ?scan=1 recursively walks every sub-folder and returns all files, each
    // with a relative path + its own download link.
    if (url.searchParams.get("scan") === "1") {
      const scanned = await resolver.scanAll(surl);
      writeJson(response, config, 200, {
        status: "success",
        response_time: `${((Date.now() - startedAt) / 1_000).toFixed(3)}s`,
        url: targetUrl,
        surl,
        file_count: scanned.length,
        total_bytes: scanned.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0),
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

    const { value: share, cacheHit } = await resolver.resolve(surl);
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
