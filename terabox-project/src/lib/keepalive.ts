/**
 * Simple keep-alive pinger.
 *
 * IMPORTANT (free Render plan): Render free web services sleep after ~15 min of
 * inactivity. A request that originates from INSIDE the service cannot wake it
 * up once it is asleep. For a truly always-on free service you should also use
 * an EXTERNAL uptime monitor (UptimeRobot / Cronitor / Healthchecks.io) pointed
 * at your service's `/health` URL every ~10 min. This module is a convenience
 * for instances that are already awake (paid/no-sleep) or to reduce cold starts.
 */
export function startKeepAlive(urls: string[], intervalMs: number): () => void {
  if (urls.length === 0) {
    return () => undefined;
  }

  const ping = (): void => {
    for (const url of urls) {
      fetch(url, { method: "GET", signal: AbortSignal.timeout(15_000) })
        .then(() => undefined)
        .catch(() => undefined);
    }
  };

  ping();
  const timer = setInterval(ping, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
