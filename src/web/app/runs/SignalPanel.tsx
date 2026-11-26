import type { Signal } from '../../../shared/types';
import { formatDateTime, formatFull } from '../lib/format';
import { SEVERITY, SOURCE_LABEL } from '../lib/status';
import { ExternalLink, StatusTag } from '../lib/ui';

export interface SignalPanelProps {
  signal: Signal;
}

function prettyPayload(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return 'This payload cannot be shown.';
  }
}

/** The signal that started the run, as it arrived. */
export function SignalPanel({ signal }: SignalPanelProps) {
  const hasPayload = Object.keys(signal.payload).length > 0;
  return (
    <div className="signal-panel">
      <p className="signal-panel__title">{signal.title}</p>
      <dl className="facts">
        <div>
          <dt>Source</dt>
          <dd>
            {SOURCE_LABEL[signal.source]} <span className="mono">{signal.kind}</span>
          </dd>
        </div>
        <div>
          <dt>Severity</dt>
          <dd>
            <StatusTag view={SEVERITY[signal.severity]} size="sm" />
          </dd>
        </div>
        <div>
          <dt>Received</dt>
          <dd>
            <time dateTime={signal.receivedAt} title={formatFull(signal.receivedAt)}>
              {formatDateTime(signal.receivedAt)}
            </time>
          </dd>
        </div>
        <div>
          <dt>Fingerprint</dt>
          <dd className="mono wrap-anywhere">{signal.fingerprint}</dd>
        </div>
        {signal.url && (
          <div>
            <dt>Link</dt>
            <dd className="wrap-anywhere">
              <ExternalLink url={signal.url} />
            </dd>
          </div>
        )}
      </dl>
      {hasPayload && (
        <details className="payload">
          <summary>Payload</summary>
          <pre className="code" tabIndex={0}>
            {prettyPayload(signal.payload)}
          </pre>
        </details>
      )}
    </div>
  );
}
