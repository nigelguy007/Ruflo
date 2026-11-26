import { storableText } from '../db/text.js';

const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;
const LOW_SURROGATE_FIRST = 0xdc00;
const LOW_SURROGATE_LAST = 0xdfff;

/** The first `max` characters of `value`, counted as code points so an emoji is never cut in half. */
function head(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = 0;
  let count = 0;
  for (const character of value) {
    if (count === max) break;
    end += character.length;
    count += 1;
  }
  return value.slice(0, end);
}

function countCodePoints(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

/** Where the last `max` code points of `value` begin. */
function tailStart(value: string, max: number): number {
  let start = value.length;
  for (let count = 0; start > 0 && count < max; count += 1) {
    const unit = value.charCodeAt(start - 1);
    const before = start >= 2 ? value.charCodeAt(start - 2) : 0;
    const pairedLow = unit >= LOW_SURROGATE_FIRST && unit <= LOW_SURROGATE_LAST;
    const pairedHigh = before >= HIGH_SURROGATE_FIRST && before <= HIGH_SURROGATE_LAST;
    start -= pairedLow && pairedHigh ? 2 : 1;
  }
  return start;
}

/** At most `max` characters of `value`, made safe to store; never splits an emoji. */
export function clipText(value: string, max: number): string {
  return head(storableText(value), max);
}

/** At most `max` characters from the end of `value`, with a "…" in front when something was cut. */
export function clipTail(value: string, max: number): string {
  const safe = storableText(value);
  if (safe.length <= max || countCodePoints(safe) <= max) return safe;
  return `…${safe.slice(tailStart(safe, max - 1))}`;
}
