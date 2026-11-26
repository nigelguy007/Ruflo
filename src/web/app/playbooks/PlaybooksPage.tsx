import type { Operator, Playbook, Schedule, Watch } from '../../../shared/types';
import { api } from '../lib/api';
import { minutesLabel, plural } from '../lib/format';
import { SOURCE_LABEL } from '../lib/status';
import { EmptyState, ErrorState, LoadingState, StaleNotice } from '../lib/ui';
import { useResource } from '../lib/useResource';
import type { Resource } from '../lib/useResource';
import { PageHeader } from '../shell/PageHeader';
import { PlaybookTrack } from './PlaybookTrack';
import { WatchSwitch } from './WatchSwitch';
import './playbooks.css';

function scheduleWhen(schedule: Schedule): string {
  if (schedule.dailyAt) return `Every day at ${schedule.dailyAt} UTC`;
  if (schedule.everyMinutes) return `Every ${minutesLabel(schedule.everyMinutes)}`;
  return 'No time set';
}

interface WatchTriggerProps {
  watch: Watch;
  onChanged: (watch: Watch) => void;
}

function WatchTrigger({ watch, onChanged }: WatchTriggerProps) {
  const filters = Object.entries(watch.match);
  return (
    <li className="trigger">
      <div className="trigger__text">
        <p className="trigger__name">{watch.name}</p>
        <p className="trigger__when">
          {SOURCE_LABEL[watch.source]}{' '}
          <span className="mono">{watch.kinds.length > 0 ? watch.kinds.join(', ') : 'any kind'}</span>
        </p>
        {filters.length > 0 && (
          <p className="trigger__when">
            only when{' '}
            {filters.map(([path, value], index) => (
              <span key={path} className="mono">
                {index > 0 ? ', ' : ''}
                {path} = {value}
              </span>
            ))}
          </p>
        )}
        <p className="trigger__when">
          {watch.dedupeMinutes > 0
            ? `Repeats within ${minutesLabel(watch.dedupeMinutes)} join the same run`
            : 'Every signal starts its own run'}
        </p>
      </div>
      <WatchSwitch watch={watch} onChanged={onChanged} />
    </li>
  );
}

interface ScheduleTriggerProps {
  schedule: Schedule;
}

function ScheduleTrigger({ schedule }: ScheduleTriggerProps) {
  return (
    <li className="trigger">
      <div className="trigger__text">
        <p className="trigger__name">{schedule.name}</p>
        <p className="trigger__when">Schedule · {scheduleWhen(schedule)}</p>
      </div>
      <p className="trigger__fixed" data-enabled={schedule.enabled}>
        {schedule.enabled ? 'On' : 'Off'}
        <span className="trigger__fixed-note">set in config</span>
      </p>
    </li>
  );
}

interface PlaybookSectionProps {
  playbook: Playbook;
  watches: Resource<Watch[]>;
  schedules: Resource<Schedule[]>;
  operators: ReadonlyMap<string, Operator>;
}

function PlaybookSection({ playbook, watches, schedules, operators }: PlaybookSectionProps) {
  const myWatches = (watches.data ?? []).filter((watch) => watch.playbookId === playbook.id);
  const mySchedules = (schedules.data ?? []).filter((schedule) => schedule.playbookId === playbook.id);
  const triggersLoaded = watches.data !== undefined && schedules.data !== undefined;
  const headingId = `playbook-${playbook.id}`;
  const { budget } = playbook;
  const gates = playbook.steps.filter((step) => step.kind === 'gate').length;

  const applyWatch = (updated: Watch): void =>
    watches.mutate((list) => list.map((watch) => (watch.id === updated.id ? updated : watch)));

  return (
    <article className="playbook" aria-labelledby={headingId}>
      <header className="playbook__head">
        <h2 id={headingId} className="playbook__name">
          {playbook.name}
        </h2>
        <p className="playbook__id">
          <span className="mono">{playbook.id}</span> <span className="mono">v{playbook.version}</span>
        </p>
        <p className="playbook__description">{playbook.description}</p>
      </header>

      <div className="playbook__side">
        <section aria-label={`What starts ${playbook.name}`}>
          <h3 className="eyebrow">Started by</h3>
          {!triggersLoaded && (watches.loading || schedules.loading) && <LoadingState label="Loading triggers…" />}
          {watches.error && !watches.data && (
            <ErrorState title="Watches could not be loaded" error={watches.error} onRetry={watches.reload} />
          )}
          {schedules.error && !schedules.data && (
            <ErrorState title="Schedules could not be loaded" error={schedules.error} onRetry={schedules.reload} />
          )}
          {triggersLoaded && myWatches.length + mySchedules.length === 0 && (
            <p className="quiet-line">Nothing starts this on its own. It only runs when a manual signal names it.</p>
          )}
          {myWatches.length + mySchedules.length > 0 && (
            <ul className="triggers">
              {myWatches.map((watch) => (
                <WatchTrigger key={watch.id} watch={watch} onChanged={applyWatch} />
              ))}
              {mySchedules.map((schedule) => (
                <ScheduleTrigger key={schedule.id} schedule={schedule} />
              ))}
            </ul>
          )}
        </section>

        <section aria-label={`Budget for ${playbook.name}`}>
          <h3 className="eyebrow">Budget</h3>
          <dl className="budget">
            <div>
              <dt>minutes, not counting time at a gate</dt>
              <dd>{budget.maxMinutes}</dd>
            </div>
            <div>
              <dt>agent {plural(budget.maxAgentSteps, 'step', 'steps')}</dt>
              <dd>{budget.maxAgentSteps}</dd>
            </div>
            <div>
              <dt>{plural(budget.maxHandoffs, 'handoff', 'handoffs')}</dt>
              <dd>{budget.maxHandoffs}</dd>
            </div>
          </dl>
        </section>
      </div>

      <section className="playbook__track" aria-label={`Steps of ${playbook.name}`}>
        <h3 className="eyebrow">
          Track · {playbook.steps.length} {plural(playbook.steps.length, 'step', 'steps')},{' '}
          {gates === 0 ? 'no gate' : `${gates} ${plural(gates, 'gate', 'gates')}`}
        </h3>
        <PlaybookTrack steps={playbook.steps} operators={operators} />
      </section>
    </article>
  );
}

export function PlaybooksPage() {
  const playbooks = useResource('playbooks', (signal) => api.playbooks(signal));
  const watches = useResource('watches', (signal) => api.watches(signal));
  const schedules = useResource('schedules', (signal) => api.schedules(signal));
  const operators = useResource('operators', (signal) => api.operators(signal));
  const operatorMap: ReadonlyMap<string, Operator> = new Map(
    (operators.data ?? []).map((operator) => [operator.id, operator]),
  );

  return (
    <div className="page page--playbooks">
      <PageHeader
        title="Playbooks"
        eyebrow="What runs, and what starts it"
        lede="A playbook is an ordered track of steps. Circles are agents, squares are commands the engine runs itself, diamonds are gates where a person decides."
      />

      <StaleNotice error={playbooks.data ? playbooks.error : null} onRetry={playbooks.reload} />
      {!playbooks.data && playbooks.loading && <LoadingState label="Loading playbooks…" />}
      {!playbooks.data && playbooks.error && (
        <ErrorState title="Playbooks could not be loaded" error={playbooks.error} onRetry={playbooks.reload} />
      )}
      {playbooks.data?.length === 0 && (
        <EmptyState title="No playbooks are defined.">
          <p>
            Add one to <span className="mono">config/playbooks/</span> and restart the server.
          </p>
        </EmptyState>
      )}

      {playbooks.data && playbooks.data.length > 0 && (
        <div className="playbooks">
          {playbooks.data.map((playbook) => (
            <PlaybookSection
              key={playbook.id}
              playbook={playbook}
              watches={watches}
              schedules={schedules}
              operators={operatorMap}
            />
          ))}
        </div>
      )}
    </div>
  );
}
