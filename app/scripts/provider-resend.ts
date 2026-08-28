// Resend's SDK hard-codes the global fetch implementation. Light workers must
// instead cross the per-request provider lease boundary, so install the same
// fetchRequest contract on every SDK instance (including the Chat adapter's
// internally-held client).
import { Resend } from "resend";
import { isLeaseRevokedError, providerFetch, type FetchLike } from "./provider-lease-transport.ts";

type ResendResponse<T> = { data: T | null; error: Record<string, unknown> | null; headers: Record<string, string> | null };

export function createProviderResend(apiKey: string, fetchImpl: FetchLike = providerFetch): Resend {
  const client = new Resend(apiKey);
  const baseUrl = process.env.RESEND_BASE_URL || "https://api.resend.com";
  client.fetchRequest = (async <T>(path: string, options: RequestInit = {}): Promise<ResendResponse<T>> => {
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, options);
      const headers = Object.fromEntries(response.headers.entries());
      if (!response.ok) {
        const raw = await response.text();
        try {
          return { data: null, error: JSON.parse(raw) as Record<string, unknown>, headers };
        } catch (error) {
          if (isLeaseRevokedError(error)) throw error;
          return {
            data: null,
            error: error instanceof SyntaxError
              ? { name: "application_error", statusCode: response.status, message: "Internal server error. We are unable to process your request right now, please try again later." }
              : { name: "application_error", statusCode: response.status, message: error instanceof Error ? error.message : response.statusText },
            headers,
          };
        }
      }
      return { data: await response.json() as T, error: null, headers };
    } catch (error) {
      if (isLeaseRevokedError(error)) throw error;
      return { data: null, error: { name: "application_error", statusCode: null, message: "Unable to fetch data. The request could not be resolved." }, headers: null };
    }
  }) as typeof client.fetchRequest;
  return client;
}
