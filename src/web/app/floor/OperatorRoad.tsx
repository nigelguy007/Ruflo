import type { Operator, Run } from '../../../shared/types';
import { InlineText } from '../lib/inline';
import { Link, runPath } from '../lib/router';
import { OPERATOR_STATUS } from '../lib/status';
import { StatusTag } from '../lib/ui';

export interface OperatorRoadProps {
  operator: Operator;
  /** The run this operator is on, when we know it. */
  run: Run | undefined;
}

function idleLine(operator: Operator): string {
  if (operator.status === 'paused') return 'Held. Everything is paused.';
  return 'Standing by for the next handoff.';
}

/**
 * One operator, drawn as a road in the yard: who they are on the left, and on
 * the track itself whatever they are moving right now.
 */
export function OperatorRoad({ operator, run }: OperatorRoadProps) {
  const view = OPERATOR_STATUS[operator.status];
  const occupied = operator.currentRunId !== null;

  return (
    <li className="road" data-status={operator.status}>
      <div className="road__who">
        <h3 className="road__name">{operator.name}</h3>
        <p className="road__handle mono">{operator.handle}</p>
      </div>
      <p className="road__role">{operator.role}</p>
      <p className="road__state">
        <StatusTag view={view} live={operator.status === 'working'} />
        <span className="road__harness">
          <span className="visually-hidden">Harness: </span>
          <span className="mono">{operator.harness}</span>
        </span>
      </p>

      <div className="road__track" data-occupied={occupied || undefined}>
        {occupied ? (
          <p className="road__load">
            <span className="eyebrow">Now</span>
            <span className="road__activity">
              <InlineText text={operator.currentActivity ?? 'Working on a run.'} />
            </span>
            {operator.currentRunId && (
              <Link to={runPath(operator.currentRunId)} className="road__run">
                {run?.title ?? `Run ${operator.currentRunId}`}
              </Link>
            )}
          </p>
        ) : (
          <p className="road__empty">
            <InlineText text={operator.currentActivity ?? idleLine(operator)} />
          </p>
        )}
      </div>
    </li>
  );
}
