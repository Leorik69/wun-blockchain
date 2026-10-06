/**
 * API key gate for protected blockchain HTTP routes.
 * Production must fail closed when BLOCKCHAIN_API_KEY is unset.
 */

export type ApiKeyAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; error: string };

export type ApiKeyAuthInput = {
  configuredKey: string;
  providedKey: string;
  nodeEnv: string | undefined;
};

/**
 * Evaluate whether a request may proceed past requireApiKey.
 */
export function evaluateApiKeyAuth(input: ApiKeyAuthInput): ApiKeyAuthResult {
  const configured = (input.configuredKey || "").trim();
  const provided = (input.providedKey || "").trim();
  const isProduction = (input.nodeEnv || "").toLowerCase() === "production";

  if (!configured) {
    if (isProduction) {
      return { ok: false, status: 503, error: "API key not configured" };
    }
    return { ok: true };
  }

  if (!provided || provided !== configured) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  return { ok: true };
}
