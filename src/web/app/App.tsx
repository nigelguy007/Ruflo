import type { ReactNode } from 'react';
import { FloorPage } from './floor/FloorPage';
import { InboxPage } from './inbox/InboxPage';
import { LiveConnection } from './lib/live';
import { Link, useRoute } from './lib/router';
import type { Route } from './lib/router';
import { EmptyState } from './lib/ui';
import { PlaybooksPage } from './playbooks/PlaybooksPage';
import { RunDetailPage } from './runs/RunDetailPage';
import { RunsPage } from './runs/RunsPage';
import { SettingsPage } from './settings/SettingsPage';
import { PageHeader } from './shell/PageHeader';
import { Shell } from './shell/Shell';
import { ShellProvider } from './shell/ShellContext';
import { SignalsPage } from './signals/SignalsPage';

function NotFoundPage() {
  return (
    <div className="page">
      <PageHeader title="No such page" eyebrow="Off the map" />
      <EmptyState title="This track does not lead anywhere.">
        <p>
          <Link to="/">Go to the Inbox</Link>
        </p>
      </EmptyState>
    </div>
  );
}

/** Keyed by page, so each screen mounts fresh and its heading can take focus. */
function screenFor(route: Route): { key: string; element: ReactNode } {
  switch (route.name) {
    case 'inbox':
      return { key: 'inbox', element: <InboxPage /> };
    case 'floor':
      return { key: 'floor', element: <FloorPage /> };
    case 'runs':
      return { key: 'runs', element: <RunsPage status={route.status} /> };
    case 'run':
      return { key: `run:${route.id}`, element: <RunDetailPage id={route.id} /> };
    case 'signals':
      return { key: 'signals', element: <SignalsPage /> };
    case 'playbooks':
      return { key: 'playbooks', element: <PlaybooksPage /> };
    case 'settings':
      return { key: 'settings', element: <SettingsPage /> };
    default:
      return { key: 'not_found', element: <NotFoundPage /> };
  }
}

export function App() {
  const route = useRoute();
  const screen = screenFor(route);
  return (
    <ShellProvider>
      <LiveConnection />
      <Shell route={route}>
        <div key={screen.key} className="screen">
          {screen.element}
        </div>
      </Shell>
    </ShellProvider>
  );
}
