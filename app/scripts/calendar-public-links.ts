// Signed core-side issuer for the Home Durable Object's short-lived public calendar
// capabilities. The public URL is a bearer token, but issuing it remains authenticated
// with the tenant's existing SigV4 Home credential.
import { AwsClient } from "aws4fetch";
import { loadHomeKeys } from "./home-mirror.ts";
import type { HomeKeys } from "./home-mirror.ts";
import { homeOriginOrThrow } from "./home-origin.ts";

const TENANT_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;
const TOKEN_RE = /^[a-f0-9]{36}$/;

export interface CalendarPublicLinkEvent {
  uid: string;
  title: string;
  start: string;
  end?: string;
  allDay: boolean;
  location?: string;
}

export interface CalendarPublicLinkIssue {
  event: CalendarPublicLinkEvent;
  ics: string;
}

export interface IssuedCalendarPublicLink {
  token: string;
  expiresAt: number;
  homeOrigin: string;
  tenant: string;
}

export interface CalendarPublicLinkIssuerDeps {
  keys?: HomeKeys;
  homeOrigin?: string;
  fetchFn?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

function publicOriginOrThrow(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("HOME_BASE_URL must be a bare http(s) origin"); }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash || url.origin !== value) {
    throw new Error("HOME_BASE_URL must be a bare http(s) origin");
  }
  return url.origin;
}

// home-keys.json is privileged local configuration. Validate its target before signing:
// a corrupted file must not turn the tenant's Home secret into a signature oracle for a
// different host or arbitrary route.
function issueEndpointOrThrow(keys: HomeKeys, homeOrigin: string): { endpoint: string; tenant: string } {
  if (!keys || typeof keys.tenant !== "string" || !TENANT_RE.test(keys.tenant)
      || typeof keys.endpoint !== "string" || typeof keys.accessKeyId !== "string" || typeof keys.secretAccessKey !== "string") {
    throw new Error("home-keys.json is invalid");
  }
  let endpoint: URL;
  try { endpoint = new URL(keys.endpoint); } catch { throw new Error("home-keys.json endpoint is invalid"); }
  if (endpoint.origin !== homeOrigin || endpoint.pathname !== `/svc/${keys.tenant}`
      || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) {
    throw new Error("home-keys.json endpoint must be this tenant's Home service URL");
  }
  return { endpoint: `${endpoint.origin}${endpoint.pathname}/calendar-link`, tenant: keys.tenant };
}

function parseIssued(value: unknown): { token: string; expiresAt: number } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.token !== "string" || !TOKEN_RE.test(raw.token)
      || typeof raw.expiresAt !== "number" || !Number.isSafeInteger(raw.expiresAt)) return null;
  return { token: raw.token, expiresAt: raw.expiresAt };
}

export async function issueCalendarPublicLink(
  issue: CalendarPublicLinkIssue,
  deps: CalendarPublicLinkIssuerDeps = {},
): Promise<IssuedCalendarPublicLink> {
  const homeOrigin = deps.homeOrigin === undefined
    ? homeOriginOrThrow(deps.env)
    : publicOriginOrThrow(deps.homeOrigin);
  const keys = deps.keys ?? loadHomeKeys();
  const { endpoint, tenant } = issueEndpointOrThrow(keys, homeOrigin);
  const body = JSON.stringify(issue);
  const aws = new AwsClient({
    accessKeyId: keys.accessKeyId,
    secretAccessKey: keys.secretAccessKey,
    service: "home",
    region: "auto",
  });
  const signed = await aws.sign(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

  let response: Response;
  try {
    response = await (deps.fetchFn ?? fetch)(signed);
  } catch {
    throw new Error("calendar link issuance failed");
  }
  if (!response.ok) throw new Error(`calendar link issuance failed (HTTP ${response.status})`);

  let raw: unknown;
  try { raw = await response.json(); } catch { throw new Error("calendar link issuance returned invalid response"); }
  const issued = parseIssued(raw);
  if (!issued) throw new Error("calendar link issuance returned invalid response");
  return { ...issued, homeOrigin, tenant };
}
