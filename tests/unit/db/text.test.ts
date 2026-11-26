import { afterEach, describe, expect, test } from 'vitest';
import { createStore } from '../../../src/server/db/index.js';
import type { Store } from '../../../src/server/db/index.js';
import { isStorableText, storableText, storableTextOrNull } from '../../../src/server/db/text.js';
import { START } from '../engine/support.js';
import { evidence, newRun, openDecision, storedSignal, storeWithSignals, timelineEvent } from './fixtures.js';

let store: Store | null = null;

afterEach(() => {
  store?.close();
  store = null;
});

/** The platform's own rule, for comparison: lone surrogates become U+FFFD. */
function nativeWellFormed(value: string): string {
  return (value as string & { toWellFormed(): string }).toWellFormed();
}

describe('storableText', () => {
  test('leaves ordinary text, accents, CJK and complete emoji exactly as they are', () => {
    const text = 'Checkout fails 😀 für Kunden – 日本語 👨‍👩‍👧';

    expect(storableText(text)).toBe(text);
    expect(isStorableText(text)).toBe(true);
  });

  test('replaces a lone high surrogate, a lone low surrogate and a reversed pair', () => {
    expect(storableText('a\ud83db')).toBe('a�b');
    expect(storableText('a\ude00b')).toBe('a�b');
    expect(storableText('\ude00\ud83d')).toBe('��');
    expect(storableText('end\ud83d')).toBe('end�');
    expect(storableText('\ude00start')).toBe('�start');
  });

  test('keeps a valid pair next to a lone surrogate', () => {
    expect(storableText('\ud83d😀')).toBe('�😀');
    expect(storableText('😀\ude00')).toBe('😀�');
  });

  test('replaces NUL, which SQLite would read back as the end of the text', () => {
    expect(storableText('a\0b\0')).toBe('a�b�');
    expect(isStorableText('a\0b')).toBe(false);
  });

  test('agrees with the platform on every combination of up to three code units', () => {
    const units = ['a', '\0', '\ud83d', '\ude00', '\ud800', '\udfff'];
    for (const first of units) {
      for (const second of units) {
        for (const third of units) {
          const text = `${first}${second}${third}`;
          expect(storableText(text), JSON.stringify(text)).toBe(nativeWellFormed(text.replaceAll('\0', '�')));
        }
      }
    }
  });

  test('passes null through the nullable form', () => {
    expect(storableTextOrNull(null)).toBeNull();
    expect(storableTextOrNull('x\0')).toBe('x�');
  });
});

describe('what the repositories hand back is what the database holds', () => {
  function open(...runIds: string[]): Store {
    store = storeWithSignals(...runIds);
    for (const id of runIds) store.runs.insert(newRun(id));
    return store;
  }

  test('signals', () => {
    const s = open();

    const returned = s.signals.insert(
      storedSignal('odd', { kind: 'k\0ind', title: 'T\ud83d', fingerprint: 'f\ude00p', url: 'https://x/\0' }),
    );

    expect(returned).toMatchObject({ kind: 'k�ind', title: 'T�', fingerprint: 'f�p', url: 'https://x/�' });
    expect(s.signals.get('odd')).toEqual(returned);
  });

  test('evidence', () => {
    const s = open('r1');

    const returned = s.evidence.insert({ ...evidence('e1', 'r1'), label: 'L\ud83d', detail: 'D\0D' });

    expect(returned).toMatchObject({ label: 'L�', detail: 'D�D' });
    expect(s.evidence.forRun('r1')[0]).toEqual(returned);
  });

  test('decisions, when opened and when answered', () => {
    const s = open('r1');

    const opened = s.decisions.insert(openDecision('d1', 'r1', { question: 'Q\ud83d?', runTitle: 'R\0' }));
    const answered = s.decisions.resolve('d1', {
      status: 'approved',
      decidedAt: START,
      decidedBy: 'dana\ud83d',
      note: 'ok\0',
    });

    expect(opened).toMatchObject({ question: 'Q�?', runTitle: 'R�' });
    expect(s.decisions.get('d1')?.question).toBe('Q�?');
    expect(answered).toMatchObject({ decidedBy: 'dana�', note: 'ok�' });
  });

  test('a decision with no note and no answerer stays null', () => {
    const s = open('r1');

    expect(s.decisions.insert(openDecision('d1', 'r1'))).toMatchObject({ note: null, decidedBy: null });
    expect(s.decisions.resolve('d1', { status: 'rejected', decidedAt: START, decidedBy: 'x', note: null })?.note).toBeNull();
  });

  test('runs: title, step titles, stop reason and step summary', () => {
    const s = storeWithSignals('r1');
    const playbook = { ...newRun('r1').playbook, steps: [{ ...newRun('r1').playbook.steps[0]!, title: 'Look\ud83d' }] };

    const run = s.runs.insert(newRun('r1', { title: 'Run\0', playbook }));
    s.runs.update('r1', { stopReason: 'because \ud83d' });
    s.runs.updateStep('r1', 'look', { summary: 'did \0 it' });
    store = s;

    expect(run.title).toBe('Run�');
    expect(run.steps[0]?.title).toBe('Look�');
    expect(s.runs.require('r1').stopReason).toBe('because �');
    expect(s.runs.require('r1').steps[0]?.summary).toBe('did � it');
  });

  test('runs: a null stop reason and a null summary stay null', () => {
    const s = open('r1');

    s.runs.update('r1', { stopReason: null });
    s.runs.updateStep('r1', 'look', { summary: null });

    expect(s.runs.require('r1').stopReason).toBeNull();
    expect(s.runs.require('r1').steps[0]?.summary).toBeNull();
  });
});

describe('the timeline refuses text the hash could not survive', () => {
  test.each([
    ['text', { text: 'a\ud83d' }],
    ['text', { text: 'a\0b' }],
    ['actor', { actor: 'x\ude00' }],
    ['run id', { runId: 'r\0' }],
  ])('a ledger %s that SQLite would change', (_name, change) => {
    store = storeWithSignals();

    expect(() => store?.timeline.insert(timelineEvent(1, 'a', change))).toThrow(/storable as given/);
    expect(store.timeline.count()).toBe(0);
  });
});
