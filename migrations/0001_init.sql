CREATE TABLE bookings (
  id TEXT PRIMARY KEY,           -- unguessable; the booker's manage link
  owner_token TEXT NOT NULL UNIQUE, -- unguessable; the owner's approve link
  start INTEGER NOT NULL,        -- epoch ms
  end INTEGER NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  note TEXT NOT NULL,
  timezone TEXT NOT NULL,        -- the booker's, for wording emails
  status TEXT NOT NULL,          -- pending | confirmed | declined | cancelled | expired
  sequence INTEGER NOT NULL DEFAULT 0, -- calendar invite revision
  created_at INTEGER NOT NULL
);
CREATE INDEX bookings_active ON bookings (status, start);

-- key 'feeds': open and busy intervals from the last calendar sync, as JSON.
CREATE TABLE cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
