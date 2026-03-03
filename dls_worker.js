// dls_worker.js — accepts params from UI and uses them in safety checks
self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'run') {
    const { state, dt, depth, params } = msg;
    // set defaults if any missing
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

// DLS and safety functions (parameterized)
function propagateSimple(state, egoAction, neighborActions, dt) {
  const s = JSON.parse(JSON.stringify(state));
  const accelFromType = (t) => t === 'brake' ? -3.0 : (t === 'acc' ? 2.0 : 0.0);

  // update neighbors present in neighborActions
  for (const k in neighborActions) {
    const a = accelFromType(neighborActions[k]);
    s[k].x = s[k].x + s[k].v * dt + 0.5 * a * dt * dt;
    s[k].v = Math.max(0, s[k].v + a * dt);
  }

  let a_e = 0;
  if (egoAction === 'acc') a_e = 2.0;
  else if (egoAction === 'brake') a_e = -2.0;
  // lane-change handling: record lc_phase (we will respect delay externally)
  if (egoAction === 'start_lc') {
    s.ego.lc_phase = (s.ego.lc_phase || 0) + 1;
  }

  s.ego.x = s.ego.x + s.ego.v * dt + 0.5 * a_e * dt * dt;
  s.ego.v = Math.max(0, s.ego.v + a_e * dt);

  return s;
}

function isStateSafeFactory(params) {
  const SAFE_FRONT = params.safeFront;
  const SAFE_REAR = params.safeRear;
  const TTC_MIN = params.ttcMin;

  return function isStateSafe(state) {
    const ego = state.ego;
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

    const checkList = ['front_same','rear_same','front_target','rear_target'];
    for (const k of checkList) {
      if (!state[k]) continue;
      const res = checkVehicle(state[k]);
      if (!res.ok) return { ok:false, why: `${k}:${res.reason}` };
    }
    return { ok:true };
  };
}

// DLS core: parameterized by lcDelaySteps
const EGO_ACTIONS = ['keep','start_lc','acc','brake'];
const NEIGH_ACTIONS = ['brake','keep','acc'];

function runDLS(initialState, dt, depthMax, params) {
  const isStateSafe = isStateSafeFactory(params);
  const criticalKey = 'rear_target';
  const neighborPresent = !!initialState[criticalKey];
  let counterexample = null;
  let nodes = 0;

  // We need to treat lane-change occupancy delay: ego becomes lane=1 only when lc_phase >= lcDelaySteps
  const lcDelay = params.lcDelaySteps || 0;

  function recurse(state, depth, trace) {
    nodes++;
    // derive a state copy that respects lane-change delay: for safety checks, we consider ego occupying the target lane only if its lc_phase >= lcDelay
    const checkState = JSON.parse(JSON.stringify(state));
    if ((checkState.ego.lc_phase || 0) < lcDelay) {
      // if not yet reached delay steps, keep original lane (0), but mark lc_phase
      checkState.ego.lane = state.ego.lane === 1 && (state.ego.lc_phase || 0) >= lcDelay ? 1 : state.ego.lane;
    } else {
      // completed enough steps — ego occupies lane 1 (target)
      checkState.ego.lane = 1;
    }

    const chk = isStateSafe(checkState);
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
        // if we just did 'start_lc', increment lc_phase in next (propagateSimple already increments)
        // But we now decide when to flip lane for safety check using lcDelay
        const ok = recurse(next, depth + 1, trace.concat([next]));
        if (!ok) return false;
      }
    }
    return true;
  }

  const ok = recurse(initialState, 0, [initialState]);
  return { safe: ok, counterexample: counterexample, nodes };
}
