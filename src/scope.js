// scope.js - server-side enforcement of account data scope (DisCo / State /
// full), used by both routes.js and nerc.js so authorization never depends
// on a client-supplied query param alone.
//
// Account types and what they resolve to:
//   protogy_admin, protogy_user, nerc  -> { kind: 'full' }           (no restriction)
//   disco                              -> { kind: 'disco', disco }   (one DisCo)
//   state_nerc                         -> { kind: 'state', states }  (1+ states)
//
// NERC's directive (item 5) requires that cross-DISCO/state access be
// prevented through "dashboard and data views, search and filtering, report
// generation, data download/export, API requests, [and] direct URL or
// record-ID manipulation" — not just hidden in the UI. This module is the
// single place that logic lives, so every caller gets it the same way.

const pool = require('./db');

function scopeOf(user) {
  if (!user) return { kind: 'none' };
  if (user.accountType === 'disco') return { kind: 'disco', disco: user.disco };
  if (user.accountType === 'state_nerc') return { kind: 'state', states: Array.isArray(user.states) ? user.states : [] };
  return { kind: 'full' };
}

// Builds a server-enforced disco/state WHERE fragment for list-style queries
// (feeder/meter lists, dashboards). Appends to `params`/`conds` (an array of
// SQL condition strings to be AND-joined by the caller) and returns the
// resolved scope, so the caller can also use it for response metadata.
//
// `reqState` - the client's requested ?state= value, if any; honoured only
// when it falls within the account's own assigned states (lets a multi-state
// State NERC account narrow to one of their states), otherwise the request
// is treated as an out-of-scope attempt and nothing in that state's data is
// returned. A 'disco' scope ignores any client ?disco= entirely - a DisCo
// account only ever has the one DisCo, so there is nothing legitimate to
// pick from the client side.
//
// `req.query.disco` is honoured for every OTHER scope kind:
//   - 'full' (protogy_admin/protogy_user/nerc): the client is free to pick
//     any DisCo, same as today's dropdown UX.
//   - 'state': a multi-state State NERC office can narrow its own view down
//     to one DisCo operating in their state(s). This is always ANDed with
//     the state restriction above, never instead of it, so it can only ever
//     narrow the result further - it can't be used to escape the account's
//     state scope (asking for a DisCo that doesn't operate in any of their
//     states just returns zero rows, never another state's data).
// Previously this function never looked at req.query.disco at all, so the
// Disco filter dropdown silently did nothing for every account type -
// selecting a DisCo sent ?disco=... to the server and the server just
// never read it.
function applyScope(req, conds, params, alias = '') {
  const col = (name) => (alias ? `${alias}.${name}` : name);
  const scope = scopeOf(req.user);
  const reqDisco = req.query.disco;

  if (scope.kind === 'disco') {
    params.push(scope.disco);
    conds.push(`${col('disco')} = $${params.length}`);
  } else if (scope.kind === 'state') {
    const reqState = req.query.state;
    if (!scope.states.length) {
      conds.push('1=0'); // account has no state assigned yet -> sees nothing, fail closed
    } else if (reqState && reqState !== 'all') {
      if (!scope.states.includes(reqState)) {
        conds.push('1=0'); // requested state outside this account's assignment
      } else {
        params.push(reqState);
        conds.push(`${col('state')} = $${params.length}`);
      }
    } else {
      params.push(scope.states);
      conds.push(`${col('state')} = ANY($${params.length})`);
    }
    if (reqDisco && reqDisco !== 'all') {
      params.push(reqDisco);
      conds.push(`${col('disco')} = $${params.length}`);
    }
  } else if (scope.kind === 'full' && reqDisco && reqDisco !== 'all') {
    params.push(reqDisco);
    conds.push(`${col('disco')} = $${params.length}`);
  }
  // 'none' adds no restriction here; it should never reach a list query in
  // practice since requireAuth runs first on every route.
  return scope;
}

// Guard for single-meter routes (/meters/:id, /meters/:id/readings, etc.).
// List-level filtering alone doesn't stop someone fetching a specific
// meter_id outside their scope directly by URL - this closes that gap.
async function requireMeterInScope(req, res, next) {
  const scope = scopeOf(req.user);
  if (scope.kind === 'full') return next();
  try {
    const id = req.params.id;
    const { rows } = await pool.query('SELECT disco, state FROM meters WHERE meter_id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'meter not found' });
    const m = rows[0];
    const allowed =
      (scope.kind === 'disco' && m.disco === scope.disco) ||
      (scope.kind === 'state' && scope.states.includes(m.state));
    if (!allowed) return res.status(403).json({ error: 'Not authorized for this feeder' });
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

module.exports = { scopeOf, applyScope, requireMeterInScope };
