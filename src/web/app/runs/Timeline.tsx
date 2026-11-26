import type { ReactNode } from 'react';
import type { Artifact, Operator, TimelineEvent } from '../../../shared/types';
import { formatClock, formatFull, shortHash } from '../lib/format';
import { withCode } from '../lib/inline';
import { TIMELINE_KIND_LABEL } from '../lib/status';
import { ExternalLink } from '../lib/ui';
import { ArrowIcon } from '../shell/icons';

const MENTION_PATTERN = /(@[a-z0-9][a-z0-9-]*)/gi;

type ActorType = 'operator' | 'system' | 'human';

interface ActorView {
  name: string;
  type: ActorType;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function actorOf(actor: string, operators: ReadonlyMap<string, Operator>): ActorView {
  if (actor === 'system') return { name: 'Engine', type: 'system' };
  if (actor === 'human') return { name: 'A person', type: 'human' };
  return { name: operators.get(actor)?.name ?? actor, type: 'operator' };
}

function nameOf(id: string, operators: ReadonlyMap<string, Operator>): string {
  return operators.get(id)?.name ?? id;
}

/** Who a handoff went to. The contract leaves `data` open, so fall back to the first mention. */
function handoffTarget(event: TimelineEvent): string | null {
  const to = event.data?.to;
  if (typeof to === 'string' && to) return to;
  return event.mentions[0] ?? null;
}

function artifactOf(event: TimelineEvent): Artifact | null {
  if (event.kind !== 'artifact' || !event.data) return null;
  const candidate = isRecord(event.data.artifact) ? event.data.artifact : event.data;
  const { kind, label, value } = candidate;
  if (typeof label !== 'string' || typeof value !== 'string') return null;
  const known = kind === 'pr' || kind === 'diff' || kind === 'log' || kind === 'url' ? kind : 'log';
  return { kind: known, label, value };
}

/** Splits text on @handles and highlights the ones that name a real operator. Never touches HTML. */
function withMentions(text: string, handles: ReadonlySet<string>): ReactNode[] {
  return text.split(MENTION_PATTERN).map((part, index) =>
    index % 2 === 1 && handles.has(part.toLowerCase()) ? (
      <span key={index} className="mention">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

function knownHandles(event: TimelineEvent, operators: ReadonlyMap<string, Operator>): ReadonlySet<string> {
  const handles = new Set<string>();
  for (const operator of operators.values()) handles.add(operator.handle.toLowerCase());
  for (const id of event.mentions) handles.add(`@${id}`.toLowerCase());
  return handles;
}

export interface TimelineProps {
  events: TimelineEvent[];
  operators: ReadonlyMap<string, Operator>;
}

/** The run's ledger, read as a conversation. Each entry ends with the start of its hash. */
export function Timeline({ events, operators }: TimelineProps) {
  return (
    <ol className="thread">
      {events.map((event) => {
        const actor = actorOf(event.actor, operators);
        const target = event.kind === 'handoff' ? handoffTarget(event) : null;
        const artifact = artifactOf(event);
        return (
          <li key={event.id} className="entry" data-kind={event.kind} data-actor={actor.type}>
            <span className="entry__marker" aria-hidden="true" />
            <div className="entry__head">
              <span className="entry__actor">{actor.name}</span>
              <span className="entry__kind">{TIMELINE_KIND_LABEL[event.kind]}</span>
              <time className="entry__time mono" dateTime={event.at} title={formatFull(event.at)}>
                {formatClock(event.at)}
              </time>
            </div>
            {target && (
              <p className="entry__handoff">
                <span className="entry__party">{actor.name}</span>
                <ArrowIcon />
                <span className="visually-hidden">hands off to</span>
                <span className="entry__party">{nameOf(target, operators)}</span>
              </p>
            )}
            <p className="entry__text">
              {withCode(event.text, (part) => withMentions(part, knownHandles(event, operators)))}
            </p>
            {artifact && (
              <p className="entry__artifact">
                <span className="entry__artifact-label">{artifact.label}</span>
                {artifact.kind === 'pr' || artifact.kind === 'url' ? (
                  <ExternalLink url={artifact.value} />
                ) : (
                  <span className="mono wrap-anywhere">{artifact.value}</span>
                )}
              </p>
            )}
            <p className="entry__hash">
              <span className="visually-hidden">Ledger entry {event.seq}, hash starts </span>
              <span aria-hidden="true">#{event.seq} </span>
              <span className="mono" title={event.hash}>
                {shortHash(event.hash)}
              </span>
            </p>
          </li>
        );
      })}
    </ol>
  );
}
