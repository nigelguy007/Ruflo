import type { Operator, Step } from '../../../shared/types';
import { InlineText } from '../lib/inline';
import { STEP_KIND_LABEL } from '../lib/status';
import { StepGlyph } from '../runs/StepGlyph';

export interface PlaybookTrackProps {
  steps: Step[];
  operators: ReadonlyMap<string, Operator>;
}

function handleOf(id: string, operators: ReadonlyMap<string, Operator>): string {
  return operators.get(id)?.handle ?? `@${id}`;
}

interface StepNotesProps {
  step: Step;
  operators: ReadonlyMap<string, Operator>;
}

function StepNotes({ step, operators }: StepNotesProps) {
  if (step.kind === 'agent') {
    return (
      <>
        <p className="track__summary">
          <InlineText text={step.instruction} />
        </p>
        {(step.handoffTo || step.retries) && (
          <p className="track__status">
            {step.handoffTo && (
              <span>
                Hands off to <span className="mono">{handleOf(step.handoffTo, operators)}</span>
              </span>
            )}
            {step.handoffTo && step.retries ? <span aria-hidden="true"> · </span> : null}
            {step.retries ? <span>up to {step.retries + 1} attempts</span> : null}
          </p>
        )}
      </>
    );
  }
  if (step.kind === 'command') {
    return (
      <p className="track__command">
        <code className="mono">{step.run.join(' ')}</code>
        {step.expectExit !== undefined && <span> must exit {step.expectExit}</span>}
      </p>
    );
  }
  return (
    <>
      <p className="track__question">“{step.question}”</p>
      <p className="track__status">
        The run waits here for a person. If the answer is no, the run{' '}
        {step.onReject === 'stop' ? 'stops' : 'carries on without this step'}.
      </p>
    </>
  );
}

/** A playbook's steps as a length of track: the plan, before any run has travelled it. */
export function PlaybookTrack({ steps, operators }: PlaybookTrackProps) {
  return (
    <ol className="track track--plan">
      {steps.map((step) => (
        <li key={step.id} className="track__step" data-status="plan" data-kind={step.kind}>
          <span className="track__node">
            <StepGlyph kind={step.kind} status="plan" size={22} />
          </span>
          <div className="track__body">
            <p className="track__kind">
              {STEP_KIND_LABEL[step.kind]}
              {step.kind === 'agent' && (
                <>
                  <span aria-hidden="true"> · </span>
                  <span className="mono">{handleOf(step.operator, operators)}</span>
                </>
              )}
            </p>
            <p className="track__title">{step.title}</p>
            <StepNotes step={step} operators={operators} />
          </div>
        </li>
      ))}
    </ol>
  );
}
