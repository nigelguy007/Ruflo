import type { Digest } from '../../../shared/types';
import { formatDateTime, formatFull, plural } from '../lib/format';
import { Lamp } from '../lib/ui';

export interface DigestFiguresProps {
  digest: Digest;
  /** `board` is the large version on the all-clear board, `strip` the quiet one under open decisions. */
  variant: 'board' | 'strip';
}

/** What happened without you: the reason an empty Inbox is good news rather than silence. */
export function DigestFigures({ digest, variant }: DigestFiguresProps) {
  return (
    <div className="digest" data-variant={variant}>
      <p className="eyebrow">
        Since <time dateTime={digest.since} title={formatFull(digest.since)}>{formatDateTime(digest.since)}</time>
      </p>
      <dl className="digest__headline">
        <div className="digest__figure">
          <dt>{plural(digest.handledWithoutYou, 'run', 'runs')} handled without you</dt>
          <dd>{digest.handledWithoutYou}</dd>
        </div>
        <div className="digest__figure">
          <dt>{plural(digest.decisionsMade, 'decision', 'decisions')} made</dt>
          <dd>{digest.decisionsMade}</dd>
        </div>
      </dl>
      <dl className="digest__breakdown">
        <div>
          <dt>Succeeded</dt>
          <dd>{digest.succeeded}</dd>
        </div>
        <div>
          <dt>Failed</dt>
          <dd>{digest.failed}</dd>
        </div>
        <div>
          <dt>Rejected</dt>
          <dd>{digest.rejected}</dd>
        </div>
        <div>
          <dt>Cancelled</dt>
          <dd>{digest.cancelled}</dd>
        </div>
      </dl>
    </div>
  );
}

function SignalMast() {
  return (
    <svg className="mast" viewBox="0 0 64 168" width="64" height="168" aria-hidden="true" focusable="false">
      <path className="mast__post" d="M32 96v66M20 162h24" />
      <rect className="mast__head" x="14" y="4" width="36" height="94" rx="18" />
      <circle className="mast__lamp" cx="32" cy="24" r="8" />
      <circle className="mast__lamp" cx="32" cy="51" r="8" />
      <circle className="mast__lamp mast__lamp--lit" cx="32" cy="78" r="8" />
    </svg>
  );
}

export interface AllClearProps {
  digest: Digest | undefined;
}

/** The empty Inbox: a quiet board with one green lamp and the day's tally. */
export function AllClear({ digest }: AllClearProps) {
  return (
    <section className="clear-board" aria-labelledby="all-clear-title">
      <SignalMast />
      <div className="clear-board__text">
        <p className="clear-board__flag">
          <Lamp state="clear" />
          Line clear
        </p>
        <h2 id="all-clear-title" className="clear-board__title">
          Nothing needs you.
        </h2>
        <p className="clear-board__lede">
          Operators are working through whatever comes in. A card appears here the moment a run reaches a gate.
        </p>
      </div>
      <div className="clear-board__track" aria-hidden="true" />
      {digest && <DigestFigures digest={digest} variant="board" />}
    </section>
  );
}
