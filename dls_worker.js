// dls_worker.js  (REPLACE your existing worker with this exact file)
// Accepts { state, dt, depth, params } messages from main thread
// Returns { type:'result', safe, counterexample, time_ms, nodes }

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'run') {
    const { state, dt, depth, params } = msg;
    const safeFront = (params && params.safeFront) ? params.safeFront : 5.0;
    const safeRear = (params && params.safeRear) ? params.safeRear : 3.0;
    const ttcMin = (params && params.ttcMin) ? params.ttcMin : 1.5;
    const lcDelaySteps = (params && typeof params.lcDelaySteps === 'number') ? params.lcDelaySteps : 1;

    const start = performance.now();
    const result = runDLS(state, dt, depth, { safeFront, safeRear, ttcMin, lcDelaySteps });
    const time_ms = performance.now() - start;
    self.postMessage({ type: 'result', safe: result.safe, counterexample: result.counterexample, time_ms, nodes: result.nodes });
  }
};

// ---------- Propagation ----------
// Simple 1D kinematics update for demo purposes
function propagateSimple(state, egoAction, neighborActions, dt) {
  const s = JSON.parse(JSON.stringify(state));
  const accelFromType = (t) => t === 'brake' ? -3.0 : (t === 'acc' ? 2.0 : 0.0);

  // update neighbors present in neighborActions (only those keys)
  for (const k in neighborActions) {
    if (!s[k]) continue;
    const a = accelFromType(neighborActions[k]);
    s[k].x = s[k].x + s[k].v * dt + 0.5 * a * dt * dt;
    s[k].v = Math.max(0, s[k].v + a * dt);
  }

  // ego accel
  let a_e = 0;
  if (egoAction === 'acc') a_e = 2.0;
  else if (egoAction === 'brake') a_e = -2.0;

  // start lane-change increments lc_phase but we will only flip occupancy in the safety check (based on lcDelay)
  if (egoAction === 'start_lc') {
    s.ego.lc_phase = (s.ego.lc_phase || 0) + 1;
  }

  s.ego.x = s.ego.x + s.ego.v * dt + 0.5 * a_e * dt * dt;
  s.ego.v = Math.max(0, s.ego.v + a_e * dt);

  return s;
}

// ---------- Lane-aware safety checker factory ----------
// Takes parameters (safeFront, safeRear, ttcMin) and returns an isStateSafe(state, egoOccupiesBoth)
// Note: egoOccupiesBoth indicates whether ego should be treated as occupying both lanes (during LC overlap)
function makeIsStateSafe(params) {
  const SAFE_FRONT = params.safeFront;
  const SAFE_REAR = params.safeRear;
  const TTC_MIN = params.ttcMin;

  return function isStateSafe(state, egoOccupiesBoth) {
    const ego = state.ego;

    // helper: check a particular vehicle if it is in an occupied lane by ego
    const checkVehicle = (veh) => {
      const gap = veh.x - ego.x;
      if (gap > 0) {
        if (gap < SAFE_FRONT) return { ok:false, reason:'front_gap' };
        if (ego.v > veh.v) {
          const rel = ego.v - veh.v;
          if (rel > 0) {
            const ttc = gap / rel;
            if (ttc < TTC_MIN) return { ok:false, reason:'ttc_front' };
          }
        }
      } else {
        const gapRear = ego.x - veh.x;
        if (gapRear < SAFE_REAR) return { ok:false, reason:'rear_gap' };
      }
      return { ok:true };
    };

    // Only check vehicles that are in the same lane as ego OR, if egoOccupiesBoth is true, check both lanes (treat any vehicle in either lane as relevant)
    const checkList = ['front_same','rear_same','front_target','rear_target'];
    for (const k of checkList) {
      const veh = state[k];
      if (!veh) continue;

      // Decide whether this vehicle should be considered for safety checks:
      // - If egoOccupiesBoth is true => check all vehicles (both lanes)
      // - Else only check vehicles whose vehicle.lane === ego.lane
      if (!egoOccupiesBoth && (veh.lane !== ego.lane)) {
        // skip vehicle in other lane if ego does not occupy it
        continue;
      }

      const res = checkVehicle(veh);
      if (!res.ok) return { ok:false, why: `${k}:${res.reason}` };
    }

    return { ok:true };
  };
}

// ---------- DLS (depth-limited search) ----------
// branching sets
const EGO_ACTIONS = ['keep','start_lc','acc','brake'];
const NEIGH_ACTIONS = ['brake','keep','acc'];

function runDLS(initialState, dt, depthMax, params) {
  const isStateSafe = makeIsStateSafe(params);
  const criticalKey = 'rear_target';
  const neighborPresent = !!initialState[criticalKey];

  let counterexample = null;
  let nodes = 0;

  const lcDelay = params.lcDelaySteps || 0;

  // We will treat ego as occupying both lanes only when its lc_phase >= lcDelay.
  // In each recursion, derive egoOccupiesBoth from current state's lc_phase.
  function recurse(state, depth, trace) {
    nodes++;

    const egoLcPhase = state.ego.lc_phase || 0;
    const egoOccupiesBoth = (egoLcPhase >= lcDelay);

    // run lane-aware safety check
    const chk = isStateSafe(state, egoOccupiesBoth);
    if (!chk.ok) {
      counterexample = trace.slice();
      return false;
    }

    if (depth >= depthMax) return true;

    for (const egoA of EGO_ACTIONS) {
      const neighborCombos = neighborPresent ? NEIGH_ACTIONS : ['none'];
      for (const neighA of neighborCombos) {
        const neighObj = {};
        if (neighA !== 'none') neighObj[criticalKey] = neighA;
        const next = propagateSimple(state, egoA, neighObj, dt);
        const ok = recurse(next, depth + 1, trace.concat([next]));
        if (!ok) return false; // early exit on found unsafe branch
      }
    }
    return true;
  }

  const ok = recurse(initialState, 0, [initialState]);
  return { safe: ok, counterexample: counterexample, nodes };
}
