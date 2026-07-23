CREATE TABLE profiles (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  first_name TEXT NOT NULL CHECK (length(first_name) BETWEEN 1 AND 100),
  last_name TEXT NOT NULL CHECK (length(last_name) BETWEEN 1 AND 100),
  email TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  phone_number TEXT NOT NULL CHECK (
    length(phone_number) BETWEEN 8 AND 16
    AND substr(phone_number, 1, 1) = '+'
    AND substr(phone_number, 2, 1) BETWEEN '1' AND '9'
    AND substr(phone_number, 2) NOT GLOB '*[^0-9]*'
  ),
  marketing INTEGER NOT NULL DEFAULT 0 CHECK (marketing IN (0, 1)),
  terms INTEGER NOT NULL CHECK (terms = 1),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24),
  updated_at TEXT NOT NULL CHECK (length(updated_at) = 24)
) STRICT;
