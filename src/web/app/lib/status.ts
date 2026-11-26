import type {
  EvidenceKind,
  OperatorStatus,
  RunStatus,
  Severity,
  SignalSource,
  StepKind,
  StepStatus,
  TimelineKind,
} from '../../../shared/types';

/**
 * Colour carries state and nothing else, and a lamp never appears without
 * words. This file is the single place where a state becomes a lamp colour
 * and a label.
 */
export type LampState = 'lunar' | 'clear' | 'caution' | 'stop' | 'off';

export interface StatusView {
  label: string;
  lamp: LampState;
}

export const RUN_STATUS: Record<RunStatus, StatusView> = {
  queued: { label: 'Queued', lamp: 'off' },
  running: { label: 'Running', lamp: 'lunar' },
  waiting_gate: { label: 'Waiting on you', lamp: 'caution' },
  succeeded: { label: 'Succeeded', lamp: 'clear' },
  failed: { label: 'Failed', lamp: 'stop' },
  rejected: { label: 'Rejected', lamp: 'stop' },
  cancelled: { label: 'Cancelled', lamp: 'off' },
};

export const STEP_STATUS: Record<StepStatus, StatusView> = {
  pending: { label: 'Not started', lamp: 'off' },
  running: { label: 'Running', lamp: 'lunar' },
  waiting: { label: 'Waiting on you', lamp: 'caution' },
  succeeded: { label: 'Succeeded', lamp: 'clear' },
  failed: { label: 'Failed', lamp: 'stop' },
  skipped: { label: 'Skipped', lamp: 'off' },
};

export const OPERATOR_STATUS: Record<OperatorStatus, StatusView> = {
  idle: { label: 'Idle', lamp: 'off' },
  working: { label: 'Working', lamp: 'lunar' },
  waiting: { label: 'Waiting on a person', lamp: 'caution' },
  paused: { label: 'Paused', lamp: 'off' },
};

export const SEVERITY: Record<Severity, StatusView> = {
  info: { label: 'Info', lamp: 'off' },
  warning: { label: 'Warning', lamp: 'caution' },
  error: { label: 'Error', lamp: 'stop' },
  critical: { label: 'Critical', lamp: 'stop' },
};

export const STEP_KIND_LABEL: Record<StepKind, string> = {
  agent: 'Agent',
  command: 'Command',
  gate: 'Gate',
};

export const SOURCE_LABEL: Record<SignalSource, string> = {
  sentry: 'Sentry',
  github: 'GitHub',
  schedule: 'Schedule',
  manual: 'Manual',
};

export const TIMELINE_KIND_LABEL: Record<TimelineKind, string> = {
  signal: 'Signal',
  note: 'Note',
  handoff: 'Handoff',
  artifact: 'Artifact',
  command: 'Command',
  gate_opened: 'Gate opened',
  gate_resolved: 'Gate resolved',
  error: 'Error',
  system: 'System',
};

export interface EvidenceKindView {
  title: string;
  explainer: string;
  empty: string;
}

export const EVIDENCE_KIND: Record<EvidenceKind, EvidenceKindView> = {
  verified: {
    title: 'Verified by the engine',
    explainer: 'The engine ran this itself and saw the result. Nobody had to be trusted.',
    empty: 'Nothing here was verified by the engine.',
  },
  claimed: {
    title: 'Claimed by an agent',
    explainer: 'An agent reported this. Plausible, but nobody checked it.',
    empty: 'No agent claims.',
  },
  simulated: {
    title: 'Simulated',
    explainer: 'Produced in simulate mode for the demo. It proves nothing.',
    empty: 'Nothing simulated.',
  },
};

export const EVIDENCE_ORDER: readonly EvidenceKind[] = ['verified', 'claimed', 'simulated'];

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['queued', 'running', 'waiting_gate'];
export const STOPPED_RUN_STATUSES: readonly RunStatus[] = ['failed', 'rejected', 'cancelled'];

export function isActiveRun(status: RunStatus): boolean {
  return ACTIVE_RUN_STATUSES.includes(status);
}
