import { describe, expect, test } from 'vitest';
import { hmacSha256Hex, verifyHmacSha256 } from '../../../src/server/signals/hmac.js';

// Published test vector from GitHub's "Validating webhook deliveries" page.
const SECRET = "It's a Secret to Everybody";
const BODY = 'Hello, World!';
const DIGEST = '757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';

describe('hmacSha256Hex', () => {
  test('matches the digest GitHub publishes for its sample secret and payload', () => {
    // Act
    const digest = hmacSha256Hex(SECRET, BODY);

    // Assert
    expect(digest).toBe(DIGEST);
  });
});

describe('verifyHmacSha256', () => {
  test('accepts the correct digest', () => {
    expect(verifyHmacSha256(BODY, DIGEST, SECRET)).toBe(true);
  });

  test('accepts the correct digest in upper case', () => {
    expect(verifyHmacSha256(BODY, DIGEST.toUpperCase(), SECRET)).toBe(true);
  });

  test('rejects a digest computed with a different secret', () => {
    const forged = hmacSha256Hex('some other secret', BODY);

    expect(verifyHmacSha256(BODY, forged, SECRET)).toBe(false);
  });

  test('rejects when a single byte of the body changed', () => {
    expect(verifyHmacSha256(`${BODY} `, DIGEST, SECRET)).toBe(false);
  });

  test('rejects a missing signature', () => {
    expect(verifyHmacSha256(BODY, undefined, SECRET)).toBe(false);
  });

  test('rejects a signature of the wrong length without throwing', () => {
    expect(verifyHmacSha256(BODY, DIGEST.slice(0, 40), SECRET)).toBe(false);
    expect(verifyHmacSha256(BODY, `${DIGEST}00`, SECRET)).toBe(false);
  });

  test('rejects a signature that is not hexadecimal', () => {
    const notHex = 'z'.repeat(64);

    expect(verifyHmacSha256(BODY, notHex, SECRET)).toBe(false);
  });

  test('rejects everything when the secret is empty', () => {
    const digestForEmptySecret = hmacSha256Hex('', BODY);

    expect(verifyHmacSha256(BODY, digestForEmptySecret, '')).toBe(false);
  });

  test('signs the body as UTF-8 so non-ASCII payloads verify', () => {
    const body = '{"title":"Zażółć gęślą jaźń ✓"}';
    const digest = hmacSha256Hex(SECRET, body);

    expect(verifyHmacSha256(body, digest, SECRET)).toBe(true);
  });
});
