import { analyticsEnabled } from "./clickhouse.js";
import { ensureSchema } from "./schema.js";
import { shipUsage } from "./usageShipper.js";
import { recordTrace } from "./traceSink.js";

const SHIP_INTERVAL_MS = 10_000;
let started = false;
let ready = false;

export { analyticsEnabled };

// Fire-and-forget: analytics must never slow down or fail a request.
export function emitTrace(detail) {
  if (!analyticsEnabled()) return;
  recordTrace(detail).catch((e) => console.error(`[analytics] trace dropped: ${e.message}`));
}

export function startAnalytics() {
  if (started || !analyticsEnabled()) return;
  started = true;
  let running = false;
  let lastError = "";
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (!ready) { await ensureSchema(); ready = true; }
      const n = await shipUsage();
      if (n) console.log(`[analytics] shipped ${n} usage rows`);
      lastError = "";
    } catch (e) {
      if (e.message !== lastError) console.error(`[analytics] ${e.message}`);
      lastError = e.message;
    } finally {
      running = false;
    }
  };
  tick();
  setInterval(tick, SHIP_INTERVAL_MS).unref?.();
}
