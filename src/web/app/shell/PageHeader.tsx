import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { consumeHeadingFocus } from '../lib/router';

export interface PageHeaderProps {
  title: string;
  /** Small signage line above the title. */
  eyebrow?: ReactNode;
  /** One sentence under the title. */
  lede?: ReactNode;
  /** Controls that belong to the whole page. */
  actions?: ReactNode;
}

/**
 * Every screen starts with one of these. After a route change the heading
 * takes focus, so keyboard and screen-reader users land at the top of the new
 * page instead of being left on a link that no longer exists.
 */
export function PageHeader({ title, eyebrow, lede, actions }: PageHeaderProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (consumeHeadingFocus()) headingRef.current?.focus();
  }, []);

  useEffect(() => {
    document.title = `${title} · Switchyard`;
  }, [title]);

  return (
    <header className="page-head">
      <div className="page-head__text">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 ref={headingRef} className="page-head__title" tabIndex={-1}>
          {title}
        </h1>
        {lede && <p className="page-head__lede">{lede}</p>}
      </div>
      {actions && <div className="page-head__actions">{actions}</div>}
    </header>
  );
}
