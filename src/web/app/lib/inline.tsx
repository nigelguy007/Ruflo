import { Fragment } from 'react';
import type { ReactNode } from 'react';

/**
 * Server prose marks commands and paths with backticks, as in
 * "Dry run of `gh pr merge --squash`: nothing was executed." This turns each
 * backtick pair into a <code> element and leaves everything else as text. It
 * builds React elements only and never parses or injects HTML. An unpaired
 * backtick is shown as it is.
 */

const CODE_SPAN = /`([^`\n]+)`/;

export type PlainRenderer = (text: string) => ReactNode;

const asText: PlainRenderer = (text) => text;

export function withCode(text: string, renderPlain: PlainRenderer = asText): ReactNode[] {
  return text.split(CODE_SPAN).map((part, index) =>
    index % 2 === 1 ? (
      <code key={index} className="mono inline-code">
        {part}
      </code>
    ) : (
      <Fragment key={index}>{renderPlain(part)}</Fragment>
    ),
  );
}

export interface InlineTextProps {
  /** Untrusted text that may contain `code` spans. */
  text: string;
}

export function InlineText({ text }: InlineTextProps) {
  return <>{withCode(text)}</>;
}
