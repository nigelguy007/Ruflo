/** Longest title a signal may carry; matches the limit on hand-entered signals. */
export const MAX_TITLE_LENGTH = 200;
const MAX_URL_LENGTH = 2000;

/** Collapse whitespace and cut to `max` characters, marking the cut with an ellipsis. */
export function clip(text: string, max: number = MAX_TITLE_LENGTH): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Provider payloads are untrusted, and the console renders `url` as a link.
 * Only absolute http(s) URLs survive; anything else becomes null.
 */
export function httpUrlOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? value : null;
  } catch {
    return null;
  }
}

/** First candidate that is a usable http(s) URL. */
export function firstHttpUrl(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    const url = httpUrlOrNull(candidate);
    if (url !== null) return url;
  }
  return null;
}

/** Read one header from a caller-lower-cased header map without trusting its shape. */
export function header(headers: Record<string, string>, name: string): string | undefined {
  if (headers === null || typeof headers !== 'object') return undefined;
  const value: unknown = Object.hasOwn(headers, name) ? headers[name] : undefined;
  return typeof value === 'string' ? value.trim() : undefined;
}
