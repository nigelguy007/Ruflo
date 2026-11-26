import { describe, expect, test } from 'vitest';
import { abortError, delay, isAbortError } from '../../../src/server/executors/abort.js';

describe('abort helpers', () => {
  test('abortError is shaped like the error fetch rejects with', () => {
    const error = abortError('stopped');
    expect(error).toMatchObject({ name: 'AbortError', message: 'stopped' });
    expect(isAbortError(error)).toBe(true);
    expect(abortError().message).toBe('The operation was aborted');
  });

  test('isAbortError is false for anything else', () => {
    expect(isAbortError(new Error('boom'))).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });

  test('delay resolves after the pause', async () => {
    await expect(delay(5, new AbortController().signal)).resolves.toBeUndefined();
  });

  test('delay rejects as soon as the signal fires, or at once when it already has', async () => {
    const controller = new AbortController();
    const waiting = delay(60_000, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await expect(delay(10, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
