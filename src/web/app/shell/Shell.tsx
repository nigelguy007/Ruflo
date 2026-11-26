import type { MouseEvent, ReactNode } from 'react';
import type { Route } from '../lib/router';
import { Banners } from './Banners';
import { NavRail } from './NavRail';
import { TokenPrompt } from './TokenPrompt';
import { LiveRegion } from './announcer';
import './base.css';
import './shell.css';

const MAIN_ID = 'main';

export interface ShellProps {
  route: Route;
  children: ReactNode;
}

export function Shell({ route, children }: ShellProps) {
  const skipToMain = (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    document.getElementById(MAIN_ID)?.focus();
  };

  return (
    <div className="shell">
      <a className="skip-link" href={`#${MAIN_ID}`} onClick={skipToMain}>
        Skip to content
      </a>
      <NavRail route={route} />
      <div className="shell__body">
        <Banners />
        <main id={MAIN_ID} className="shell__main" tabIndex={-1}>
          {children}
        </main>
      </div>
      <LiveRegion />
      <TokenPrompt />
    </div>
  );
}
