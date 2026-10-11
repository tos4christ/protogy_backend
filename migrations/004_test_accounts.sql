-- 004_test_accounts.sql
-- Test logins for the 6-DisCo RBAC verification exercise.
--
-- REVISED after running the verification query against the real DB:
--   SELECT DISTINCT disco FROM meters ORDER BY 1;  -> AEDC (Abuja), BEDC (Benin), JED (Jos), PHED (Port Harcourt), YEDC (Yola)
--   SELECT DISTINCT state FROM meters ORDER BY 1;  -> BENIN, FCT, JOS, PortHarcourt, YOLA
--
-- IMPORTANT FINDING: meters.state currently stores the feeder's CITY/LOCATION
-- (Benin, Jos, PortHarcourt, Yola), not the actual Nigerian STATE name (Edo,
-- Plateau, Rivers, Adamawa). Only FCT happens to be both. This matches the
-- original state_nerc design loosely (it still groups correctly per DisCo),
-- but it's not what "State NERC" is supposed to mean regulatorily -- a real
-- state electricity regulator is defined by the actual state, not a city.
-- This file works WITH the data as it exists today (so these accounts show
-- real data when you log in), but this is worth fixing properly later --
-- see the note at the bottom.
--
-- Password hashes are REAL bcrypt hashes (cost factor 10, generated with
-- this backend's own bcryptjs library) -- these credentials work immediately.
--
-- Safe to re-run: every INSERT upserts on username.
--
--   psql -h <host> -U <user> -d protogy -f migrations/004_test_accounts.sql

-- ===========================================================================
-- Before running: check these usernames don't already belong to someone
-- else's real account (the upsert below would silently reset its password):
--   SELECT username FROM app_users WHERE username IN (
--     'aedc_user','bedc_user','jed_user','phed_user','eedc_user','yedc_user',
--     'fct_nerc','benin_nerc','jos_nerc','portharcourt_nerc','yola_nerc','enugu_nerc',
--     'aedc_region_nerc','jed_region_nerc','national_nerc'
--   );
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. DisCo accounts (6) -- disco values are your actual meters.disco strings,
--    confirmed against your DB. EEDC is the 6th DisCo from the original NERC
--    directive, not yet onboarded -- its disco string is unconfirmed (no
--    feeders exist to check it against), so expect "no feeders" on login,
--    not an error, and adjust if your real onboarding uses a different string.
-- ---------------------------------------------------------------------------
INSERT INTO app_users (username, password_hash, role, account_type, disco, states, full_name, is_active)
VALUES
  ('aedc_user', '$2a$10$dhBp3JKAwa3TX6dnM/tU7een/nczu53TgPlEJidH5pdYNBKeJAyj2', 'user', 'disco', 'AEDC (Abuja)', NULL, 'AEDC Test Account', true),
  ('bedc_user', '$2a$10$am8aIyXUq2nE5EAicqRLR.kchqovPSb/AuzwqV1.K32N2Vbg9NoJm', 'user', 'disco', 'BEDC (Benin)', NULL, 'BEDC Test Account', true),
  ('jed_user',  '$2a$10$PFkFW9qiRkyqHnZ30qev1u.ZBig20J8QdOk5NcpkPuJxW0k16btXq', 'user', 'disco', 'JED (Jos)', NULL, 'JED Test Account', true),
  ('phed_user', '$2a$10$xzQN09FMuP0zl2WMFOGg/OiKG0bND6n5I2wmcijEbGKrcdUr1DXB2', 'user', 'disco', 'PHED (Port Harcourt)', NULL, 'PHED Test Account', true),
  ('eedc_user', '$2a$10$U1653jMEUMVaUr9DNboEfOmhIbmScBvH/NKosSF2KfCmCN3izPQMe', 'user', 'disco', 'EEDC (Enugu)', NULL, 'EEDC Test Account -- UNCONFIRMED disco string, no feeders onboarded yet', true),
  ('yedc_user', '$2a$10$hWKxI81s6wu5hrAkCwAU/eeT8jiBoS7cXIhjzp03FfSNhnVpWsvKO', 'user', 'disco', 'YEDC (Yola)', NULL, 'YEDC Test Account', true)
ON CONFLICT (username) DO UPDATE SET
  password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, account_type = EXCLUDED.account_type,
  disco = EXCLUDED.disco, states = EXCLUDED.states, full_name = EXCLUDED.full_name, is_active = true;

-- ---------------------------------------------------------------------------
-- 2. Single-state NERC accounts (6) -- states now match meters.state EXACTLY
--    as confirmed by your query, including PortHarcourt's unusual casing
--    (no space, capital H). Usernames renamed from the first draft to match
--    what's actually in the data, so there's no confusion later about which
--    account covers what.
-- ---------------------------------------------------------------------------
INSERT INTO app_users (username, password_hash, role, account_type, disco, states, full_name, is_active)
VALUES
  ('fct_nerc',           '$2a$10$xb53MUTy.n5E0KVGw.KqQOLuQpeVq7OH5g4A1Tzfnu6pTLgDENoc.', 'user', 'state_nerc', NULL, ARRAY['FCT'],           'FCT NERC Test Account (AEDC data)', true),
  ('benin_nerc',         '$2a$10$uJeeCSflMUMCqCTLicjCyeP7ga42qiIJ2lIlkAPasuGhqyK/aJSGe', 'user', 'state_nerc', NULL, ARRAY['BENIN'],         'Benin NERC Test Account (BEDC data)', true),
  ('jos_nerc',           '$2a$10$8.A1RsilO6DnDPgf/WI2ROKwdPmIP3IOMdevnVHbgaOOz4TeyAPPy', 'user', 'state_nerc', NULL, ARRAY['JOS'],           'Jos NERC Test Account (JED data)', true),
  ('portharcourt_nerc',  '$2a$10$Zj/DSH4WIX1su/caLRkzUuWyrNv9WDWFPDtOpwxG83.R2tLa.dabO', 'user', 'state_nerc', NULL, ARRAY['PortHarcourt'], 'Port Harcourt NERC Test Account (PHED data)', true),
  ('yola_nerc',          '$2a$10$EWs0yMP2caJ8CSX2.0x4z.4PU1.5gz4wHslzt7bGIM6GWEOgUXHPe', 'user', 'state_nerc', NULL, ARRAY['YOLA'],          'Yola NERC Test Account (YEDC data)', true),
  ('enugu_nerc',         '$2a$10$d2bRz1OmbUfsuF3jdjKWSuLq8gu/m7BMYWtI2.DOjpTPvJVkBU7UO', 'user', 'state_nerc', NULL, ARRAY['ENUGU'],         'Enugu NERC Test Account -- UNCONFIRMED, no EEDC feeders onboarded yet', true)
ON CONFLICT (username) DO UPDATE SET
  password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, account_type = EXCLUDED.account_type,
  disco = EXCLUDED.disco, states = EXCLUDED.states, full_name = EXCLUDED.full_name, is_active = true;

-- ---------------------------------------------------------------------------
-- 3. Multi-state region NERC accounts (2) -- tests the state_nerc multi-
--    value scope path. These use the Commission's REAL state names (not
--    city names), grounded in AEDC's and JED's actual multi-state footprints
--    per FEEDER_DATABASE.xlsx. Given the city-vs-state mismatch above, these
--    two will currently show little/no data except where a state happens to
--    also be the stored city value (FCT) -- see the closing note below for
--    the real fix. Still worth having now: once meters.state is corrected,
--    these start working with no further changes needed here.
-- ---------------------------------------------------------------------------
INSERT INTO app_users (username, password_hash, role, account_type, disco, states, full_name, is_active)
VALUES
  ('aedc_region_nerc', '$2a$10$i56pk6.RBTtY6jqwN7HjouSTzP5Yaym2tDJJLUUf4A9VrmY9FzluK', 'user', 'state_nerc', NULL, ARRAY['FCT','KOGI','NASARAWA','NIGER'], 'AEDC Region (multi-state) NERC Test Account -- real state coverage per Commission spreadsheet; will show partial data until meters.state uses real state names', true),
  ('jed_region_nerc',  '$2a$10$3KVYGxCTpOzHsgcAwN9sSOYu2lCAYt2e.4XaeoCKMaj4So2OHyUcG', 'user', 'state_nerc', NULL, ARRAY['PLATEAU','BAUCHI','BENUE','GOMBE'],  'JED Region (multi-state) NERC Test Account -- real state coverage per Commission spreadsheet; will show no data until meters.state uses real state names', true)
ON CONFLICT (username) DO UPDATE SET
  password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, account_type = EXCLUDED.account_type,
  disco = EXCLUDED.disco, states = EXCLUDED.states, full_name = EXCLUDED.full_name, is_active = true;

-- ---------------------------------------------------------------------------
-- 4. National NERC account (1) -- full overview access across all 6 DisCos.
-- ---------------------------------------------------------------------------
INSERT INTO app_users (username, password_hash, role, account_type, disco, states, full_name, is_active)
VALUES
  ('national_nerc', '$2a$10$jiPSLPiLllWYfXf9pZ9xQOVH8XveOfJ9Rm8lGYWynqpX7eg53ycva', 'user', 'nerc', NULL, NULL, 'National NERC Test Account', true)
ON CONFLICT (username) DO UPDATE SET
  password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, account_type = EXCLUDED.account_type,
  disco = EXCLUDED.disco, states = EXCLUDED.states, full_name = EXCLUDED.full_name, is_active = true;

COMMIT;

-- ---------------------------------------------------------------------------
-- Verify after running:
--   SELECT username, account_type, disco, states, full_name FROM app_users
--   WHERE username LIKE '%_user' OR username LIKE '%_nerc' ORDER BY account_type, username;
--
-- RECOMMENDED FOLLOW-UP (not run here -- a data decision, not a test-account
-- decision): normalize meters.state to real Nigerian state names so the
-- state_nerc feature means what it's supposed to mean. Based on what's been
-- confirmed in this conversation, that would be:
--   UPDATE meters SET state = 'EDO'     WHERE state = 'BENIN';
--   UPDATE meters SET state = 'PLATEAU' WHERE state = 'JOS';
--   UPDATE meters SET state = 'RIVERS'  WHERE state = 'PortHarcourt';
--   UPDATE meters SET state = 'ADAMAWA' WHERE state = 'YOLA';
-- (FCT needs no change.) After running that, re-run this file's accounts
-- section 2/3 with EDO/PLATEAU/RIVERS/ADAMAWA instead of the city names, or
-- ask for a follow-up version once you've decided whether to make this change.
-- ---------------------------------------------------------------------------
