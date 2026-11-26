import type { Operator, StepRun } from '../../../shared/types';
import { durationBetween } from '../lib/format';
import { STEP_KIND_LABEL, STEP_STATUS } from '../lib/status';
import { StepGlyph } from './StepGlyph';

export interface StepTrackProps {
  steps: StepRun[];
  currentStepId: string | null;
  operators: ReadonlyMap<string, Operator>;
  now: number;
}

function whoRuns(step: StepRun, operators: ReadonlyMap<string, Operator>): string {
  if (step.kind === 'command') return 'run by the engine';
  if (step.kind === 'gate') return 'a person decides';
  if (!step.operator) return 'unassigned';
  return operators.get(step.operator)?.handle ?? `@${step.operator}`;
}

/**
 * The run as a vertical length of track. Shape says what kind of step it is,
 * the mark inside says how it went, and the status is always spelled out.
 */
export function StepTrack({ steps, currentStepId, operators, now }: StepTrackProps) {
  return (
    <ol className="track">
      {steps.map((step) => {
        const status = STEP_STATUS[step.status];
        const duration = durationBetween(step.startedAt, step.finishedAt, now);
        const isCurrent = step.stepId === currentStepId;
        return (
          <li
            key={step.stepId}
            className="track__step"
            data-status={step.status}
            data-kind={step.kind}
            aria-current={isCurrent ? 'step' : undefined}
          >
            <span className="track__node">
              <StepGlyph kind={step.kind} status={step.status} size={26} />
            </span>
            <div className="track__body">
              <p className="track__kind">
                {STEP_KIND_LABEL[step.kind]}
                <span aria-hidden="true"> · </span>
                <span className={step.kind === 'agent' ? 'mono' : undefined}>{whoRuns(step, operators)}</span>
              </p>
              <h3 className="track__title">{step.title}</h3>
              <p className="track__status">
                <span className="track__status-word">{status.label}</span>
                {duration && step.status !== 'pending' && (
                  <>
                    <span aria-hidden="true"> · </span>
                    <span className="mono">{duration}</span>
                  </>
                )}
                {step.attempt > 1 && (
                  <>
                    <span aria-hidden="true"> · </span>
                    <span>attempt {step.attempt}</span>
                  </>
                )}
              </p>
              {step.summary && <p className="track__summary">{step.summary}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
