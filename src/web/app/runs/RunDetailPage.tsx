import { useState } from 'react';
import type { Operator, RunDetail, StreamEvent } from '../../../shared/types';
import { api, describeError, toApiError } from '../lib/api';
import { durationBetween, formatDateTime, formatFull, plural, useNow } from '../lib/format';
import { InlineText } from '../lib/inline';
import { Link } from '../lib/router';
import { RUN_STATUS, isActiveRun } from '../lib/status';
import { EmptyState, ErrorState, LoadingState, SectionHead, StaleNotice, StatusTag } from '../lib/ui';
import { useResource } from '../lib/useResource';
import { EvidenceGroups } from '../inbox/Evidence';
import { ConfirmDialog } from '../shell/ConfirmDialog';
import { PageHeader } from '../shell/PageHeader';
import { announce } from '../shell/announcer';
import { SignalPanel } from './SignalPanel';
import { StepTrack } from './StepTrack';
import { Timeline } from './Timeline';
import './runs.css';

const ACTIVE_TICK_MS = 1000;
const SETTLED_TICK_MS = 60_000;

function concerns(event: StreamEvent, runId: string): boolean {
  switch (event.type) {
    case 'run.updated':
      return event.run.id === runId;
    case 'timeline.appended':
      return event.event.runId === runId;
    case 'decision.opened':
    case 'decision.resolved':
      return event.decision.runId === runId;
    default:
      return false;
  }
}

interface RunFactsProps {
  detail: RunDetail;
  now: number;
}

function RunFacts({ detail, now }: RunFactsProps) {
  const { run } = detail;
  const duration = durationBetween(run.startedAt, run.finishedAt, now);
  return (
    <dl className="facts facts--run">
      <div>
        <dt>Status</dt>
        <dd>
          <StatusTag view={RUN_STATUS[run.status]} live={run.status === 'running'} />
        </dd>
      </div>
      <div>
        <dt>Playbook</dt>
        <dd>
          {run.playbookName} <span className="mono">v{run.playbookVersion}</span>
        </dd>
      </div>
      <div>
        <dt>Started</dt>
        <dd>
          {run.startedAt ? (
            <time dateTime={run.startedAt} title={formatFull(run.startedAt)}>
              {formatDateTime(run.startedAt)}
            </time>
          ) : (
            'Not started yet'
          )}
        </dd>
      </div>
      <div>
        <dt>{run.finishedAt ? 'Took' : 'Running for'}</dt>
        <dd className="mono">{duration ?? '—'}</dd>
      </div>
      {run.duplicateSignals > 0 && (
        <div>
          <dt>Folded in</dt>
          <dd>
            {run.duplicateSignals} duplicate {plural(run.duplicateSignals, 'signal', 'signals')}
          </dd>
        </div>
      )}
    </dl>
  );
}

export interface RunDetailPageProps {
  id: string;
}

export function RunDetailPage({ id }: RunDetailPageProps) {
  const detail = useResource(`run:${id}`, (signal) => api.run(id, signal), {
    refreshOn: ['run.updated', 'timeline.appended', 'decision.opened', 'decision.resolved'],
    when: (event) => concerns(event, id),
  });
  const operators = useResource('operators', (signal) => api.operators(signal));
  const [confirming, setConfirming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelProblem, setCancelProblem] = useState<string | null>(null);

  const run = detail.data?.run;
  const active = run ? isActiveRun(run.status) : false;
  const now = useNow(active ? ACTIVE_TICK_MS : SETTLED_TICK_MS);
  const operatorMap: ReadonlyMap<string, Operator> = new Map(
    (operators.data ?? []).map((operator) => [operator.id, operator]),
  );

  const handleCancel = async (): Promise<void> => {
    setCancelling(true);
    setCancelProblem(null);
    try {
      const cancelled = await api.cancelRun(id);
      detail.mutate((current) => ({ ...current, run: cancelled }));
      detail.reload();
      setConfirming(false);
      announce('The run was cancelled.');
    } catch (error) {
      setCancelProblem(describeError(toApiError(error)));
    } finally {
      setCancelling(false);
    }
  };

  const closeConfirm = (): void => {
    setConfirming(false);
    setCancelProblem(null);
  };

  const eyebrow = (
    <>
      <Link to="/runs">Runs</Link>
      <span aria-hidden="true"> / </span>
      <span className="mono">{id}</span>
    </>
  );

  if (!detail.data) {
    const missing = detail.error?.code === 'not_found';
    return (
      <div className="page page--run">
        <PageHeader title={missing ? 'Run not found' : 'Run'} eyebrow={eyebrow} />
        {detail.loading && <LoadingState label="Loading the run…" />}
        {detail.error && missing && (
          <EmptyState title="There is no run with this id.">
            <p>
              It may have been removed, or the link is incomplete. <Link to="/runs">See all runs</Link>
            </p>
          </EmptyState>
        )}
        {detail.error && !missing && (
          <ErrorState title="This run could not be loaded" error={detail.error} onRetry={detail.reload} />
        )}
      </div>
    );
  }

  const { signal, timeline, evidence, decision } = detail.data;
  const currentRun = detail.data.run;
  const openDecision = decision?.status === 'open' ? decision : null;

  return (
    <div className="page page--run">
      <PageHeader
        title={currentRun.title}
        eyebrow={eyebrow}
        actions={
          active && (
            <button type="button" className="btn btn--reject" onClick={() => setConfirming(true)}>
              Cancel run
            </button>
          )
        }
      />

      <StaleNotice error={detail.error} onRetry={detail.reload} />
      <RunFacts detail={detail.data} now={now} />

      {currentRun.stopReason && (
        <p className="notice notice--stop run-reason">
          <strong>Why it stopped.</strong> <InlineText text={currentRun.stopReason} />
        </p>
      )}
      {openDecision && (
        <p className="notice notice--caution run-reason">
          <strong>Stopped at a gate.</strong> “<InlineText text={openDecision.question} />” <Link to="/">Answer it in the Inbox</Link>
        </p>
      )}

      <div className="run-layout">
        <section className="run-layout__steps" aria-labelledby="steps-title">
          <SectionHead id="steps-title" title="Steps" count={currentRun.steps.length} />
          <StepTrack
            steps={currentRun.steps}
            currentStepId={currentRun.currentStepId}
            operators={operatorMap}
            now={now}
          />
        </section>

        <section className="run-layout__timeline" aria-labelledby="timeline-title">
          <SectionHead id="timeline-title" title="Timeline" count={timeline.length} />
          {timeline.length === 0 ? (
            <p className="quiet-line">Nothing has been written to the ledger for this run yet.</p>
          ) : (
            <Timeline events={timeline} operators={operatorMap} />
          )}
        </section>

        <section className="run-layout__evidence" aria-labelledby="evidence-title">
          <SectionHead id="evidence-title" title="Evidence" count={evidence.length} />
          <EvidenceGroups evidence={evidence} />
        </section>

        <section className="run-layout__signal" aria-labelledby="signal-title">
          <SectionHead id="signal-title" title="Originating signal" />
          <SignalPanel signal={signal} />
        </section>
      </div>

      <ConfirmDialog
        open={confirming}
        title="Cancel this run?"
        confirmLabel="Cancel the run"
        cancelLabel="Keep it running"
        busy={cancelling}
        problem={cancelProblem}
        onConfirm={() => void handleCancel()}
        onCancel={closeConfirm}
      >
        <p>
          “{currentRun.title}” stops where it is. Steps that already finished stay finished, and a cancelled run
          cannot be resumed.
        </p>
      </ConfirmDialog>
    </div>
  );
}
