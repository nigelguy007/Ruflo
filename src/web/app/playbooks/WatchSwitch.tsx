import { useState } from 'react';
import type { Watch } from '../../../shared/types';
import { api, describeError, toApiError } from '../lib/api';
import { announce } from '../shell/announcer';

export interface WatchSwitchProps {
  watch: Watch;
  onChanged: (watch: Watch) => void;
}

/** Enables or disables one watch. Flips at once and flips back, with the reason, if the server refuses. */
export function WatchSwitch({ watch, onChanged }: WatchSwitchProps) {
  const [pending, setPending] = useState<boolean | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const enabled = pending ?? watch.enabled;

  const handleToggle = async (): Promise<void> => {
    const next = !enabled;
    setPending(next);
    setProblem(null);
    try {
      onChanged(await api.setWatchEnabled(watch.id, next));
      announce(`${watch.name} is now ${next ? 'on' : 'off'}.`);
    } catch (error) {
      setProblem(describeError(toApiError(error)));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="watch-switch">
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={enabled}
        aria-label={`Watch: ${watch.name}`}
        disabled={pending !== null}
        onClick={() => void handleToggle()}
      >
        <span className="switch__track" aria-hidden="true">
          <span className="switch__thumb" />
        </span>
        <span className="switch__state" aria-hidden="true">
          {enabled ? 'On' : 'Off'}
        </span>
      </button>
      {problem && (
        <p className="watch-switch__problem" role="alert">
          Not changed: {problem}
        </p>
      )}
    </div>
  );
}
