/**
 * Durable schema. Each entry is one migration; `PRAGMA user_version` records how many ran.
 * Append new migrations; never edit an applied one.
 */
export const migrations: string[] = [
  `
  CREATE TABLE repositories(
    id TEXT PRIMARY KEY,
    canonical_root TEXT NOT NULL UNIQUE,
    revision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE workspaces(
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(id),
    real_root TEXT NOT NULL,
    base_commit TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(repository_id, real_root)
  );
  CREATE TABLE sessions(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL,
    client TEXT,
    lease_expires_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active','finished','expired')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_by_status ON sessions(status, lease_expires_at);
  CREATE TABLE intents(
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    revision INTEGER NOT NULL,
    task TEXT NOT NULL,
    scope_json TEXT NOT NULL,
    assumptions_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(session_id, revision)
  );
  CREATE TABLE files(
    workspace_id TEXT NOT NULL,
    path TEXT NOT NULL,
    hash TEXT NOT NULL,
    indexed_at INTEGER NOT NULL,
    PRIMARY KEY(workspace_id, path)
  );
  CREATE TABLE symbols(
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    logical_key TEXT NOT NULL,
    file TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    declaration_hash TEXT NOT NULL,
    exported INTEGER NOT NULL,
    line INTEGER NOT NULL,
    UNIQUE(workspace_id, logical_key)
  );
  CREATE INDEX symbols_by_file ON symbols(workspace_id, file);
  CREATE TABLE edges(
    workspace_id TEXT NOT NULL,
    from_symbol TEXT NOT NULL,
    to_symbol TEXT NOT NULL,
    kind TEXT NOT NULL,
    file TEXT NOT NULL,
    line INTEGER NOT NULL,
    PRIMARY KEY(workspace_id, from_symbol, to_symbol, kind, file, line)
  );
  CREATE INDEX edges_by_target ON edges(workspace_id, to_symbol);
  CREATE TABLE proposals(
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    base_revision INTEGER NOT NULL,
    source_hashes_json TEXT NOT NULL,
    operation_json TEXT NOT NULL,
    status TEXT NOT NULL,
    preview_json TEXT,
    result_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE contracts(
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    proposal_id TEXT,
    owner_session_id TEXT NOT NULL,
    title TEXT NOT NULL,
    producer_symbol TEXT,
    declaration TEXT NOT NULL,
    behavior_notes TEXT NOT NULL,
    participants_json TEXT NOT NULL,
    intent_revisions_json TEXT NOT NULL,
    status TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE contract_versions(
    contract_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    declaration TEXT NOT NULL,
    behavior_notes TEXT NOT NULL,
    participants_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(contract_id, version)
  );
  CREATE TABLE acknowledgements(
    contract_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    intent_revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(contract_id, version, session_id)
  );
  CREATE TABLE claims(
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    rule_json TEXT NOT NULL,
    author TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE events(
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    repository_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE verification_runs(
    id TEXT PRIMARY KEY,
    contract_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    source_hashes_json TEXT NOT NULL,
    command TEXT NOT NULL,
    exit_code INTEGER NOT NULL,
    output TEXT NOT NULL,
    revision INTEGER NOT NULL,
    overlay INTEGER NOT NULL,
    passed INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE analyses(
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    revision INTEGER NOT NULL,
    status TEXT NOT NULL,
    model TEXT,
    latency_ms INTEGER,
    usage_json TEXT,
    result_json TEXT,
    error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE journal(
    id TEXT PRIMARY KEY,
    proposal_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    entries_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  `ALTER TABLE symbols ADD COLUMN meta_json TEXT NOT NULL DEFAULT '{}';`,
  // Roles and member tokens. Only the sha256 of a token is stored; the value is shown once at creation.
  `
  CREATE TABLE tokens(
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    member TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','member','viewer')),
    hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );
  ALTER TABLE sessions ADD COLUMN token_id TEXT;
  ALTER TABLE sessions ADD COLUMN member TEXT;
  `,
  // Asynchronous verification: a run is inserted as 'running' and finished later. Default 'failed' so a row
  // never claims 'passed' by omission; existing rows are backfilled from the old boolean.
  `
  ALTER TABLE verification_runs ADD COLUMN status TEXT NOT NULL DEFAULT 'failed'
    CHECK(status IN ('running','passed','failed','inconclusive','error'));
  ALTER TABLE verification_runs ADD COLUMN reasons_json TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE verification_runs ADD COLUMN finished_at INTEGER;
  UPDATE verification_runs SET status = CASE WHEN passed = 1 THEN 'passed' ELSE 'failed' END, finished_at = created_at;
  `,
  // Laptop sync: each member's uncommitted changes, pushed by their client hook. Content NULL = file deleted.
  // Kept in the database only; never written into the hub checkout.
  `
  CREATE TABLE remote_files(
    repository_id TEXT NOT NULL REFERENCES repositories(id),
    member TEXT NOT NULL,
    path TEXT NOT NULL,
    content TEXT,
    hash TEXT NOT NULL,
    base_commit TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(repository_id, member, path)
  );
  `,
  // Hive Connect: token kinds (connector = member-role credential bound to one checkout), device pairing
  // (poll secret stored as sha256; requester is the sha256 of the client IP) and checkout reports per token.
  `
  ALTER TABLE tokens ADD COLUMN kind TEXT NOT NULL DEFAULT 'member' CHECK(kind IN ('member','connector','viewer-link'));
  ALTER TABLE tokens ADD COLUMN repo_identity TEXT;
  ALTER TABLE tokens ADD COLUMN machine TEXT;
  ALTER TABLE tokens ADD COLUMN last_seen_at INTEGER;
  CREATE TABLE pairings(
    id TEXT PRIMARY KEY,
    user_code TEXT NOT NULL UNIQUE,
    poll_secret_hash TEXT NOT NULL,
    repo_json TEXT NOT NULL,
    machine TEXT NOT NULL,
    client TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','consumed')),
    token_id TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    approved_by TEXT,
    approver TEXT,
    requester TEXT NOT NULL
  );
  CREATE INDEX pairings_by_requester ON pairings(requester, status, expires_at);
  CREATE INDEX pairings_by_created ON pairings(created_at);
  CREATE TABLE checkouts(
    token_id TEXT PRIMARY KEY,
    member TEXT NOT NULL,
    machine TEXT,
    repo_json TEXT NOT NULL,
    branch TEXT,
    head TEXT,
    base_commit TEXT,
    dirty_json TEXT NOT NULL,
    reported_at INTEGER NOT NULL
  );
  `,
];
