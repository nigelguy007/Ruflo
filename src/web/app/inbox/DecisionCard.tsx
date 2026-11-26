import { useEffect, useId, useRef } from 'react';
import type { FormEvent } from 'react';
import type { Decision, Verdict } from '../../../shared/types';
import { InlineText } from '../lib/inline';
import { Link, runPath } from '../lib/router';
import { Lamp, TimeAgo } from '../lib/ui';
import { CheckIcon, CrossIcon } from '../shell/icons';
import { EvidenceGroups } from './Evidence';

const NOTE_MAX_LENGTH = 2000;

export interface DecisionCardProps {
  decision: Decision;
  note: string;
  onNoteChange: (note: string) => void;
  /** The verdict being sent right now, if any. Both buttons are disabled while set. */
  submitting: Verdict | null;
  /** Why the last attempt failed. Set when the card has been rolled back into the Inbox. */
  problem: string | null;
  onDecide: (verdict: Verdict) => void;
}

/**
 * The switch point. Everything else in the console exists so that this card
 * can be short: one question, who stands behind each piece of evidence, and
 * two routes out.
 */
export function DecisionCard({ decision, note, onNoteChange, submitting, problem, onDecide }: DecisionCardProps) {
  const questionId = useId();
  const noteId = useId();
  const problemRef = useRef<HTMLParagraphElement>(null);
  const busy = submitting !== null;

  useEffect(() => {
    if (problem) problemRef.current?.focus();
  }, [problem]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => event.preventDefault();

  return (
    <article className="decision" aria-labelledby={questionId} data-leaving={submitting ?? undefined}>
      <header className="decision__head">
        <p className="decision__flag">
          <Lamp state="caution" live />
          Waiting on you
        </p>
        <p className="decision__meta">
          Asked <TimeAgo iso={decision.openedAt} /> at gate <span className="mono">{decision.stepId}</span>
        </p>
      </header>

      <div className="decision__ask">
        <h2 id={questionId} className="decision__question">
          <InlineText text={decision.question} />
        </h2>
        <p className="decision__run">
          <span className="eyebrow">Run</span>
          <Link to={runPath(decision.runId)}>{decision.runTitle}</Link>
        </p>
      </div>

      <div className="decision__evidence">
        <p className="eyebrow">What you are deciding on</p>
        <EvidenceGroups evidence={decision.evidence} />
      </div>

      <form className="decision__answer" onSubmit={handleSubmit}>
        {problem && (
          <p ref={problemRef} className="notice notice--stop" role="alert" tabIndex={-1}>
            <strong>Your answer was not recorded.</strong> {problem} Nothing has changed; you can try again.
          </p>
        )}
        <div className="field">
          <label className="field__label" htmlFor={noteId}>
            Note <span className="field__optional">optional, goes on the run's timeline</span>
          </label>
          <textarea
            id={noteId}
            className="input"
            rows={2}
            maxLength={NOTE_MAX_LENGTH}
            value={note}
            disabled={busy}
            onChange={(event) => onNoteChange(event.target.value)}
          />
        </div>

        <div className="points">
          <svg className="points__diagram" viewBox="0 0 96 108" preserveAspectRatio="none" aria-hidden="true" focusable="false">
            <path className="points__ties" d="M8 19v10M16 19v10M24 19v10" />
            <path className="points__route points__route--reject" d="M34 24C58 24 50 84 74 84H96" />
            <path className="points__route points__route--approve" d="M0 24H96" />
            <path className="points__blade" d="M34 17.5 40.5 24 34 30.5 27.5 24Z" />
          </svg>
          <button
            type="button"
            className="btn btn--primary btn--large points__approve"
            disabled={busy}
            onClick={() => onDecide('approve')}
          >
            <CheckIcon />
            {submitting === 'approve' ? 'Approving…' : 'Approve'}
          </button>
          <button
            type="button"
            className="btn btn--reject btn--large points__reject"
            disabled={busy}
            onClick={() => onDecide('reject')}
          >
            <CrossIcon />
            {submitting === 'reject' ? 'Rejecting…' : 'Reject'}
          </button>
        </div>
      </form>
    </article>
  );
}
