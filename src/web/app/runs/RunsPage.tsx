import type { Run, RunStatus } from '../../../shared/types';
import { api } from '../lib/api';
import { durationBetween, plural, useNow } from '../lib/format';
import { Link, RUN_STATUSES, runPath } from '../lib/router';
import { RUN_STATUS, isActiveRun } from '../lib/status';
import { EmptyState, ErrorState, LoadingState, StaleNotice, StatusTag, TimeAgo } from '../lib/ui';
import { useResource } from '../lib/useResource';
import { PageHeader } from '../shell/PageHeader';
import { MiniTrack } from './MiniTrack';
import './runs.css';

const RUNS_LIMIT = 100;
const NOW_TICK_MS = 5000;

interface Filter {
  status: RunStatus | null;
  label: string;
}

const FILTERS: readonly Filter[] = [
  { status: null, label: 'All' },
  ...RUN_STATUSES.map((status) => ({ status, label: RUN_STATUS[status].label })),
];

function filterPath(status: RunStatus | null): string {
  return status ? `/runs?status=${status}` : '/runs';
}

interface RunRowProps {
  run: Run;
  now: number;
}

function RunRow({ run, now }: RunRowProps) {
  const duration = durationBetween(run.startedAt, run.finishedAt, now);
  const active = isActiveRun(run.status);
  return (
    <li className="run-row" data-status={run.status}>
      <div className="run-row__status">
        <StatusTag view={RUN_STATUS[run.status]} live={run.status === 'running'} />
      </div>
      <div className="run-row__main">
        <Link to={runPath(run.id)} className="run-row__title">
          {run.title}
        </Link>
        <p className="run-row__meta">
          <span>{run.playbookName}</span>
          <span aria-hidden="true"> · </span>
          <span>
            {run.startedAt ? 'started ' : 'queued '}
            <TimeAgo iso={run.startedAt ?? run.createdAt} />
          </span>
          {duration && (
            <>
              <span aria-hidden="true"> · </span>
              <span>
                {active ? 'running for ' : 'took '}
                <span className="mono">{duration}</span>
              </span>
            </>
          )}
          {run.duplicateSignals > 0 && (
            <>
              <span aria-hidden="true"> · </span>
              <span>
                {run.duplicateSignals} duplicate {plural(run.duplicateSignals, 'signal', 'signals')} folded in
              </span>
            </>
          )}
        </p>
        {run.stopReason && <p className="run-row__reason">{run.stopReason}</p>}
      </div>
      <div className="run-row__track">
        <MiniTrack steps={run.steps} />
      </div>
    </li>
  );
}

export interface RunsPageProps {
  /** From the URL: /app/runs?status=failed */
  status: RunStatus | null;
}

export function RunsPage({ status }: RunsPageProps) {
  const runs = useResource(`runs:${status ?? 'all'}`, (signal) => api.runs({ status, limit: RUNS_LIMIT }, signal), {
    refreshOn: ['run.updated'],
  });
  const now = useNow(NOW_TICK_MS);
  const filterLabel = status ? RUN_STATUS[status].label.toLowerCase() : null;

  return (
    <div className="page page--runs">
      <PageHeader
        title="Runs"
        eyebrow="Every playbook run"
        lede="Newest first. Pick a run to see its track, its timeline and the evidence behind it."
      />

      <nav className="filters" aria-label="Filter runs by status">
        <ul>
          {FILTERS.map((filter) => (
            <li key={filter.status ?? 'all'}>
              <Link
                to={filterPath(filter.status)}
                className="filters__chip"
                aria-current={filter.status === status ? 'true' : undefined}
              >
                {filter.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <StaleNotice error={runs.data ? runs.error : null} onRetry={runs.reload} />
      {!runs.data && runs.loading && <LoadingState label="Loading runs…" />}
      {!runs.data && runs.error && (
        <ErrorState title="Runs could not be loaded" error={runs.error} onRetry={runs.reload} />
      )}

      {runs.data?.length === 0 && (
        <EmptyState title={filterLabel ? `No run is ${filterLabel}.` : 'No runs yet.'}>
          {filterLabel ? (
            <p>
              <Link to="/runs">Show all runs</Link>
            </p>
          ) : (
            <p>
              A run starts when a signal matches a watch. You can <Link to="/signals">send a test signal</Link> to
              see one.
            </p>
          )}
        </EmptyState>
      )}

      {runs.data && runs.data.length > 0 && (
        <ul className="run-list" aria-label={filterLabel ? `Runs that are ${filterLabel}` : 'All runs'}>
          {runs.data.map((run) => (
            <RunRow key={run.id} run={run} now={now} />
          ))}
        </ul>
      )}
    </div>
  );
}
