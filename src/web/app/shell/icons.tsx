import type { ReactNode } from 'react';

/** Hand-drawn 20 px line icons. All decorative: the label next to each one carries the meaning. */

interface IconFrameProps {
  children: ReactNode;
  size?: number;
}

function IconFrame({ children, size = 20 }: IconFrameProps) {
  return (
    <svg
      className="icon"
      viewBox="0 0 20 20"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** A signal lamp on its post. */
export function InboxIcon() {
  return (
    <IconFrame>
      <circle cx="10" cy="7" r="4.25" />
      <circle cx="10" cy="7" r="1.25" fill="currentColor" stroke="none" />
      <path d="M10 11.25V17M6.5 17h7" />
    </IconFrame>
  );
}

/** Three sidings, one occupied. */
export function FloorIcon() {
  return (
    <IconFrame>
      <path d="M3 5h14M3 10h3.5M13.5 10H17M3 15h14" />
      <rect x="6.5" y="8" width="7" height="4" rx="1" fill="currentColor" stroke="none" />
    </IconFrame>
  );
}

/** A length of track seen from above. */
export function RunsIcon() {
  return (
    <IconFrame>
      <path d="M7 2.5v15M13 2.5v15M4.5 6h11M4.5 10h11M4.5 14h11" />
    </IconFrame>
  );
}

/** Something arriving. */
export function SignalsIcon() {
  return (
    <IconFrame>
      <circle cx="5" cy="15" r="1.5" fill="currentColor" stroke="none" />
      <path d="M4.5 9.5a6 6 0 0 1 6 6M4.5 4.5a11 11 0 0 1 11 11" />
    </IconFrame>
  );
}

/** A set of points: one line becoming two. */
export function PlaybooksIcon() {
  return (
    <IconFrame>
      <path d="M2.5 14.5h15M7 14.5c5 0 5.5-9 10.5-9" />
    </IconFrame>
  );
}

/** A lever in its frame. */
export function SettingsIcon() {
  return (
    <IconFrame>
      <path d="M3.5 17h13M9 17l3.6-10.2" />
      <circle cx="13.3" cy="4.9" r="2" />
    </IconFrame>
  );
}

export function CheckIcon() {
  return (
    <IconFrame size={16}>
      <path d="M4.5 10.5 8.5 14.5 15.5 6" strokeWidth="2" />
    </IconFrame>
  );
}

export function CrossIcon() {
  return (
    <IconFrame size={16}>
      <path d="M5.5 5.5 14.5 14.5M14.5 5.5 5.5 14.5" strokeWidth="2" />
    </IconFrame>
  );
}

export function PauseIcon() {
  return (
    <IconFrame size={18}>
      <path d="M7 4.5v11M13 4.5v11" strokeWidth="2.4" />
    </IconFrame>
  );
}

export function ArrowIcon() {
  return (
    <IconFrame size={16}>
      <path d="M3.5 10h13M11.5 5l5 5-5 5" />
    </IconFrame>
  );
}

export interface BrandMarkProps {
  size?: number;
}

/** The Switchyard mark: a turnout with its lamp. */
export function BrandMark({ size = 28 }: BrandMarkProps) {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" focusable="false">
      <path
        d="M3 22h26M11 22c8 0 8-12 18-12"
        fill="none"
        stroke="var(--lunar)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <circle cx="11" cy="22" r="3.4" fill="var(--caution)" />
    </svg>
  );
}
