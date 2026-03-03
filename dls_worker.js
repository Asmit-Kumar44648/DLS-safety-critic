// dls_worker.js — same DLS logic, small improvements for node counting
self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === 'run') {
    const start = performance.now();
    const result = runDLS(msg.state, msg.dt, msg.depth);
    const time_ms = performance.now() - start;
    self.postMessage({ type: 'result', safe: result.safe, counterexample: result.counterexample, time_ms, nodes: result.nodes });
  }
};

// Safety parameters
const SAFE_FRONT = 5.0;
const SAFE_REAR = 3.0;
const TTC_MIN = 1.5;

function propagateSimple(state, egoAction, neighborActions, dt) {
  const s = JSON.parse(JSON.stringify(state));
  const accelFromType = (t) => t === 'brake' ? -3.0 : (t === 'acc' ? 2.0 : 0.0);

  for (const k in neighborActions) {
    const a = accelFromType(neighborActions[k]);
    s[k].x = s[k].x + s[k].v * dt + 0.5 * a * dt * dt;
    s[k].v = Math.max(0, s[k].v + a * dt);
  }

  let a_e = 0;
  if (egoAction === 'acc') a_e = 2.0;
  else if (egoAction === 'brake') a_e = -2.0;
  if (egoAction === 'start_lc') {
    s.ego.lc_phase = (s.ego.lc_phase || 0) + 1;
    s.ego.lane = 1;
  }

  s.ego.x = s.ego.x + s.ego.v * dt + 0.5 * a_e * dt * dt;
  s.ego.v = Math.max(0, s.ego.v + a_e * dt);

  return s;
}

function isStateSafe(state) {
  const ego = state.ego;
  const checkVehicle = (veh) => {
    const gap = veh.x - ego.x;
    if (gap > 0) {
      if (gap < SAFE_FRONT) return { ok:false, reason:'front_gap' };
      if (ego.v > veh.v) {
        const rel = ego.v - veh.v;
        const ttc = gap / rel;
        if (ttc < TTC_MIN) return { ok:false, reason:'ttc_front' };
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
}

// DLS
const EGO_ACTIONS = ['keep','start_lc','acc','brake'];
const NEIGH_ACTIONS = ['brake','keep','acc'];

function runDLS(initialState, dt, depthMax) {
  const criticalKey = 'rear_target';
  const neighborPresent = !!initialState[criticalKey];
  let counterexample = null;
  let nodes = 0;

  function recurse(state, depth, trace) {
    nodes++;
    const chk = isStateSafe(state);
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
        if (!ok) return false;
      }
    }
    return true;
  }

  const ok = recurse(initialState, 0, [initialState]);
  return { safe: ok, counterexample: counterexample, nodes };
}
