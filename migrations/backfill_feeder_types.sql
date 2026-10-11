-- backfill_feeder_types.sql
-- Manual feeder_type backfill for the 19 existing Protogy-monitored feeders,
-- matched by hand against the Commission's FEEDER_DATABASE.xlsx (the bulk
-- feeder_registry join found 0 matches because the spreadsheet uses bare
-- disco codes (AEDC, BEDC, JED, PHED, YEDC) and official internal feeder
-- codes, while `meters` stores "AEDC (Abuja)" style discos and Protogy's
-- own shorthand feeder names).
-- regulator is 'NERC' for all 19 per the spreadsheet's FEEDER REGULATOR column.

UPDATE meters SET feeder_type = 'Public', regulator = 'NERC' WHERE meter_id = 'Meter-02';            -- 11KV_G4_FDR_5A
UPDATE meters SET feeder_type = 'Public', regulator = 'NERC' WHERE meter_id = 'Meter-01';            -- 11KV_G4_FDR_8A
UPDATE meters SET feeder_type = 'Public', regulator = 'NERC' WHERE meter_id = 'a2DheR-1';            -- EKEHUAN CAMPUS FDR
UPDATE meters SET feeder_type = 'Public', regulator = 'NERC' WHERE meter_id = 'a2DheR-2';            -- EKENWAN ROAD FDR
UPDATE meters SET feeder_type = 'Commercial', regulator = 'NERC' WHERE meter_id = '9bdcd-2';         -- IDSL Commercial Feeder
UPDATE meters SET feeder_type = 'Public', regulator = 'NERC' WHERE meter_id = '9bdcd-3';             -- Ogba Feeder
UPDATE meters SET feeder_type = 'Public', regulator = 'NERC' WHERE meter_id = '9bdcd-1';             -- Oko Feeder
UPDATE meters SET feeder_type = 'Public', regulator = 'NERC' WHERE meter_id = '9bdcd-4';             -- Riverside Feeder
UPDATE meters SET feeder_type = 'Public', regulator = 'NERC' WHERE meter_id = '4S7fYO-1';            -- COCA-COLA
UPDATE meters SET feeder_type = 'Public', regulator = 'NERC' WHERE meter_id = '4S7fYO-3';            -- DADIN KOWA
UPDATE meters SET feeder_type = 'Public/Commercial', regulator = 'NERC' WHERE meter_id = '4S7fYO-2'; -- INDUSTRIAL
UPDATE meters SET feeder_type = 'Dedicated', regulator = 'NERC' WHERE meter_id = '4S7fYO-4';         -- NASCO  <-- the one that actually changes behavior
UPDATE meters SET feeder_type = 'Public', regulator = 'NERC' WHERE meter_id = '3MFhV-1';             -- RUKUBA ROAD
UPDATE meters SET feeder_type = 'Public/Commercial', regulator = 'NERC' WHERE meter_id = '3MFhV-2';  -- WEST OF MINES
UPDATE meters SET feeder_type = 'Public', regulator = 'NERC' WHERE meter_id = 'def632f7a34b1b3c2';   -- AFAM_FDR
UPDATE meters SET feeder_type = 'Public', regulator = 'NERC' WHERE meter_id = 'def632f7a34b1b3c1';   -- RAILWAY_FDR
UPDATE meters SET feeder_type = 'Public', regulator = 'NERC' WHERE meter_id = '985457a1401f1d4e2';   -- ARHAN_KUNU_FDR
UPDATE meters SET feeder_type = 'Public', regulator = 'NERC' WHERE meter_id = '985457a1401f1d4e3';   -- MAIHA_ROAD_FDR
UPDATE meters SET feeder_type = 'Public', regulator = 'NERC' WHERE meter_id = '985457a1401f1d4e1';   -- MUBI_TOWN_FDR

-- Verify:
--   SELECT meter_id, feeder_name, disco, feeder_type, regulator FROM meters
--   WHERE status <> 'decommissioned' ORDER BY disco, feeder_name;
