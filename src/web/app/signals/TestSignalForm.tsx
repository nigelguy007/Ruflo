import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { ManualSignalInput, Playbook, Severity } from '../../../shared/types';
import { api, describeError, toApiError } from '../lib/api';
import { navigate, runPath } from '../lib/router';
import { SEVERITY } from '../lib/status';
import { announce } from '../shell/announcer';

const SEVERITIES: readonly Severity[] = ['info', 'warning', 'error', 'critical'];
const KIND_PATTERN = '[a-z0-9_.\\-]{1,80}';
const DEFAULT_KIND = 'manual.error';
const TITLE_MAX_LENGTH = 200;

export interface TestSignalFormProps {
  /** undefined while playbooks are still loading. */
  playbooks: Playbook[] | undefined;
}

/**
 * Posts to the manual signal endpoint and then opens the run it started, so a
 * new user can watch a playbook move without wiring up Sentry or GitHub first.
 */
export function TestSignalForm({ playbooks }: TestSignalFormProps) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState(DEFAULT_KIND);
  const [severity, setSeverity] = useState<Severity>('error');
  const [playbookId, setPlaybookId] = useState('');
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const ids = { title: useId(), kind: useId(), kindHint: useId(), severity: useId(), playbook: useId(), playbookHint: useId() };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setSending(true);
    setProblem(null);
    setOutcome(null);
    const input: ManualSignalInput = {
      title: title.trim(),
      kind: kind.trim() || undefined,
      severity,
      playbookId: playbookId || undefined,
    };
    try {
      const result = await api.sendManualSignal(input);
      const runId = result.runs[0]?.id ?? result.joined[0];
      if (runId) {
        announce(result.runs.length > 0 ? 'Signal sent. Opening the run it started.' : 'Signal sent. It joined a run that was already open.');
        navigate(runPath(runId));
        return;
      }
      setOutcome(
        result.signal
          ? 'The signal was received, but no enabled watch matched it, so no run started. Pick a playbook to start one directly.'
          : 'The server ignored this signal.',
      );
    } catch (error) {
      setProblem(describeError(toApiError(error)));
    } finally {
      setSending(false);
    }
  };

  return (
    <form className="signal-form" onSubmit={(event) => void handleSubmit(event)} aria-labelledby="test-signal-title">
      <h2 id="test-signal-title" className="signal-form__title">
        Send a test signal
      </h2>
      <p className="signal-form__lede">Starts a run exactly as a webhook would, then takes you to it.</p>

      <div className="field">
        <label className="field__label" htmlFor={ids.title}>
          Title
        </label>
        <input
          id={ids.title}
          className="input"
          type="text"
          required
          maxLength={TITLE_MAX_LENGTH}
          placeholder="TypeError in checkout: cannot read 'plan' of undefined"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>

      <div className="signal-form__pair">
        <div className="field">
          <label className="field__label" htmlFor={ids.kind}>
            Kind
          </label>
          <input
            id={ids.kind}
            className="input mono"
            type="text"
            pattern={KIND_PATTERN}
            title="Lowercase letters, digits, dots, dashes and underscores"
            spellCheck={false}
            autoCapitalize="none"
            aria-describedby={ids.kindHint}
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          />
          <p id={ids.kindHint} className="field__hint">
            Watches match on this.
          </p>
        </div>
        <div className="field">
          <label className="field__label" htmlFor={ids.severity}>
            Severity
          </label>
          <select
            id={ids.severity}
            className="input"
            value={severity}
            onChange={(event) => setSeverity(event.target.value as Severity)}
          >
            {SEVERITIES.map((value) => (
              <option key={value} value={value}>
                {SEVERITY[value].label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field">
        <label className="field__label" htmlFor={ids.playbook}>
          Playbook <span className="field__optional">optional</span>
        </label>
        <select
          id={ids.playbook}
          className="input"
          aria-describedby={ids.playbookHint}
          value={playbookId}
          disabled={!playbooks}
          onChange={(event) => setPlaybookId(event.target.value)}
        >
          <option value="">Let the watches decide</option>
          {(playbooks ?? []).map((playbook) => (
            <option key={playbook.id} value={playbook.id}>
              {playbook.name}
            </option>
          ))}
        </select>
        <p id={ids.playbookHint} className="field__hint">
          Choosing one skips watch matching and starts that playbook directly.
        </p>
      </div>

      {problem && (
        <p className="notice notice--stop" role="alert">
          <strong>The signal was not sent.</strong> {problem}
        </p>
      )}
      {outcome && (
        <p className="notice" role="status">
          {outcome}
        </p>
      )}

      <button type="submit" className="btn btn--primary btn--large" disabled={sending}>
        {sending ? 'Sending…' : 'Send signal'}
      </button>
    </form>
  );
}
