import type { ReactNode } from 'react';
import { plural, useNow } from '../lib/format';
import { useStreamStatus } from '../lib/live';
import { Link } from '../lib/router';
import type { Route } from '../lib/router';
import type { StatusView } from '../lib/status';
import type { StreamStatus } from '../lib/stream';
import { Lamp } from '../lib/ui';
import { useShell } from './ShellContext';
import {
  BrandMark,
  FloorIcon,
  InboxIcon,
  PlaybooksIcon,
  RunsIcon,
  SettingsIcon,
  SignalsIcon,
} from './icons';

type Section = 'inbox' | 'floor' | 'runs' | 'signals' | 'playbooks' | 'settings';

interface NavItem {
  section: Section;
  to: string;
  label: string;
  icon: ReactNode;
}

const NAV_ITEMS: readonly NavItem[] = [
  { section: 'inbox', to: '/', label: 'Inbox', icon: <InboxIcon /> },
  { section: 'floor', to: '/floor', label: 'Floor', icon: <FloorIcon /> },
  { section: 'runs', to: '/runs', label: 'Runs', icon: <RunsIcon /> },
  { section: 'signals', to: '/signals', label: 'Signals', icon: <SignalsIcon /> },
  { section: 'playbooks', to: '/playbooks', label: 'Playbooks', icon: <PlaybooksIcon /> },
  { section: 'settings', to: '/settings', label: 'Settings', icon: <SettingsIcon /> },
];

/**
 * The update stream's state. Deliberately never called "live": next to the
 * mode, "live" must only ever mean that operators touch real code.
 */
const STREAM_VIEW: Record<StreamStatus, StatusView> = {
  open: { label: 'Connected', lamp: 'lunar' },
  connecting: { label: 'Connecting', lamp: 'off' },
  retrying: { label: 'Reconnecting', lamp: 'stop' },
  unauthorized: { label: 'Locked', lamp: 'stop' },
};

const CLOCK_TICK_MS = 10_000;
const MAX_BADGE = 99;

function sectionOf(route: Route): Section | null {
  if (route.name === 'run') return 'runs';
  return route.name === 'not_found' ? null : route.name;
}

function utcClock(now: number): string {
  return new Date(now).toISOString().slice(11, 16);
}

export interface NavRailProps {
  route: Route;
}

/**
 * The line diagram down the left edge: every screen is a stop on one track and
 * the stop you are at is lit. Below 720 px the same nav becomes a bottom bar.
 */
export function NavRail({ route }: NavRailProps) {
  const { overview, settings } = useShell();
  const streamStatus = useStreamStatus();
  const now = useNow(CLOCK_TICK_MS);
  const current = sectionOf(route);
  const openDecisions = overview.data?.openDecisions ?? 0;
  const stream = STREAM_VIEW[streamStatus];

  return (
    <header className="rail">
      <Link to="/" className="rail__brand" aria-label="Switchyard, go to the Inbox">
        <BrandMark />
        <span className="rail__wordmark">Switchyard</span>
      </Link>

      <nav className="rail__nav" aria-label="Primary">
        <ul className="rail__list">
          {NAV_ITEMS.map((item) => {
            const active = item.section === current;
            const alert = item.section === 'inbox' && openDecisions > 0;
            return (
              <li key={item.section}>
                <Link
                  to={item.to}
                  className="rail__link"
                  aria-current={active ? 'page' : undefined}
                  data-alert={alert || undefined}
                >
                  <span className="rail__stop" aria-hidden="true" />
                  <span className="rail__icon">{item.icon}</span>
                  <span className="rail__label">{item.label}</span>
                  {alert && (
                    <span className="rail__count">
                      <span aria-hidden="true">{Math.min(openDecisions, MAX_BADGE)}</span>
                      <span className="visually-hidden">
                        {openDecisions} open {plural(openDecisions, 'decision', 'decisions')}
                      </span>
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="rail__foot">
        <p className="rail__status" data-lamp={stream.lamp}>
          <Lamp state={stream.lamp} live={streamStatus === 'open'} />
          <span className="rail__status-text">
            <span className="visually-hidden">Updates from the server: </span>
            {stream.label}
          </span>
        </p>
        {settings && (
          <p className="rail__mode">
            <span className="visually-hidden">Mode: </span>
            {settings.mode === 'simulate' ? 'Simulate mode' : 'Live mode'}
          </p>
        )}
        <p className="rail__clock">
          <time dateTime={new Date(now).toISOString()}>{utcClock(now)}</time> UTC
        </p>
      </div>
    </header>
  );
}
