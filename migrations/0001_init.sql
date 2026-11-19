CREATE TABLE envelopes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',          -- draft | sent | completed | declined | voided
  pdf_key TEXT NOT NULL,
  file_name TEXT NOT NULL DEFAULT 'document.pdf',
  pages TEXT NOT NULL DEFAULT '[]',              -- JSON [{w,h}] in PDF points
  original_sha256 TEXT NOT NULL DEFAULT '',
  signed_key TEXT,
  signed_sha256 TEXT,
  created_by_id TEXT NOT NULL,
  created_by_name TEXT NOT NULL DEFAULT '',
  created_by_email TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX envelopes_updated ON envelopes (updated_at DESC);

CREATE TABLE signers (
  id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  color TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',        -- pending | sent | viewed | signed | declined
  sent_at INTEGER,
  viewed_at INTEGER,
  signed_at INTEGER,
  declined_reason TEXT,
  ip TEXT,
  user_agent TEXT,
  signature TEXT,                                -- PNG data URL
  initials TEXT                                  -- PNG data URL
);
CREATE INDEX signers_envelope ON signers (envelope_id, position);

CREATE TABLE fields (
  id TEXT PRIMARY KEY,
  envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  signer_id TEXT NOT NULL,
  type TEXT NOT NULL,                            -- signature | initials | date | name | text | checkbox
  page INTEGER NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,   -- fractions of the page, from top-left
  required INTEGER NOT NULL DEFAULT 1,
  label TEXT NOT NULL DEFAULT '',
  value TEXT
);
CREATE INDEX fields_envelope ON fields (envelope_id);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  envelope_id TEXT NOT NULL REFERENCES envelopes(id) ON DELETE CASCADE,
  signer_id TEXT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,                          -- created | sent | emailed | viewed | signed | declined | completed | voided | reminded
  detail TEXT NOT NULL DEFAULT '',
  ip TEXT,
  user_agent TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX events_envelope ON events (envelope_id, at);

CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pdf_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  pages TEXT NOT NULL,
  roles TEXT NOT NULL,                           -- JSON [{name,color}]
  fields TEXT NOT NULL,                          -- JSON [{role,type,page,x,y,w,h,required,label}]
  message TEXT NOT NULL DEFAULT '',
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
