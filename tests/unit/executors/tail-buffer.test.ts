import { describe, expect, test } from 'vitest';
import { TailBuffer, utf8Tail } from '../../../src/server/executors/tail-buffer.js';

describe('TailBuffer', () => {
  test('keeps everything while it fits', () => {
    const buffer = new TailBuffer(16);
    buffer.push(Buffer.from('hello '));
    buffer.push(Buffer.from('world'));
    expect(buffer.toString()).toBe('hello world');
    expect(buffer.truncated).toBe(false);
  });

  test('keeps only the last `limit` bytes and says it dropped some', () => {
    const buffer = new TailBuffer(5);
    buffer.push(Buffer.from('abcdefgh'));
    expect(buffer.truncated).toBe(true);
    expect(buffer.toString()).toBe('defgh');
    expect(buffer.truncated).toBe(true);
  });

  test('stays bounded across many small chunks', () => {
    const buffer = new TailBuffer(10);
    for (let n = 0; n < 1_000; n += 1) buffer.push(Buffer.from(`${n % 10}`));
    expect(buffer.toString()).toBe('0123456789');
    expect(buffer.truncated).toBe(true);
  });

  test('is empty before anything was pushed, and with a limit of 0', () => {
    expect(new TailBuffer(8).toString()).toBe('');
    const nothing = new TailBuffer(0);
    nothing.push(Buffer.from('dropped'));
    expect(nothing.toString()).toBe('');
    expect(nothing.truncated).toBe(true);
  });

  test('never starts the kept text in the middle of a character', () => {
    const buffer = new TailBuffer(5);
    buffer.push(Buffer.from('ab€€')); // € is three bytes
    expect(buffer.toString()).toBe('€');
  });
});

describe('utf8Tail', () => {
  test('returns the input unchanged when it fits', () => {
    const bytes = Buffer.from('short');
    expect(utf8Tail(bytes, 10)).toBe(bytes);
  });

  test('steps past continuation bytes of a cut character', () => {
    const bytes = Buffer.from('x😀y'); // the emoji is four bytes
    expect(utf8Tail(bytes, 4).toString('utf8')).toBe('y');
    expect(utf8Tail(bytes, 5).toString('utf8')).toBe('😀y');
  });

  test('treats a negative limit as 0', () => {
    expect(utf8Tail(Buffer.from('abc'), -3).length).toBe(0);
  });
});
