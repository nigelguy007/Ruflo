import type { Evidence, EvidenceKind } from '../../../shared/types';
import { InlineText } from '../lib/inline';
import { EVIDENCE_KIND, EVIDENCE_ORDER } from '../lib/status';
import './inbox.css';

/**
 * The product's promise in one component: evidence is never just a list. It
 * is sorted by who stands behind it, and each group says so in words, with
 * its own outline (solid, dashed, dotted) and its own badge, so the difference
 * survives without colour.
 */

interface VerdictView {
  word: string;
  tone: 'for' | 'against' | 'info';
}

function verdictOf(ok: boolean | null): VerdictView {
  if (ok === true) return { word: 'Supports', tone: 'for' };
  if (ok === false) return { word: 'Against', tone: 'against' };
  return { word: 'Note', tone: 'info' };
}

interface VerdictMarkProps {
  tone: VerdictView['tone'];
  kind: EvidenceKind;
}

/** A check or a cross only where something stands behind it: simulated rows get a broken ring. */
function VerdictMark({ tone, kind }: VerdictMarkProps) {
  if (kind === 'simulated') {
    return (
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
        <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2.4 2" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      {tone === 'for' && <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2" />}
      {tone === 'against' && <path d="M4 4 12 12M12 4 4 12" fill="none" stroke="currentColor" strokeWidth="2" />}
      {tone === 'info' && <circle cx="8" cy="8" r="2.5" fill="currentColor" />}
    </svg>
  );
}

interface KindBadgeProps {
  kind: EvidenceKind;
  /** An empty group gets a hollow badge: nothing is there to vouch for. */
  empty: boolean;
}

/** Square for the engine, circle for an agent, broken outline for a simulation: the step shapes again. */
function KindBadge({ kind, empty }: KindBadgeProps) {
  return (
    <svg className="evidence__badge" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      {kind === 'verified' && empty && (
        <rect x="3.5" y="3.5" width="17" height="17" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="3 2.5" />
      )}
      {kind === 'verified' && !empty && (
        <>
          <rect x="3" y="3" width="18" height="18" rx="2.5" fill="currentColor" />
          <path d="M7.5 12.4 10.7 15.6 16.6 8.8" fill="none" stroke="var(--ink-1)" strokeWidth="2.2" />
        </>
      )}
      {kind === 'claimed' && (
        <>
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M8.2 14.2c0-2.6.9-4.2 2.6-5M13.4 14.2c0-2.6.9-4.2 2.6-5" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </>
      )}
      {kind === 'simulated' && (
        <>
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeDasharray="2.5 3" />
          <path d="M7.5 12.5c1.5-2.4 3-2.4 4.5 0s3 2.4 4.5 0" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </>
      )}
    </svg>
  );
}

/** Command evidence ("$ npm test", then the exit line and output) keeps its lines and its monospace. */
function EvidenceDetail({ detail }: { detail: string }) {
  if (detail.startsWith('$ ')) return <pre className="evidence__detail evidence__detail--command">{detail}</pre>;
  return (
    <p className="evidence__detail">
      <InlineText text={detail} />
    </p>
  );
}

interface EvidenceGroupProps {
  kind: EvidenceKind;
  items: Evidence[];
}

function EvidenceGroup({ kind, items }: EvidenceGroupProps) {
  const view = EVIDENCE_KIND[kind];
  return (
    <section className="evidence" data-kind={kind} data-empty={items.length === 0 || undefined} aria-label={view.title}>
      <header className="evidence__head">
        <KindBadge kind={kind} empty={items.length === 0} />
        <h3 className="evidence__title">{view.title}</h3>
        <span className="evidence__count" aria-label={`${items.length} items`}>
          {items.length}
        </span>
        <p className="evidence__explainer">{view.explainer}</p>
      </header>
      {items.length === 0 ? (
        <p className="evidence__none">{view.empty}</p>
      ) : (
        <ul className="evidence__list">
          {items.map((item) => {
            const verdict = verdictOf(item.ok);
            return (
              <li key={item.id} className="evidence__item" data-tone={verdict.tone}>
                <span className="evidence__verdict">
                  <VerdictMark tone={verdict.tone} kind={kind} />
                  {verdict.word}
                </span>
                <div className="evidence__text">
                  <p className="evidence__label">
                    <InlineText text={item.label} />
                  </p>
                  {item.detail && <EvidenceDetail detail={item.detail} />}
                </div>
                <span className="evidence__step mono" title="The step that produced this">
                  {item.stepId}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export interface EvidenceGroupsProps {
  evidence: Evidence[];
}

/**
 * Always shows the "verified" group, even when it is empty: knowing that the
 * engine checked nothing is exactly what a person at a gate needs to see.
 */
export function EvidenceGroups({ evidence }: EvidenceGroupsProps) {
  return (
    <div className="evidence-groups">
      {EVIDENCE_ORDER.map((kind) => {
        const items = evidence.filter((item) => item.kind === kind);
        if (items.length === 0 && kind !== 'verified') return null;
        return <EvidenceGroup key={kind} kind={kind} items={items} />;
      })}
    </div>
  );
}
