import { describe, expect, test } from 'vitest';
import { clipTail, clipText } from '../../../src/server/engine/text.js';

describe('clipText', () => {
  test('returns text that fits as it is', () => {
    expect(clipText('short', 10)).toBe('short');
    expect(clipText('exactly ten', 11)).toBe('exactly ten');
    expect(clipText('', 3)).toBe('');
  });

  test('counts characters, so an emoji at the limit is kept whole or dropped whole', () => {
    expect(clipText('ab😀cd', 3)).toBe('ab😀');
    expect(clipText('ab😀cd', 2)).toBe('ab');
    expect(clipText('😀😀😀', 2)).toBe('😀😀');
  });

  test('keeps text whose code points fit even when its UTF-16 length does not', () => {
    expect(clipText('😀😀😀', 3)).toBe('😀😀😀');
    expect(clipText('😀😀😀', 3).length).toBe(6);
  });

  test('never returns half an emoji', () => {
    for (let max = 0; max <= 8; max += 1) {
      const clipped = clipText('x😀y😀z😀', max);
      expect(clipped, String(max)).toBe(Buffer.from(clipped, 'utf8').toString('utf8'));
      expect([...clipped].length).toBeLessThanOrEqual(max);
    }
  });

  test('makes the text safe to store before clipping it', () => {
    expect(clipText('a\ud83db\0c', 10)).toBe('a�b�c');
    expect(clipText('a\ud83db\0c', 3)).toBe('a�b');
  });
});

describe('clipTail', () => {
  test('returns text that fits as it is', () => {
    expect(clipTail('short', 10)).toBe('short');
    expect(clipTail('exactly ten', 11)).toBe('exactly ten');
  });

  test('keeps the end and marks the cut with a "…", within the limit', () => {
    const clipped = clipTail('abcdefghij', 5);

    expect(clipped).toBe('…ghij');
    expect([...clipped]).toHaveLength(5);
  });

  test('never starts in the middle of an emoji', () => {
    expect(clipTail('abc😀def', 4)).toBe('…def');
    expect(clipTail('abc😀def', 5)).toBe('…😀def');
    expect(clipTail('😀'.repeat(10), 4)).toBe(`…${'😀'.repeat(3)}`);
  });

  test('keeps text whose code points fit even when its UTF-16 length does not', () => {
    expect(clipTail('😀😀😀', 3)).toBe('😀😀😀');
  });

  test('makes the text safe to store', () => {
    expect(clipTail('x\0y', 10)).toBe('x�y');
    expect(clipTail('\ude00 tail', 5)).toBe('…tail');
  });

  test('handles a lone low surrogate at the very start of what is kept', () => {
    expect(clipTail('abcd\ude00', 3)).toBe('…d�');
  });
});
