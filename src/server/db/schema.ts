/**
 * Schema migrations, applied in order. `PRAGMA user_version` records how many
 * have run, so adding a migration means appending to this list and nothing else.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE signals (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    id           TEXT NOT NULL UNIQUE,
    source       TEXT NOT NULL,
    kind         TEXT NOT NULL,
    title        TEXT NOT NULL,
    fingerprint  TEXT NOT NULL,
    url          TEXT,
    severity     TEXT NOT NULL,
    payload      TEXT NOT NULL,
    received_at  TEXT NOT NULL
  );

  CREATE TABLE runs (
    seq                  INTEGER PRIMARY KEY AUTOINCREMENT,
    id                   TEXT NOT NULL UNIQUE,
    playbook_id          TEXT NOT NULL,
    playbook_name        TEXT NOT NULL,
    playbook_version     INTEGER NOT NULL,
    playbook             TEXT NOT NULL,
    signal_id            TEXT NOT NULL REFERENCES signals(id),
    fingerprint          TEXT NOT NULL,
    title                TEXT NOT NULL,
    status               TEXT NOT NULL,
    created_at           TEXT NOT NULL,
    started_at           TEXT,
    finished_at          TEXT,
    current_step_id      TEXT,
    stop_reason          TEXT,
    duplicate_signals    INTEGER NOT NULL DEFAULT 0,
    parked               INTEGER NOT NULL DEFAULT 0,
    gate_wait_ms         INTEGER NOT NULL DEFAULT 0,
    agent_steps_started  INTEGER NOT NULL DEFAULT 0,
    handoffs             INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX runs_status ON runs(status);
  CREATE INDEX runs_dedupe ON runs(playbook_id, fingerprint, created_at);
  CREATE INDEX runs_finished ON runs(finished_at);

  CREATE TABLE step_runs (
    run_id       TEXT NOT NULL REFERENCES runs(id),
    position     INTEGER NOT NULL,
    step_id      TEXT NOT NULL,
    kind         TEXT NOT NULL,
    title        TEXT NOT NULL,
    operator     TEXT,
    status       TEXT NOT NULL,
    attempt      INTEGER NOT NULL DEFAULT 0,
    started_at   TEXT,
    finished_at  TEXT,
    summary      TEXT,
    PRIMARY KEY (run_id, position)
  );
  CREATE INDEX step_runs_status ON step_runs(status);

  CREATE TABLE timeline (
    seq        INTEGER PRIMARY KEY,
    id         TEXT NOT NULL UNIQUE,
    run_id     TEXT NOT NULL,
    at         TEXT NOT NULL,
    actor      TEXT NOT NULL,
    kind       TEXT NOT NULL,
    text       TEXT NOT NULL,
    mentions   TEXT NOT NULL,
    data       TEXT,
    prev_hash  TEXT NOT NULL,
    hash       TEXT NOT NULL
  );
  CREATE INDEX timeline_run ON timeline(run_id, seq);

  CREATE TABLE evidence (
    seq      INTEGER PRIMARY KEY AUTOINCREMENT,
    id       TEXT NOT NULL UNIQUE,
    run_id   TEXT NOT NULL REFERENCES runs(id),
    step_id  TEXT NOT NULL,
    kind     TEXT NOT NULL,
    label    TEXT NOT NULL,
    detail   TEXT NOT NULL,
    ok       INTEGER
  );
  CREATE INDEX evidence_run ON evidence(run_id, seq);

  CREATE TABLE decisions (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    id          TEXT NOT NULL UNIQUE,
    run_id      TEXT NOT NULL REFERENCES runs(id),
    run_title   TEXT NOT NULL,
    step_id     TEXT NOT NULL,
    question    TEXT NOT NULL,
    status      TEXT NOT NULL,
    opened_at   TEXT NOT NULL,
    decided_at  TEXT,
    decided_by  TEXT,
    note        TEXT,
    evidence    TEXT NOT NULL
  );
  CREATE INDEX decisions_status ON decisions(status);
  CREATE INDEX decisions_run ON decisions(run_id, seq);

  CREATE TABLE settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );

  CREATE TABLE watch_overrides (
    watch_id  TEXT PRIMARY KEY,
    enabled   INTEGER NOT NULL
  );

  CREATE TABLE schedule_state (
    schedule_id    TEXT PRIMARY KEY,
    anchor_at      TEXT NOT NULL,
    last_fired_at  TEXT
  );
  `,
];
