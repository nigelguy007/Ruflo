/**
 * Text the database can keep exactly as given.
 *
 * SQLite stores a lone UTF-16 surrogate as U+FFFD, and reads a value that
 * contains NUL back cut off at the NUL. A string that goes through either
 * therefore comes back different from the one that was written, which the
 * ledger would report as tampering. Everything free-form is passed through
 * `storableText` before it is hashed or stored, so what was hashed is what
 * the database holds.
 */

const REPLACEMENT = '�';
const NUL = /\0/g;
/** A high surrogate without a low one after it, or a low surrogate without a high one before it. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** `value` with every lone surrogate and every NUL replaced by U+FFFD. Anything else is returned untouched. */
export function storableText(value: string): string {
  return value.replace(LONE_SURROGATE, REPLACEMENT).replace(NUL, REPLACEMENT);
}

export function storableTextOrNull(value: string | null): string | null {
  return value === null ? null : storableText(value);
}

/** True when `storableText` would leave `value` as it is. */
export function isStorableText(value: string): boolean {
  return storableText(value) === value;
}
