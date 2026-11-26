import type { StepRun } from '../../../shared/types';
import { STEP_STATUS } from '../lib/status';
import { StepGlyph } from './StepGlyph';

const GLYPH_SIZE = 13;

export interface MiniTrackProps {
  steps: StepRun[];
}

function describe(steps: StepRun[]): string {
  const done = steps.filter((step) => step.status === 'succeeded' || step.status === 'skipped').length;
  const current = steps.find((step) => ['running', 'waiting', 'failed'].includes(step.status));
  const progress = `${done} of ${steps.length} steps done`;
  return current ? `${progress}. ${current.title}: ${STEP_STATUS[current.status].label}.` : `${progress}.`;
}

/** A run's whole track on one line: one small shape per step, joined by a hairline. */
export function MiniTrack({ steps }: MiniTrackProps) {
  if (steps.length === 0) return null;
  return (
    <span className="mini-track" role="img" aria-label={describe(steps)}>
      {steps.map((step) => (
        <StepGlyph key={step.stepId} kind={step.kind} status={step.status} size={GLYPH_SIZE} bare />
      ))}
    </span>
  );
}
