const CONTINUATION_MASK = 0b1100_0000;
const CONTINUATION_BITS = 0b1000_0000;

/**
 * Collects process output but keeps only the last `limit` bytes, so a chatty
 * child cannot grow the server's memory without bound. The end of a log is the
 * part that says why it failed.
 */
export class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  private dropped = false;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    if (this.size > this.limit * 2) this.compact();
  }

  /** True when earlier output was discarded to stay inside the limit. */
  get truncated(): boolean {
    return this.dropped || this.size > this.limit;
  }

  toString(): string {
    this.compact();
    return (this.chunks[0] ?? Buffer.alloc(0)).toString('utf8');
  }

  private compact(): void {
    const all = this.chunks.length === 1 && this.chunks[0] ? this.chunks[0] : Buffer.concat(this.chunks);
    const tail = utf8Tail(all, this.limit);
    if (tail.length < all.length) this.dropped = true;
    this.chunks = [tail];
    this.size = tail.length;
  }
}

/**
 * The last `limit` bytes of `bytes`. Cutting mid-character would start the text
 * with a replacement glyph, so the cut steps past any partial character.
 */
export function utf8Tail(bytes: Buffer, limit: number): Buffer {
  if (bytes.length <= limit) return bytes;
  const tail = bytes.subarray(bytes.length - Math.max(0, limit));
  let start = 0;
  while (start < tail.length && start < 4 && ((tail[start] ?? 0) & CONTINUATION_MASK) === CONTINUATION_BITS) {
    start += 1;
  }
  return tail.subarray(start);
}
