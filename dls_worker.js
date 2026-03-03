// dls_worker.js
// Web Worker implementing a depth-limited safety check
self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'run') {
    const start = performance.now();
    const result = runDLS(msg.state, msg.dt, msg.depth);
    const time_ms = performance.now() - start;
    self.postMessage({ type: 'result', safe: result.safe, counterexample: result.counterexample, time_ms });
  }
};

// ---------- Simple kinematics and safety check ----------
// We use 1D longitudinal kinematics per lane.
// State shape: { ego:{x,v,lane,lc_phase}, front_target:{x,v,lane}, rear_target:..., front_same, rear_same }
const SAFE_FRONT = 5.0; // m
const SAFE_REAR = 3.0;  // m
const TTC_MIN = 1.5;    // s

function propagateSimple(state, egoAction, neighborActions, dt) {
  // clone
  const s = JSON.parse(JSON.stringify(state));
  // actions: egoAction = {type: 'keep'|'acc'|'brake'|'start_lc'|'continue_lc'|'abort'} (we simplify)
  // neighborActions: object, e.g., { rear_target: 'brake'|'keep'|'acc' }

  // helper to apply accel types to numeric accel
  const accelFromType = (t) => {
    if (t === 'brake') return -3.0;
    if (t === 'acc') return 2.0;
    return 0.0;
  };

  // Update neighbors (we only apply to critical ones present in neighborActions)
  for (const k in neighborActions) {
    const act = neighborActions[k];
    const a = accelFromType(act);
    s[k].x = s[k].x + s[k].v * dt + 0.5 * a * dt * dt;
    s[k].v = Math.max(0, s[k].v + a * dt);
  }

  // Update ego based on egoAction (only change lane when start_lc and we simulate lane change as immediate occupancy of both lanes for duration)
  let a_e = 0;
  if (egoAction === 'acc') a_e = 2.0;
  else if (egoAction === 'brake') a_e = -2.0;
  // lane change handling (we model lane change as setting lane to target lane after T_LC steps in the caller, for simplicity here we toggle if start_lc)
  if (egoAction === 'start_lc') {
    // set lc_phase flag to 1 to indicate in progress; store desired lane as 1 (target)
    s.ego.lc_phase = (s.ego.lc_phase || 0) + 1;
    if (s.ego.lc_phase >= 1) {
      // for visualization simplicity we set lane to 1 immediately but treat occupancy rules in safety check
      s.ego.lane = 1; // will be checked for safety (we treat it as occupying both lanes logically)
    }
  } else {
    // keep lane or continue
  }

  s.ego.x = s.ego.x + s.ego.v * dt + 0.5 * a_e * dt * dt;
  s.ego.v = Math.max(0, s.ego.v + a_e * dt);

  return s;
}

function isStateSafe(state) {
  // For each lane, check front/rear relationships for ego
  // We treat cars in the same lane or when ego in lc_phase as occupying both lanes
  const ego = state.ego;

  // helper compute gap & TTC between ego and another vehicle if they are in same lane OR ego in lane change (we're conservative)
  const checkVehicle = (veh) => {
    const gap = veh.x - ego.x;
    // if veh is ahead (gap>0)
    if (gap > 0) {
      if (gap < SAFE_FRONT) return { ok:false, reason: 'front_gap' };
      if (ego.v > veh.v) {
        const rel = ego.v - veh.v;
        const ttc = gap / rel;
        if (ttc < TTC_MIN) return { ok:false, reason: 'ttc_front' };
      }
    } else { // vehicle behind
      const gapRear = ego.x - veh.x;
      if (gapRear < SAFE_REAR) return { ok:false, reason: 'rear_gap' };
    }
    return { ok:true };
  };

  // check cars designated as important
  const checkList = ['front_same','rear_same','front_target','rear_target'];
  for (const k of checkList) {
    if (!state[k]) continue;
    const res = checkVehicle(state[k]);
    if (!res.ok) return { ok:false, why: `${k}:${res.reason}` };
  }
  return { ok:true };
}

// ---------- Depth-Limited Search (DLS) ----------
// We will branch only on ego actions (small set) and on a small neighbor action set for critical neighbor(s).
const EGO_ACTIONS = ['keep','start_lc','acc','brake'];
const NEIGH_ACTIONS = ['brake','keep','acc']; // for critical neighbors

function runDLS(initialState, dt, depthMax) {
  // For tractability, only branch on the single critical neighbor "rear_target" (follower in target lane)
  // If not present, neighborActions is empty.
  const criticalKey = 'rear_target';
  const neighborPresent = !!initialState[criticalKey];

  // recursion
  const visited = new Map(); // optional memoization (not used heavily here)
  let counterexample = null;
  let nodes = 0;

  function recurse(state, depth, trace) {
    nodes++;
    // Check safety immediately
    const chk = isStateSafe(state);
    if (!chk.ok) {
      counterexample = trace.slice(); // record trace
      return false; // unsafe branch found
    }
    if (depth >= depthMax) {
      return true; // branch safe up to horizon
    }

    // iterate ego actions
    for (const egoA of EGO_ACTIONS) {
      // Build neighbor combos (only critical neighbor)
      const neighborCombos = neighborPresent ? NEIGH_ACTIONS : ['none'];
      for (const neighA of neighborCombos) {
        // create neighborActions object
        const neighObj = {};
        if (neighA !== 'none') neighObj[criticalKey] = neighA;

        const next = propagateSimple(state, egoA, neighObj, dt);
        const nextTrace = trace.concat([next]);
        const ok = recurse(next, depth + 1, nextTrace);
        if (!ok) return false; // unwind early: found unsafe
      }
    }
    return true; // all combos safe
  }

  // start recursion
  const ok = recurse(initialState, 0, [initialState]);
  return { safe: ok, counterexample: counterexample, nodes };
}
