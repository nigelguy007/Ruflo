import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { Health, Overview, Settings } from '../../../shared/types';
import { api } from '../lib/api';
import { useLiveEvent } from '../lib/live';
import { useResource } from '../lib/useResource';
import type { Resource } from '../lib/useResource';
import { announce } from './announcer';

/** What every screen needs to know: the overview counts and whether we are paused or simulating. */
export interface ShellData {
  overview: Resource<Overview>;
  health: Resource<Health>;
  /** null until the server has told us. */
  settings: Settings | null;
  /** Apply a Settings value we just got back from the server. */
  applySettings: (settings: Settings) => void;
}

const ShellContext = createContext<ShellData | null>(null);

interface SettingsOverride {
  /** The health snapshot this override is newer than. */
  basis: Health | undefined;
  settings: Settings;
}

export interface ShellProviderProps {
  children: ReactNode;
}

export function ShellProvider({ children }: ShellProviderProps) {
  const overview = useResource('overview', (signal) => api.overview(signal), {
    refreshOn: ['run.updated', 'decision.opened', 'decision.resolved', 'signal.received'],
  });
  const health = useResource('health', (signal) => api.health(signal), {
    refreshOn: ['settings.updated'],
  });
  const [override, setOverride] = useState<SettingsOverride | null>(null);
  const healthData = health.data;

  const applySettings = useCallback(
    (settings: Settings) => setOverride({ basis: healthData, settings }),
    [healthData],
  );

  useLiveEvent((event) => {
    if (event.type === 'settings.updated') applySettings(event.settings);
    if (event.type === 'decision.opened') announce(`New decision: ${event.decision.question}`);
  });

  // A pushed or just-saved value wins until a newer health snapshot arrives.
  const settings = useMemo<Settings | null>(() => {
    if (override && override.basis === healthData) return override.settings;
    return healthData ? { paused: healthData.paused, mode: healthData.mode } : null;
  }, [override, healthData]);

  const paused = settings?.paused;
  useEffect(() => {
    if (paused === true) announce('Everything is paused. No new step will start.');
  }, [paused]);

  const value = useMemo<ShellData>(
    () => ({ overview, health, settings, applySettings }),
    [overview, health, settings, applySettings],
  );

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellData {
  const value = useContext(ShellContext);
  if (!value) throw new Error('useShell must be used inside <ShellProvider>');
  return value;
}
