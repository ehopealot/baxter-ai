// Best-effort observability for a daemon that starts while durable drain state is active.
// The durable claim is made before delivery: one failed POST is still the generation's
// single best-effort attempt, rather than a restart-driven notification storm.
import { claimDrainStartupAlert, drainStatePath } from "./drain.ts";

export type AlertFetch = (url: string, init: RequestInit) => Promise<{ ok?: boolean; status?: number }>;

export interface DrainStartupAlertOptions {
  env?: NodeJS.ProcessEnv;
  path?: string;
  fetchFn?: AlertFetch;
  logErr?: (message: string) => void;
}

const ALERT_CONTENT = "Baxter started while persistent drain state is active.";

export async function alertOnDrainStartup({
  env = process.env,
  path = drainStatePath(env),
  fetchFn = fetch,
  logErr = console.error,
}: DrainStartupAlertOptions = {}): Promise<void> {
  const webhookUrl = env.DISCORD_ALERT_WEBHOOK;
  if (!webhookUrl) return;

  try {
    if (!(await claimDrainStartupAlert(path))) return;
    const response = await fetchFn(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: ALERT_CONTENT }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok === false || (typeof response.status === "number" && response.status >= 400)) {
      logErr("drain startup alert delivery failed");
    }
  } catch {
    // Never include the exception: HTTP client errors can echo the secret webhook URL.
    logErr("drain startup alert delivery failed");
  }
}
