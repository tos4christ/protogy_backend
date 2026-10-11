// feederType.js — NERC's 5-feeder-type taxonomy and the availability
// measurement rule that goes with it (per the Commission's letter on
// resolving feeder-availability-evaluation discrepancies, shared with
// Powertech/Protogy alongside the NESI feeder database):
//
//   Public      — serves many residential/commercial/industrial customers → LOAD
//   Commercial  — serves multiple commercial OR industrial customers      → LOAD
//   Dedicated   — serves one single customer, mostly always on but the     → VOLTAGE
//                 customer may not always be drawing (picking) load
//   Virtual     — 33kV network-extension (sling) feeder, may carry one     → VOLTAGE
//                 dedicated customer
//   Express     — same as Virtual, just a different DisCo's internal name  → VOLTAGE
//
//   Any COMBINATION of the above (e.g. "Public/Commercial",
//   "Dedicated/Commercial") is treated like a Public feeder → LOAD.
//
// The practical reading: Dedicated/Virtual/Express feeders can be fully
// energized (voltage present) while their one customer simply isn't
// consuming — that's not a DisCo supply failure, so availability for those
// has to be judged by whether the feeder is energized, not by whether
// current/load happens to be flowing at that moment. Public/Commercial
// feeders serve many customers at once, so aggregate load IS a reliable
// presence signal there (same role current-flow already played before this
// letter). A combination feeder carries general (public/commercial) load
// alongside whatever dedicated customer rides on it, so it's judged the
// same way as a pure Public feeder.

const FEEDER_TYPES = ['Public', 'Commercial', 'Dedicated', 'Virtual', 'Express'];

// Types whose availability is judged by voltage presence, not load/current.
// Only when the feeder is NOT a combination — any combination falls through
// to the 'load' default below, per the Commission's rule above.
const VOLTAGE_METRIC_TYPES = new Set(['Dedicated', 'Virtual', 'Express']);

// Normalizes one raw feeder_type value from the Commission's spreadsheet
// (inconsistent casing, and a few labels outside the official 5 — notably
// "Industrial", which the letter's own wording folds into Commercial:
// "serving multiple commercial OR industrial customers") into a canonical
// label, or a "A/B" combination of canonical labels. Unrecognised text is
// kept as-is (never silently dropped) so an import can flag it for review.
function normalizeFeederType(raw) {
  if (raw == null) return null;
  const str = String(raw).trim();
  if (!str) return null;
  const canon = (part) => {
    const u = part.trim().toUpperCase();
    if (u === 'PUBLIC') return 'Public';
    if (u === 'COMMERCIAL' || u === 'INDUSTRIAL') return 'Commercial';
    if (u === 'DEDICATED') return 'Dedicated';
    if (u === 'VIRTUAL') return 'Virtual';
    if (u === 'EXPRESS') return 'Express';
    return part.trim(); // unrecognised — preserved verbatim for review
  };
  return str.split('/').map(canon).join('/');
}

// Returns 'load' or 'voltage' for a (normalized) feeder_type. A combination
// (contains '/') or an unclassified/unknown feeder (null, or a label that
// didn't normalize to one of the 5) defaults to 'load' — i.e. today's
// existing current-flow-based calculation, so nothing changes for a feeder
// until it's actually classified.
function availabilityMetricFor(feederType) {
  if (!feederType) return 'load';
  const str = String(feederType).trim();
  if (str.includes('/')) return 'load';
  return VOLTAGE_METRIC_TYPES.has(str) ? 'voltage' : 'load';
}

module.exports = { FEEDER_TYPES, VOLTAGE_METRIC_TYPES, normalizeFeederType, availabilityMetricFor };
