import { useState } from 'react';
import { api, describeError, toApiError } from '../lib/api';
import { useShell } from './ShellContext';
import { announce } from './announcer';
import { PauseIcon } from './icons';

/**
 * The two things a person must never lose sight of: that everything is
 * stopped, and that nothing here is touching real code. Both stay pinned to
 * the top of the screen for as long as they are true.
 */
export function Banners() {
  const { settings, applySettings } = useShell();
  const [resuming, setResuming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (!settings || (!settings.paused && settings.mode !== 'simulate')) return null;

  const handleResume = async (): Promise<void> => {
    setResuming(true);
    setProblem(null);
    try {
      applySettings(await api.setPaused(false));
      announce('Resumed. Steps will start again.');
    } catch (error) {
      setProblem(describeError(toApiError(error)));
    } finally {
      setResuming(false);
    }
  };

  return (
    <section className="banners" aria-label="System state">
      {settings.paused && (
        <div className="banner banner--paused">
          <span className="banner__icon">
            <PauseIcon />
          </span>
          <p className="banner__text">
            <strong>Everything is paused.</strong> <span>No new step will start until you resume.</span>
            {problem && (
              <span className="banner__problem" role="alert">
                {' '}
                Could not resume: {problem}
              </span>
            )}
          </p>
          <button type="button" className="btn btn--small banner__action" onClick={handleResume} disabled={resuming}>
            {resuming ? 'Resuming…' : 'Resume'}
          </button>
        </div>
      )}
      {settings.mode === 'simulate' && (
        <div className="banner banner--simulate">
          <p className="banner__text">
            <strong>Simulate mode.</strong>{' '}
            <span className="banner__long">Operators are scripted and commands are dry runs. </span>
            <span>No real code is being changed.</span>
          </p>
        </div>
      )}
    </section>
  );
}
