-- Ids sort newest first (reversed timestamp, then random hex).
-- Owned items have owner_id (Gather account) or token_hash (created before sign-in).

CREATE TABLE presets (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  author TEXT NOT NULL,
  summary TEXT NOT NULL,
  -- name, author and summary in lower case, for search
  search TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data TEXT NOT NULL,
  owner_id TEXT,
  token_hash TEXT
);
CREATE INDEX presets_by_type ON presets (type, id);

-- data: the animation as clients get it (id, author, name, type, objects,
-- point, params, running, startedAt). Rows are listed in insertion order.
CREATE TABLE animations (
  id TEXT PRIMARY KEY,
  floor_id TEXT NOT NULL,
  data TEXT NOT NULL,
  owner_id TEXT,
  token_hash TEXT
);
CREATE INDEX animations_by_floor ON animations (floor_id);

-- Animations stored per map version before stable object references, kept
-- until a client of that map migrates them.
CREATE TABLE legacy_animations (
  map_id TEXT PRIMARY KEY,
  items TEXT NOT NULL
);

CREATE TABLE installs (
  install_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  launcher INTEGER NOT NULL,
  versions TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE announcements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  level TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Writes per hour (hours since the epoch), per action and caller.
CREATE TABLE rate_limits (
  key TEXT NOT NULL,
  hour INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (key, hour)
);
