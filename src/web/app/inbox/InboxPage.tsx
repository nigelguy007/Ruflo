import { useEffect, useRef, useState } from 'react';
import type { Decision, Verdict } from '../../../shared/types';
import { api, describeError, toApiError } from '../lib/api';
import { DAY_MS, isWithin, plural, useNow } from '../lib/format';
import { Link, runPath } from '../lib/router';
import { STOPPED_RUN_STATUSES } from '../lib/status';
import { ErrorState, LoadingState, SectionHead, StaleNotice } from '../lib/ui';
import { useResource } from '../lib/useResource';
import { PageHeader } from '../shell/PageHeader';
import { useShell } from '../shell/ShellContext';
import { announce } from '../shell/announcer';
import { AllClear, DigestFigures } from './AllClear';
import { DecisionCard } from './DecisionCard';
import { StoppedRuns } from './StoppedRuns';
import './inbox.css';

const RECENT_RUNS_LIMIT = 100;
const MAX_RECEIPTS = 4;
const NOW_TICK_MS = 60_000;
/** How long an answered card takes to leave. Its buttons are disabled for all of it. */
const LEAVE_MS = 220;

interface Receipt {
  decisionId: string;
  question: string;
  runId: string;
  verdict: Verdict;
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

function verdictWord(verdict: Verdict, done: boolean): string {
  if (verdict === 'approve') return done ? 'Approved' : 'Approving';
  return done ? 'Rejected' : 'Rejecting';
}

export function InboxPage() {
  const { overview } = useShell();
  const decisions = useResource('decisions:open', (signal) => api.decisions('open', signal), {
    refreshOn: ['decision.opened', 'decision.resolved'],
  });
  const runs = useResource('runs:recent', (signal) => api.runs({ limit: RECENT_RUNS_LIMIT }, signal), {
    refreshOn: ['run.updated'],
  });
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [sending, setSending] = useState<Record<string, Verdict>>({});
  const [departed, setDeparted] = useState<ReadonlySet<string>>(new Set());
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [departures, setDepartures] = useState(0);
  const receiptsRef = useRef<HTMLDivElement>(null);
  const leaveTimers = useRef(new Map<string, number>());
  const now = useNow(NOW_TICK_MS);

  // The card that held focus is gone; move focus to the line that says what happened.
  useEffect(() => {
    if (departures > 0) receiptsRef.current?.focus();
  }, [departures]);

  useEffect(() => {
    const timers = leaveTimers.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
    };
  }, []);

  const open = (decisions.data ?? []).filter((decision) => decision.status === 'open');
  const visible = open.filter((decision) => !departed.has(decision.id));
  const inFlight = open.filter((decision) => departed.has(decision.id) && decision.id in sending);

  const bringBack = (decisionId: string): void => {
    const timer = leaveTimers.current.get(decisionId);
    if (timer !== undefined) window.clearTimeout(timer);
    leaveTimers.current.delete(decisionId);
    setDeparted((previous) => new Set([...previous].filter((id) => id !== decisionId)));
  };

  const handleDecide = async (decision: Decision, verdict: Verdict): Promise<void> => {
    if (decision.id in sending) return;
    const note = (notes[decision.id] ?? '').trim();
    // Optimistic: the buttons lock at once, the card leaves without waiting for the
    // server, and it comes back only if the server says no.
    setSending((previous) => ({ ...previous, [decision.id]: verdict }));
    setProblems((previous) => without(previous, decision.id));
    leaveTimers.current.set(
      decision.id,
      window.setTimeout(() => {
        leaveTimers.current.delete(decision.id);
        setDeparted((previous) => new Set(previous).add(decision.id));
        setDepartures((count) => count + 1);
      }, LEAVE_MS),
    );
    try {
      await api.decide(decision.id, note ? { verdict, note } : { verdict });
      decisions.mutate((list) => list.filter((item) => item.id !== decision.id));
      setNotes((previous) => without(previous, decision.id));
      setReceipts((previous) =>
        [{ decisionId: decision.id, question: decision.question, runId: decision.runId, verdict }, ...previous].slice(
          0,
          MAX_RECEIPTS,
        ),
      );
      announce(`${verdictWord(verdict, true)}: ${decision.question}`);
      overview.reload();
    } catch (error) {
      bringBack(decision.id);
      setProblems((previous) => ({ ...previous, [decision.id]: describeError(toApiError(error)) }));
      announce('Your answer was not recorded. The decision is back in the Inbox.');
    } finally {
      setSending((previous) => without(previous, decision.id));
    }
  };

  const stopped = (runs.data ?? [])
    .filter((run) => STOPPED_RUN_STATUSES.includes(run.status) && isWithin(run.finishedAt, DAY_MS, now))
    .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''));

  const digest = overview.data?.digest;
  const loaded = decisions.data !== undefined;
  const lede = !loaded
    ? 'Checking for open decisions.'
    : visible.length === 0
      ? 'Nothing is waiting on you.'
      : `${visible.length} ${plural(visible.length, 'decision is', 'decisions are')} waiting on you.`;

  return (
    <div className="page page--inbox">
      <PageHeader title="Inbox" eyebrow="Decisions" lede={lede} />

      <StaleNotice error={loaded ? decisions.error : null} onRetry={decisions.reload} />

      {(inFlight.length > 0 || receipts.length > 0) && (
        <div ref={receiptsRef} className="receipts" tabIndex={-1} aria-label="Answers you just gave">
          <ul>
            {inFlight.map((decision) => (
              <li key={decision.id} className="receipt" data-state="sending">
                <span className="receipt__verdict">{verdictWord(sending[decision.id] ?? 'approve', false)}…</span>
                <span className="receipt__question">{decision.question}</span>
              </li>
            ))}
            {receipts.map((receipt) => (
              <li key={receipt.decisionId} className="receipt" data-state="done" data-verdict={receipt.verdict}>
                <span className="receipt__verdict">{verdictWord(receipt.verdict, true)}</span>
                <span className="receipt__question">{receipt.question}</span>
                <Link to={runPath(receipt.runId)}>Open the run</Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!loaded && decisions.loading && <LoadingState label="Loading open decisions…" />}
      {!loaded && decisions.error && (
        <ErrorState title="The Inbox could not be loaded" error={decisions.error} onRetry={decisions.reload} />
      )}

      {loaded && visible.length > 0 && (
        <ol className="decisions" aria-label="Open decisions">
          {visible.map((decision) => (
            <li key={decision.id}>
              <DecisionCard
                decision={decision}
                note={notes[decision.id] ?? ''}
                onNoteChange={(note) => setNotes((previous) => ({ ...previous, [decision.id]: note }))}
                submitting={sending[decision.id] ?? null}
                problem={problems[decision.id] ?? null}
                onDecide={(verdict) => void handleDecide(decision, verdict)}
              />
            </li>
          ))}
        </ol>
      )}

      {loaded && visible.length === 0 && <AllClear digest={digest} />}

      <section className="inbox-section" aria-labelledby="stopped-title">
        <SectionHead id="stopped-title" title="Stopped in the last day" count={runs.data ? stopped.length : undefined} />
        {runs.data === undefined && runs.loading && <LoadingState label="Loading recent runs…" />}
        {runs.data === undefined && runs.error && (
          <ErrorState title="Recent runs could not be loaded" error={runs.error} onRetry={runs.reload} />
        )}
        {runs.data !== undefined && stopped.length === 0 && (
          <p className="quiet-line">No run has failed, been rejected or been cancelled in the last 24 hours.</p>
        )}
        {stopped.length > 0 && <StoppedRuns runs={stopped} />}
      </section>

      {loaded && visible.length > 0 && digest && (
        <section className="inbox-section" aria-labelledby="digest-title">
          <SectionHead id="digest-title" title="Meanwhile" />
          <DigestFigures digest={digest} variant="strip" />
        </section>
      )}
    </div>
  );
}
