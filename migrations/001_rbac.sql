-- 001_rbac.sql
-- DisCo / State-NERC / NERC / Protogy RBAC + audit trail.
-- Safe to run multiple times (IF NOT EXISTS / idempotent backfill).
--
-- Run this against the real database BEFORE deploying the new backend code:
--   psql -h <host> -U <user> -d protogy -f migrations/001_rbac.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Expand app_users with the new account model.
--    account_type replaces the old binary role for everything except the
--    legacy `role` column, which is KEPT and still set to 'admin'/'user' so
--    the existing requireAdmin() checks (ami.js, routes.js onboarding/delete
--    endpoints) keep working unchanged: 'admin' == protogy_admin, 'user' ==
--    everything else.
-- ---------------------------------------------------------------------------
ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'protogy_user',
  ADD COLUMN IF NOT EXISTS disco        TEXT,
  ADD COLUMN IF NOT EXISTS states       TEXT[],
  ADD COLUMN IF NOT EXISTS is_active    BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS full_name    TEXT;

-- Backfill existing accounts from the old binary role, preserving today's
-- actual behavior exactly: role='admin' -> protogy_admin (full admin access,
-- unchanged); role='user' -> protogy_user (full view access, unchanged -
-- today's 'user' role already sees everything, same as protogy_user).
UPDATE app_users SET account_type = 'protogy_admin' WHERE role = 'admin' AND account_type = 'protogy_user';
UPDATE app_users SET account_type = 'protogy_user'  WHERE role = 'user'  AND account_type = 'protogy_user';

ALTER TABLE app_users
  ADD CONSTRAINT app_users_account_type_check
  CHECK (account_type IN ('protogy_admin', 'protogy_user', 'nerc', 'state_nerc', 'disco'));

-- A disco account must carry a disco; a state_nerc account must carry at
-- least one state. Enforced in application code (auth.js) on create/update
-- for a friendlier error message, and backstopped here so bad data can never
-- land directly via SQL either.
ALTER TABLE app_users
  ADD CONSTRAINT app_users_disco_required
  CHECK (account_type <> 'disco' OR disco IS NOT NULL);

ALTER TABLE app_users
  ADD CONSTRAINT app_users_states_required
  CHECK (account_type <> 'state_nerc' OR (states IS NOT NULL AND array_length(states, 1) > 0));

-- ---------------------------------------------------------------------------
-- 2. Audit trail - NERC item 6.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL PRIMARY KEY,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  username     TEXT,
  account_type TEXT,
  action       TEXT NOT NULL,
  target       TEXT,
  detail       JSONB,
  ip           TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_log_at       ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_username ON audit_log (username);
CREATE INDEX IF NOT EXISTS idx_audit_log_action    ON audit_log (action);

COMMIT;

-- ---------------------------------------------------------------------------
-- Verify after running:
--   SELECT username, role, account_type, disco, states, is_active FROM app_users ORDER BY username;
--   SELECT * FROM audit_log ORDER BY at DESC LIMIT 5;
-- ---------------------------------------------------------------------------
