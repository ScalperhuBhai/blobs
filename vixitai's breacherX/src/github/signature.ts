/**
 * GitHub webhook signature verification (launch blocker: "signed webhooks").
 *
 * GitHub signs each webhook delivery with HMAC-SHA256 over the raw request body
 * using the app's webhook secret, sent as the `X-Hub-Signature-256` header
 * (`sha256=<hex>`). We verify in constant time and never trust an unsigned or
 * mismatched delivery.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export function computeSignature(secret: string, rawBody: Buffer | string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(rawBody);
  return `sha256=${hmac.digest("hex")}`;
}

/**
 * Constant-time comparison of the provided signature against the expected one.
 * Returns false for any malformed/missing input rather than throwing.
 */
export function verifySignature(
  secret: string,
  rawBody: Buffer | string,
  providedSignature: string | undefined | null,
): boolean {
  if (!secret || !providedSignature) return false;
  const expected = computeSignature(secret, rawBody);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(providedSignature, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
