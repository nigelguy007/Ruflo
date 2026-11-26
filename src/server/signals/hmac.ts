import { createHmac, timingSafeEqual } from 'node:crypto';

const SHA256_HEX = /^[0-9a-f]{64}$/i;

/** Hex HMAC-SHA256 of the exact raw body, keyed with the provider secret. */
export function hmacSha256Hex(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/**
 * Constant-time check that `candidateHex` is the HMAC-SHA256 of `rawBody`.
 *
 * Anything that is not exactly 64 hex characters is rejected before the
 * comparison, so the byte-wise compare always sees two 32-byte buffers. An
 * empty secret verifies nothing: an unset secret must never accept a delivery.
 */
export function verifyHmacSha256(
  rawBody: string,
  candidateHex: string | undefined,
  secret: string,
): boolean {
  if (typeof candidateHex !== 'string' || typeof rawBody !== 'string') return false;
  if (typeof secret !== 'string' || secret.length === 0) return false;
  if (!SHA256_HEX.test(candidateHex)) return false;

  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest();
  const candidate = Buffer.from(candidateHex, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
