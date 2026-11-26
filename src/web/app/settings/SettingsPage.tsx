import { useState } from 'react';
import type { LedgerCheck } from '../../../shared/types';
import { api, describeError, toApiError } from '../lib/api';
import { clearToken, useHasToken } from '../lib/auth';
import { plural } from '../lib/format';
import { setTheme, useTheme } from '../lib/theme';
import type { Theme } from '../lib/theme';
import { ErrorState, Lamp, LoadingState, SectionHead } from '../lib/ui';
import { PageHeader } from '../shell/PageHeader';
import { useShell } from '../shell/ShellContext';
import { announce } from '../shell/announcer';
import './settings.css';

const THEMES: readonly { value: Theme; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

function PauseControl() {
  const { settings, applySettings } = useShell();
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (!settings) return null;
  const { paused } = settings;

  const handleToggle = async (): Promise<void> => {
    const next = !paused;
    setSaving(true);
    setProblem(null);
    try {
      applySettings(await api.setPaused(next));
      if (!next) announce('Resumed. Steps will start again.');
    } catch (error) {
      setProblem(describeError(toApiError(error)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pause" data-paused={paused}>
      <div className="pause__state">
        <p className="pause__headline" role="status">
          <Lamp state={paused ? 'caution' : 'lunar'} />
          {paused ? 'Everything is paused' : 'Everything is running'}
        </p>
        <p className="pause__explain">
          {paused
            ? 'No new step will start, in any run, until you resume. A step that is already under way is not interrupted.'
            : 'Runs move from step to step on their own. Pausing stops any new step from starting, in every run at once.'}
        </p>
        {problem && (
          <p className="notice notice--stop" role="alert">
            <strong>Not changed.</strong> {problem}
          </p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        className="lever"
        aria-checked={paused}
        aria-label="Pause everything"
        disabled={saving}
        onClick={() => void handleToggle()}
      >
        <span className="lever__end" data-active={!paused} aria-hidden="true">
          Running
        </span>
        <span className="lever__slot" aria-hidden="true">
          <span className="lever__handle" />
        </span>
        <span className="lever__end" data-active={paused} aria-hidden="true">
          Paused
        </span>
      </button>
    </div>
  );
}

function LedgerCheckResult({ check }: { check: LedgerCheck }) {
  const entries = `${check.checked} ${plural(check.checked, 'entry', 'entries')} checked`;
  if (check.ok) {
    return (
      <p className="ledger__result" data-ok="true" role="status">
        <Lamp state="clear" />
        <span>
          <strong>Intact.</strong> {entries}; every hash follows from the one before it. This catches accidents and
          careless edits. Someone who can write to the database file could rewrite the whole chain.
        </span>
      </p>
    );
  }
  return (
    <p className="ledger__result" data-ok="false" role="alert">
      <Lamp state="stop" />
      <span>
        <strong>Broken{check.brokenAt !== null ? ` at entry ${check.brokenAt}` : ''}.</strong> {entries}. Entries
        from that point on have been altered or are missing, and should not be trusted.
      </span>
    </p>
  );
}

function LedgerControl() {
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<LedgerCheck | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const handleVerify = async (): Promise<void> => {
    setChecking(true);
    setProblem(null);
    try {
      setCheck(await api.verifyLedger());
    } catch (error) {
      setCheck(null);
      setProblem(describeError(toApiError(error)));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="ledger">
      <p className="setting__explain">
        Every timeline entry carries the hash of the one before it. Verifying walks the whole chain and reports
        the first entry that does not match.
      </p>
      <button type="button" className="btn" onClick={() => void handleVerify()} disabled={checking}>
        {checking ? 'Verifying…' : 'Verify ledger'}
      </button>
      {check && !checking && <LedgerCheckResult check={check} />}
      {problem && (
        <p className="notice notice--stop" role="alert">
          <strong>The ledger could not be verified.</strong> {problem}
        </p>
      )}
    </div>
  );
}

function ThemeControl() {
  const theme = useTheme();
  return (
    <fieldset className="segmented">
      <legend className="visually-hidden">Theme</legend>
      {THEMES.map((option) => (
        <label key={option.value} className="segmented__option">
          <input
            type="radio"
            name="theme"
            value={option.value}
            checked={theme === option.value}
            onChange={() => setTheme(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

export function SettingsPage() {
  const { health, settings } = useShell();
  const hasToken = useHasToken();
  const simulate = settings?.mode === 'simulate';

  return (
    <div className="page page--settings">
      <PageHeader title="Settings" eyebrow="This Switchyard" />

      {!settings && health.loading && <LoadingState label="Loading settings…" />}
      {!settings && health.error && (
        <ErrorState title="Settings could not be loaded" error={health.error} onRetry={health.reload} />
      )}

      {settings && (
        <section className="setting setting--pause" aria-labelledby="pause-title">
          <SectionHead id="pause-title" title="Global pause" />
          <PauseControl />
        </section>
      )}

      {settings && (
        <section className="setting" aria-labelledby="mode-title">
          <SectionHead id="mode-title" title="Mode" />
          <p className="setting__value">{simulate ? 'Simulate' : 'Live'}</p>
          <p className="setting__explain">
            {simulate
              ? 'Operators are scripted and commands are dry runs, so nothing here changes real code.'
              : 'Operators work in real coding sessions and commands really run in your repository.'}{' '}
            The mode is fixed when the server starts and cannot be changed from here.
          </p>
        </section>
      )}

      {health.data && (
        <section className="setting" aria-labelledby="memory-title">
          <SectionHead id="memory-title" title="Memory" />
          <p className="setting__value">{health.data.coordination === 'ruflo' ? 'Ruflo' : 'Local'}</p>
          <p className="setting__explain">
            {health.data.coordination === 'ruflo'
              ? 'Operators remember earlier runs through Ruflo, which also advises on routing.'
              : 'Ruflo is not connected. Operators remember earlier runs in a store kept by this server.'}
          </p>
        </section>
      )}

      <section className="setting" aria-labelledby="ledger-title">
        <SectionHead id="ledger-title" title="Ledger" />
        <LedgerControl />
      </section>

      <section className="setting" aria-labelledby="theme-title">
        <SectionHead id="theme-title" title="Theme" />
        <ThemeControl />
        <p className="setting__explain">Remembered in this browser.</p>
      </section>

      {hasToken && (
        <section className="setting" aria-labelledby="access-title">
          <SectionHead id="access-title" title="Access" />
          <p className="setting__explain">
            An access token is held for this tab. It is forgotten when the tab closes, or now if you choose.
          </p>
          <button type="button" className="btn" onClick={clearToken}>
            Forget the token
          </button>
        </section>
      )}

      {health.data && (
        <p className="settings-foot">
          Switchyard <span className="mono">{health.data.version}</span>
        </p>
      )}
    </div>
  );
}
