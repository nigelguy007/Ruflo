import { describe, expect, test } from 'vitest';
import {
  findLastJsonObject,
  readClaudeOutput,
  readPlainOutput,
  toStepResult,
} from '../../../src/server/executors/parse.js';

const END_OK = { label: 'Claude', exitCode: 0, stderr: '' };

const FINAL_BLOCK = {
  summary: 'Opened a pull request with one regression test. It fails on main and passes on the branch.',
  artifacts: [{ kind: 'pr', label: 'Pull request', value: 'https://git.example/acme/api/pull/7' }],
  claims: [{ label: 'Regression test', detail: 'Fails on main, passes on the branch.', ok: true }],
};

function fencedReply(block: unknown, lead = 'Done.'): string {
  return `${lead}\n\n\`\`\`json\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`;
}

describe('readClaudeOutput', () => {
  test('takes the result text and the reported cost from the JSON result object', () => {
    // Arrange
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'All done.',
      session_id: 'abc',
      total_cost_usd: 0.0421,
    });

    // Act
    const session = readClaudeOutput(stdout);

    // Assert
    expect(session).toEqual({ text: 'All done.', reportedError: false, costUsd: 0.0421 });
  });

  test('reports an error the CLI flagged even when it printed a result', () => {
    const stdout = JSON.stringify({ type: 'result', is_error: true, result: 'Credit balance is too low' });

    expect(readClaudeOutput(stdout).reportedError).toBe(true);
  });

  test('finds the result entry when the CLI prints an array of messages', () => {
    const stdout = JSON.stringify([
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [] } },
      { type: 'result', result: 'Final answer.', total_cost_usd: 0.5 },
    ]);

    expect(readClaudeOutput(stdout)).toMatchObject({ text: 'Final answer.', costUsd: 0.5 });
  });

  test('tolerates surrounding whitespace and a missing cost', () => {
    const session = readClaudeOutput(`\n  ${JSON.stringify({ result: 'ok' })}\n`);

    expect(session).toEqual({ text: 'ok', reportedError: false, costUsd: undefined });
  });

  test.each([
    ['plain text', 'I could not find the repository.'],
    ['JSON without a result field', JSON.stringify({ type: 'error', message: 'nope' })],
    ['a result that is not a string', JSON.stringify({ result: { nested: true } })],
    ['an array with no result entry', JSON.stringify([{ type: 'system' }])],
    ['truncated JSON', '{"type":"result","result":"abc'],
  ])('treats %s as plain output', (_name, stdout) => {
    expect(readClaudeOutput(stdout)).toEqual(readPlainOutput(stdout));
  });
});

describe('findLastJsonObject', () => {
  test('returns the last fenced JSON block when there are several', () => {
    const text = `${fencedReply({ summary: 'first' })}\nMore work.\n${fencedReply({ summary: 'second' })}`;

    expect(findLastJsonObject(text)).toEqual({ summary: 'second' });
  });

  test('accepts a fence without a language tag', () => {
    const text = 'Result:\n```\n{"summary":"bare fence"}\n```';

    expect(findLastJsonObject(text)).toEqual({ summary: 'bare fence' });
  });

  test('skips a final fence that is not JSON and uses the one before it', () => {
    const text = `${fencedReply({ summary: 'real' })}\n\`\`\`bash\nnpm test\n\`\`\`\n`;

    expect(findLastJsonObject(text)).toEqual({ summary: 'real' });
  });

  test('finds a trailing object that is not fenced', () => {
    const text = `Finished. ${JSON.stringify(FINAL_BLOCK)}`;

    expect(findLastJsonObject(text)).toEqual(FINAL_BLOCK);
  });

  test('prefers the outermost trailing object over the objects nested in it', () => {
    const text = `Notes {not json} then ${JSON.stringify({ summary: 'outer', claims: [{ label: 'inner' }] })}`;

    expect(findLastJsonObject(text)).toEqual({ summary: 'outer', claims: [{ label: 'inner' }] });
  });

  test.each([
    ['text with no braces', 'nothing structured here'],
    ['an empty string', ''],
    ['unbalanced braces', 'function () { return 1;'],
    ['a fenced JSON array', '```json\n[1, 2, 3]\n```'],
  ])('returns undefined for %s', (_name, text) => {
    expect(findLastJsonObject(text)).toBeUndefined();
  });
});

describe('toStepResult', () => {
  test('returns the structured result when the session ended with a valid block', () => {
    const result = toStepResult({ text: fencedReply(FINAL_BLOCK), reportedError: false, costUsd: 0.12 }, END_OK);

    expect(result).toEqual({ ok: true, ...FINAL_BLOCK, costUsd: 0.12 });
  });

  test('leaves the cost out when the harness did not report one', () => {
    const result = toStepResult({ text: fencedReply(FINAL_BLOCK), reportedError: false }, END_OK);

    expect(result).not.toHaveProperty('costUsd');
  });

  test('takes ok from the exit code, not from what the session says', () => {
    const session = { text: fencedReply(FINAL_BLOCK), reportedError: false };

    expect(toStepResult(session, { ...END_OK, exitCode: 1 }).ok).toBe(false);
    expect(toStepResult(session, { ...END_OK, exitCode: null }).ok).toBe(false);
    expect(toStepResult({ ...session, reportedError: true }, END_OK).ok).toBe(false);
  });

  test('drops malformed artifacts and claims but keeps the valid ones', () => {
    const block = {
      summary: 'Mixed bag.',
      artifacts: [
        { kind: 'pr', label: 'Pull request', value: 'https://git.example/pull/1' },
        { kind: 'pr', label: '', value: 'missing label' },
        'not an object',
        { kind: 'branch', label: 'Branch', value: 'fix/cart-total' },
      ],
      claims: [
        { label: 'Good', detail: 'Specific.', ok: false },
        { label: 'No detail' },
        { label: 'Odd ok', detail: 'ok was a string', ok: 'yes' },
      ],
    };

    const result = toStepResult({ text: fencedReply(block), reportedError: false }, END_OK);

    expect(result.artifacts).toEqual([
      { kind: 'pr', label: 'Pull request', value: 'https://git.example/pull/1' },
      { kind: 'log', label: 'Branch', value: 'fix/cart-total' },
    ]);
    expect(result.claims).toEqual([
      { label: 'Good', detail: 'Specific.', ok: false },
      { label: 'Odd ok', detail: 'ok was a string', ok: null },
    ]);
  });

  test('accepts a block that omits artifacts and claims', () => {
    const result = toStepResult({ text: fencedReply({ summary: 'Just a summary.' }), reportedError: false }, END_OK);

    expect(result).toEqual({ ok: true, summary: 'Just a summary.', artifacts: [], claims: [] });
  });

  test('keeps at most twenty artifacts and clips an overlong summary', () => {
    const block = {
      summary: 'word '.repeat(2_000),
      artifacts: Array.from({ length: 50 }, (_, index) => ({ kind: 'log', label: `Log ${index}`, value: 'v' })),
    };

    const result = toStepResult({ text: fencedReply(block), reportedError: false }, END_OK);

    expect(result.artifacts).toHaveLength(20);
    expect(result.summary.length).toBeLessThanOrEqual(1_200);
    expect(result.summary.endsWith('…')).toBe(true);
  });

  test('falls back to a truncated plain summary when there is no JSON block', () => {
    const text = `I looked around.\n\n${'The repository is large. '.repeat(100)}`;

    const result = toStepResult({ text, reportedError: false }, END_OK);

    expect(result.ok).toBe(true);
    expect(result.summary.startsWith('I looked around. The repository is large.')).toBe(true);
    expect(result.summary).toHaveLength(600);
    expect(result.artifacts).toEqual([]);
    expect(result.claims).toEqual([]);
  });

  test('falls back when the last JSON object is not the block that was asked for', () => {
    const text = 'Here is the config I found:\n```json\n{"port": 4310}\n```';

    const result = toStepResult({ text, reportedError: false }, { ...END_OK, exitCode: 2 });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Here is the config I found');
  });

  test('explains an empty output using the exit code and the end of stderr', () => {
    const end = { label: 'Codex', exitCode: 3, stderr: 'warming up\nError: not logged in\n' };

    const result = toStepResult({ text: '  \n', reportedError: false }, end);

    expect(result).toEqual({
      ok: false,
      summary: 'The Codex session exited with code 3 and printed no result. Last error output: warming up Error: not logged in',
      artifacts: [],
      claims: [],
    });
  });

  test('says the session was killed when there is no exit code and no output', () => {
    const result = toStepResult({ text: '', reportedError: false }, { label: 'Claude', exitCode: null, stderr: '' });

    expect(result.summary).toBe('The Claude session was killed and printed no result.');
  });
});
