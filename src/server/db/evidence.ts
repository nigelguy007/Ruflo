import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Evidence, EvidenceKind, Id } from '../../shared/types.js';
import { boolOrNull, oneOf, text, toFlag } from './rows.js';
import type { Row } from './rows.js';
import { storableText } from './text.js';

const KINDS: readonly EvidenceKind[] = ['verified', 'claimed', 'simulated'];

/** Shape of evidence when it is stored as JSON inside a decision. */
export const evidenceSchema: z.ZodType<Evidence> = z.object({
  id: z.string(),
  runId: z.string(),
  stepId: z.string(),
  kind: z.enum(['verified', 'claimed', 'simulated']),
  label: z.string(),
  detail: z.string(),
  ok: z.boolean().nullable(),
});

export interface EvidenceRepository {
  /** Returns the evidence as stored: free text with anything SQLite cannot keep replaced by U+FFFD. */
  insert(evidence: Evidence): Evidence;
  /** In the order it was gathered. */
  forRun(runId: Id): Evidence[];
}

function toEvidence(row: Row): Evidence {
  return {
    id: text(row, 'id'),
    runId: text(row, 'run_id'),
    stepId: text(row, 'step_id'),
    kind: oneOf(row, 'kind', KINDS),
    label: text(row, 'label'),
    detail: text(row, 'detail'),
    ok: boolOrNull(row, 'ok'),
  };
}

export function createEvidenceRepository(db: DatabaseSync): EvidenceRepository {
  const insert = db.prepare(
    'INSERT INTO evidence (id, run_id, step_id, kind, label, detail, ok) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const byRun = db.prepare('SELECT * FROM evidence WHERE run_id = ? ORDER BY seq');

  return {
    insert(input) {
      const evidence: Evidence = {
        ...input,
        label: storableText(input.label),
        detail: storableText(input.detail),
      };
      insert.run(
        evidence.id,
        evidence.runId,
        evidence.stepId,
        evidence.kind,
        evidence.label,
        evidence.detail,
        toFlag(evidence.ok),
      );
      return evidence;
    },
    forRun(runId) {
      return byRun.all(runId).map(toEvidence);
    },
  };
}
