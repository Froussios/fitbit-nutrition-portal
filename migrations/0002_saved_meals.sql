-- Saved meals. Every row belongs to one user, taken from a verified Google ID token, as for meal prep (DR-24).
-- A meal is a recipe only: logging one writes a diary entry and nothing here.

CREATE TABLE meals (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  -- JSON: the ingredients, with the nutrients worked out when each was added.
  ingredients TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
