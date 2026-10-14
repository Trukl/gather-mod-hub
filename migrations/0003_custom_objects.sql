-- Custom objects: images the mod draws on a floor, free or over a real object.
-- data: the object as clients get it (id, author, name, imageUrl, opacity, mode,
-- free or skin). Rows are listed in insertion order.
CREATE TABLE custom_objects (
  id TEXT PRIMARY KEY,
  floor_id TEXT NOT NULL,
  data TEXT NOT NULL,
  owner_id TEXT NOT NULL
);
CREATE INDEX custom_objects_by_floor ON custom_objects (floor_id);

-- Images uploaded for custom objects, served at /images/:id.
CREATE TABLE images (
  id TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  data BLOB NOT NULL,
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
