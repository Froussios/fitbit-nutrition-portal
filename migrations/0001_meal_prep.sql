-- Meal prep (#55, DR-24). Every row belongs to one user, taken from a verified Google ID token.
-- Nothing here copies the diary: a portion keeps its fraction, entry ID, state and time, never its nutrients.

CREATE TABLE preps (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  -- JSON: the ingredients, with the nutrients worked out when cooking.
  ingredients TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  discarded_at INTEGER,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE portions (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  prep_id TEXT NOT NULL,
  fraction REAL NOT NULL CHECK (fraction > 0 AND fraction <= 1),
  entry_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('unconfirmed', 'confirmed')),
  eaten_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, prep_id) REFERENCES preps (user_id, id) ON DELETE CASCADE
);

CREATE INDEX portions_by_prep ON portions (user_id, prep_id);
