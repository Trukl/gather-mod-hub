-- `{ moduleId: "x.y.z" }`: only mods running one of these modules below that
-- version get the announcement. NULL: every mod.
ALTER TABLE announcements ADD COLUMN outdated TEXT;
