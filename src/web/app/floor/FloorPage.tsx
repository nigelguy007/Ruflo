import type { Operator, Run } from '../../../shared/types';
import { api } from '../lib/api';
import { plural } from '../lib/format';
import { Link, runPath } from '../lib/router';
import { ACTIVE_RUN_STATUSES, RUN_STATUS } from '../lib/status';
import { EmptyState, ErrorState, LoadingState, SectionHead, StaleNotice, StatusTag, TimeAgo } from '../lib/ui';
import { useResource } from '../lib/useResource';
import { MiniTrack } from '../runs/MiniTrack';
import { PageHeader } from '../shell/PageHeader';
import { OperatorRoad } from './OperatorRoad';
import './floor.css';

const RUNS_LIMIT = 100;

function summarise(operators: Operator[]): string {
  const working = operators.filter((operator) => operator.status === 'working').length;
  const waiting = operators.filter((operator) => operator.status === 'waiting').length;
  const resting = operators.length - working - waiting;
  return `${working} working, ${waiting} waiting on a person, ${resting} standing by.`;
}

function currentStepTitle(run: Run): string | null {
  return run.steps.find((step) => step.stepId === run.currentStepId)?.title ?? null;
}

interface ActiveRunsProps {
  runs: Run[];
}

function ActiveRuns({ runs }: ActiveRunsProps) {
  if (runs.length === 0) {
    return (
      <EmptyState title="No run is moving.">
        <p>The yard is quiet. Runs appear here as soon as a signal starts one.</p>
      </EmptyState>
    );
  }
  return (
    <ul className="active-runs">
      {runs.map((run) => {
        const step = currentStepTitle(run);
        return (
          <li key={run.id} className="active-run">
            <StatusTag view={RUN_STATUS[run.status]} live={run.status === 'running'} size="sm" />
            <Link to={runPath(run.id)} className="active-run__title">
              {run.title}
            </Link>
            <MiniTrack steps={run.steps} />
            <p className="active-run__meta">
              {step ? <span>At: {step}</span> : <span>Not started yet</span>}
              <span aria-hidden="true"> · </span>
              <span>
                started <TimeAgo iso={run.startedAt ?? run.createdAt} />
              </span>
            </p>
          </li>
        );
      })}
    </ul>
  );
}

export function FloorPage() {
  const operators = useResource('operators', (signal) => api.operators(signal), {
    refreshOn: ['run.updated', 'decision.opened', 'decision.resolved', 'settings.updated'],
  });
  const runs = useResource('runs:floor', (signal) => api.runs({ limit: RUNS_LIMIT }, signal), {
    refreshOn: ['run.updated'],
  });

  const runById = new Map((runs.data ?? []).map((run) => [run.id, run]));
  const active = (runs.data ?? []).filter((run) => ACTIVE_RUN_STATUSES.includes(run.status));
  const lede = operators.data ? summarise(operators.data) : 'Who is doing what, right now.';

  return (
    <div className="page page--floor">
      <PageHeader title="Floor" eyebrow="Operators" lede={lede} />

      <div className="floor">
        <section className="floor__operators" aria-labelledby="operators-title">
          <SectionHead id="operators-title" title="Operators" count={operators.data?.length} />
          <StaleNotice error={operators.data ? operators.error : null} onRetry={operators.reload} />
          {!operators.data && operators.loading && <LoadingState label="Loading operators…" />}
          {!operators.data && operators.error && (
            <ErrorState title="Operators could not be loaded" error={operators.error} onRetry={operators.reload} />
          )}
          {operators.data?.length === 0 && (
            <EmptyState title="No operators are defined.">
              <p>
                Add them to <span className="mono">config/operators.json</span> and restart the server.
              </p>
            </EmptyState>
          )}
          {operators.data && operators.data.length > 0 && (
            <ul className="roads">
              {operators.data.map((operator) => (
                <OperatorRoad
                  key={operator.id}
                  operator={operator}
                  run={operator.currentRunId ? runById.get(operator.currentRunId) : undefined}
                />
              ))}
            </ul>
          )}
        </section>

        <section className="floor__runs" aria-labelledby="active-title">
          <SectionHead
            id="active-title"
            title={`Active ${plural(active.length, 'run', 'runs')}`}
            count={runs.data ? active.length : undefined}
          />
          <StaleNotice error={runs.data ? runs.error : null} onRetry={runs.reload} />
          {!runs.data && runs.loading && <LoadingState label="Loading active runs…" />}
          {!runs.data && runs.error && (
            <ErrorState title="Runs could not be loaded" error={runs.error} onRetry={runs.reload} />
          )}
          {runs.data && <ActiveRuns runs={active} />}
        </section>
      </div>
    </div>
  );
}
