import type { Run } from '../../../shared/types';
import { Link, runPath } from '../lib/router';
import { RUN_STATUS } from '../lib/status';
import { StatusTag, TimeAgo } from '../lib/ui';

export interface StoppedRunsProps {
  runs: Run[];
}

/** Runs that ended badly in the last day, each with the reason in plain words. */
export function StoppedRuns({ runs }: StoppedRunsProps) {
  return (
    <ul className="stopped">
      {runs.map((run) => (
        <li key={run.id} className="stopped__item">
          <StatusTag view={RUN_STATUS[run.status]} size="sm" />
          <div className="stopped__body">
            <Link to={runPath(run.id)} className="stopped__title">
              {run.title}
            </Link>
            <p className="stopped__reason">{run.stopReason ?? 'No reason was recorded.'}</p>
          </div>
          <p className="stopped__meta">
            {run.playbookName}
            <span aria-hidden="true"> · </span>
            <TimeAgo iso={run.finishedAt} />
          </p>
        </li>
      ))}
    </ul>
  );
}
