import type { StepKind, StepStatus } from '../../../shared/types';
import './runs.css';

/**
 * The three step shapes, used everywhere a step is drawn:
 *   circle  – an agent works (a station: someone is there)
 *   square  – the engine runs a command (a signal box: the machinery)
 *   diamond – a gate (a set of points: a person throws the lever)
 * Status is carried by the mark inside the shape as well as by colour.
 */
export type GlyphStatus = StepStatus | 'plan';

export interface StepGlyphProps {
  kind: StepKind;
  status: GlyphStatus;
  size?: number;
  /** Small glyphs drop the inner mark and rely on fill, outline and the label beside them. */
  bare?: boolean;
}

function Shape({ kind }: { kind: StepKind }) {
  if (kind === 'agent') return <circle className="glyph__shape" cx="12" cy="12" r="9" />;
  if (kind === 'command') return <rect className="glyph__shape" x="3.5" y="3.5" width="17" height="17" rx="2.5" />;
  return <path className="glyph__shape" d="M12 1.8 22.2 12 12 22.2 1.8 12Z" />;
}

function Mark({ status }: { status: GlyphStatus }) {
  switch (status) {
    case 'succeeded':
      return <path className="glyph__mark" d="M7.8 12.4 10.8 15.4 16.4 9" />;
    case 'failed':
      return <path className="glyph__mark" d="M8.6 8.6 15.4 15.4M15.4 8.6 8.6 15.4" />;
    case 'waiting':
      return <path className="glyph__mark" d="M10 8.4v7.2M14 8.4v7.2" />;
    case 'running':
      return <circle className="glyph__mark glyph__mark--dot" cx="12" cy="12" r="3" />;
    case 'skipped':
      return <path className="glyph__mark" d="M8.5 12h7" />;
    default:
      return null;
  }
}

export function StepGlyph({ kind, status, size = 24, bare = false }: StepGlyphProps) {
  return (
    <svg
      className="glyph"
      data-kind={kind}
      data-status={status}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <Shape kind={kind} />
      {!bare && <Mark status={status} />}
    </svg>
  );
}
