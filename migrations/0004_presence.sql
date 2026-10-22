-- When each Gather account last ran the mod: its core pings every 2 minutes.
-- An account that hides its use of the mod has no row.
CREATE TABLE presence (
  account_id TEXT PRIMARY KEY,
  seen_at TEXT NOT NULL
);
