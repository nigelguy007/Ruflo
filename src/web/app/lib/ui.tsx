import type { ReactNode } from 'react';
import { describeError } from './api';
import type { ApiRequestError } from './api';
import { formatFull, safeHttpUrl, timeAgo, useNow } from './format';
import type { LampState, StatusView } from './status';
import './ui.css';

/** Small building blocks shared by every screen. Styles live in ./ui.css, on top of shell/base.css. */

const RELATIVE_TIME_TICK_MS = 30_000;

export interface LampProps {
  state: LampState;
  /** A slow pulse for things that are happening right now. */
  live?: boolean;
}

/** Purely decorative: the words next to it carry the meaning. */
export function Lamp({ state, live = false }: LampProps) {
  return (
    <span
      className={live ? 'lamp lamp--live' : 'lamp'}
      data-state={state === 'off' ? undefined : state}
      aria-hidden="true"
    />
  );
}

export interface StatusTagProps {
  view: StatusView;
  live?: boolean;
  size?: 'sm' | 'md';
}

export function StatusTag({ view, live = false, size = 'md' }: StatusTagProps) {
  return (
    <span className="status-tag" data-lamp={view.lamp} data-size={size}>
      <Lamp state={view.lamp} live={live} />
      <span>{view.label}</span>
    </span>
  );
}

export interface TimeAgoProps {
  iso: string | null | undefined;
}

export function TimeAgo({ iso }: TimeAgoProps) {
  const now = useNow(RELATIVE_TIME_TICK_MS);
  if (!iso) return <span>not yet</span>;
  return (
    <time dateTime={iso} title={formatFull(iso)}>
      {timeAgo(iso, now)}
    </time>
  );
}

export interface SectionHeadProps {
  id?: string;
  title: string;
  count?: number;
  aside?: ReactNode;
}

/** A section heading whose rule runs off to the right as a length of track. */
export function SectionHead({ id, title, count, aside }: SectionHeadProps) {
  return (
    <div className="section-head">
      <h2 id={id} className="section-head__title">
        {title}
        {count !== undefined && <span className="section-head__count">{count}</span>}
      </h2>
      <span className="section-head__track" aria-hidden="true" />
      {aside && <div className="section-head__aside">{aside}</div>}
    </div>
  );
}

export interface LoadingStateProps {
  label: string;
}

export function LoadingState({ label }: LoadingStateProps) {
  return (
    <div className="state state--loading" role="status">
      <span className="state__sweep" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export interface ErrorStateProps {
  title: string;
  error: ApiRequestError;
  onRetry?: () => void;
}

export function ErrorState({ title, error, onRetry }: ErrorStateProps) {
  return (
    <div className="state state--error" role="alert">
      <p className="state__title">
        <Lamp state="stop" />
        {title}
      </p>
      <p className="state__body">{describeError(error)}</p>
      <p className="state__code">
        <span className="mono">{error.code}</span>
      </p>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export interface StaleNoticeProps {
  error: ApiRequestError | null;
  onRetry: () => void;
}

/** Shown above data that could not be refreshed, so nobody acts on a stale board unknowingly. */
export function StaleNotice({ error, onRetry }: StaleNoticeProps) {
  if (!error) return null;
  return (
    <div className="notice notice--stop" role="alert">
      <p>
        <strong>This may be out of date.</strong> {describeError(error)}
      </p>
      <button type="button" className="btn btn--small" onClick={onRetry}>
        Refresh
      </button>
    </div>
  );
}

export interface EmptyStateProps {
  title: string;
  children?: ReactNode;
}

export function EmptyState({ title, children }: EmptyStateProps) {
  return (
    <div className="state state--empty">
      <p className="state__title">{title}</p>
      {children && <div className="state__body">{children}</div>}
    </div>
  );
}

export interface ExternalLinkProps {
  /** Untrusted. Rendered as a link only when it is http or https. */
  url: string | null | undefined;
  children?: ReactNode;
}

export function ExternalLink({ url, children }: ExternalLinkProps) {
  const safe = safeHttpUrl(url);
  if (!url) return null;
  if (!safe) return <span className="mono wrap-anywhere">{children ?? url}</span>;
  return (
    <a className="external" href={safe} target="_blank" rel="noopener noreferrer">
      {children ?? url}
      <span className="visually-hidden"> (opens in a new tab)</span>
      <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" focusable="false">
        <path d="M4 2h6v6M10 2 3 9" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </a>
  );
}
