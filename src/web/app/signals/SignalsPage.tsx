import type { Run, Signal } from '../../../shared/types';
import { api } from '../lib/api';
import { Link, runPath } from '../lib/router';
import { SEVERITY, SOURCE_LABEL } from '../lib/status';
import { EmptyState, ErrorState, ExternalLink, LoadingState, SectionHead, StaleNotice, StatusTag, TimeAgo } from '../lib/ui';
import { useResource } from '../lib/useResource';
import { PageHeader } from '../shell/PageHeader';
import { TestSignalForm } from './TestSignalForm';
import './signals.css';

const SIGNALS_LIMIT = 50;
const RUNS_LIMIT = 200;

interface SignalRowProps {
  signal: Signal;
  run: Run | undefined;
}

function SignalRow({ signal, run }: SignalRowProps) {
  return (
    <li className="signal-row" data-source={signal.source}>
      <p className="signal-row__source">
        <span className="signal-row__source-name">{SOURCE_LABEL[signal.source]}</span>
        <span className="mono">{signal.kind}</span>
      </p>
      <div className="signal-row__main">
        <p className="signal-row__title">{signal.title}</p>
        <p className="signal-row__meta">
          <StatusTag view={SEVERITY[signal.severity]} size="sm" />
          <span>
            received <TimeAgo iso={signal.receivedAt} />
          </span>
          {signal.url && <ExternalLink url={signal.url}>Source</ExternalLink>}
        </p>
      </div>
      <p className="signal-row__run">
        {run ? <Link to={runPath(run.id)}>Open its run</Link> : <span className="signal-row__norun">No run of its own</span>}
      </p>
    </li>
  );
}

export function SignalsPage() {
  const signals = useResource('signals', (signal) => api.signals(SIGNALS_LIMIT, signal), {
    refreshOn: ['signal.received'],
  });
  const runs = useResource('runs:signals', (signal) => api.runs({ limit: RUNS_LIMIT }, signal), {
    refreshOn: ['run.updated'],
  });
  const playbooks = useResource('playbooks', (signal) => api.playbooks(signal));

  const runBySignal = new Map((runs.data ?? []).map((run) => [run.signalId, run]));

  return (
    <div className="page page--signals">
      <PageHeader
        title="Signals"
        eyebrow="What came in"
        lede="Every inbound event, normalised. A signal that matches an enabled watch starts a run."
      />

      <div className="signals">
        <aside className="signals__form">
          <TestSignalForm playbooks={playbooks.data} />
        </aside>

        <section className="signals__list" aria-labelledby="recent-signals-title">
          <SectionHead id="recent-signals-title" title="Recent signals" count={signals.data?.length} />
          <StaleNotice error={signals.data ? signals.error : null} onRetry={signals.reload} />
          {!signals.data && signals.loading && <LoadingState label="Loading signals…" />}
          {!signals.data && signals.error && (
            <ErrorState title="Signals could not be loaded" error={signals.error} onRetry={signals.reload} />
          )}
          {signals.data?.length === 0 && (
            <EmptyState title="No signal has arrived yet.">
              <p>Point a Sentry or GitHub webhook at this server, or send a test signal from this page.</p>
            </EmptyState>
          )}
          {signals.data && signals.data.length > 0 && (
            <ul className="signal-list">
              {signals.data.map((signal) => (
                <SignalRow key={signal.id} signal={signal} run={runBySignal.get(signal.id)} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
