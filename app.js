
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.153.0/build/three.module.js';

// ----- CONFIG -----
const DT = 0.5;        // seconds per step
const DEPTH = 4;       // depth -> horizon = DT * DEPTH (2.0s)
const SCALE = 0.4;     // visual scale (meters -> scene units)
const ROAD_LENGTH = 200; // scene length in meters (for visuals)

// ----- GLOBALS -----
let scene, camera, renderer, clock;
let cars = {}; // {ego, front_same, rear_same, front_target, rear_target}
let animId;
let worker;

// Helper: create a colored vehicle (box)
function createCarMesh(color = 0xffffff, width=2, height=1.4, length=4.5) {
  const geom = new THREE.BoxGeometry(length * SCALE, height * SCALE, width * SCALE);
  const mat = new THREE.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.7 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.castShadow = true;
  return mesh;
}

// Build the 3D scene (top-down view)
function initScene() {
  const container = document.getElementById('canvas-container');
  // remove old canvas if exists
  container.innerHTML = '';

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x071026);

  const width = container.clientWidth;
  const height = Math.max(520, container.clientHeight);
  camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
  camera.position.set(0, 40, 40);
  camera.up.set(0, 0, 1);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.shadowMap.enabled = true;
  container.appendChild(renderer.domElement);

  // lights
  const hemi = new THREE.HemisphereLight(0xffffff, 0x080820, 0.8);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 0.6);
  dir.position.set(-60, 100, 80);
  scene.add(dir);

  // road: two lanes (we draw long plane)
  const roadWidth = 12;
  const planeGeom = new THREE.PlaneGeometry(ROAD_LENGTH * SCALE, roadWidth * SCALE);
  const planeMat = new THREE.MeshStandardMaterial({ color: 0x1a2936 });
  const road = new THREE.Mesh(planeGeom, planeMat);
  road.rotation.x = Math.PI / 2;
  road.receiveShadow = true;
  scene.add(road);

  // lane lines
  const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 2 });
  for (let i = -1; i <= 1; i += 2) {
    const dashGeom = new THREE.BufferGeometry();
    const positions = [];
    for (let t = -ROAD_LENGTH/2; t < ROAD_LENGTH/2; t += 4) {
      positions.push((t)*SCALE, (i * 1.5)*SCALE, 0);
      positions.push((t+2)*SCALE, (i * 1.5)*SCALE, 0);
    }
    dashGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const line = new THREE.LineSegments(dashGeom, lineMat);
    line.rotation.x = Math.PI/2;
    scene.add(line);
  }

  // lane borders
  const borderMat = new THREE.LineBasicMaterial({ color: 0x8899aa });
  const borderGeom = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-ROAD_LENGTH/2*SCALE, -roadWidth/2*SCALE, 0.01),
    new THREE.Vector3(ROAD_LENGTH/2*SCALE, -roadWidth/2*SCALE, 0.01),
  ]);
  const border1 = new THREE.Line(borderGeom, borderMat); border1.rotation.x = Math.PI/2; scene.add(border1);
  const borderGeom2 = borderGeom.clone().translate(new THREE.Vector3(0, roadWidth*SCALE, 0));
  const border2 = new THREE.Line(borderGeom2, borderMat); border2.rotation.x = Math.PI/2; scene.add(border2);

  // create cars (will place by resetScene)
  cars.ego = createCarMesh(0x00c777);
  cars.front_same = createCarMesh(0x8da6ff);
  cars.rear_same = createCarMesh(0x8da6ff);
  cars.front_target = createCarMesh(0xffb86b);
  cars.rear_target = createCarMesh(0xffb86b);

  Object.values(cars).forEach(mesh => {
    mesh.position.z = 0.75;
    scene.add(mesh);
  });

  // overlay label
  const overlay = document.createElement('div');
  overlay.className = 'canvas-overlay';
  overlay.innerText = 'Top-down view';
  container.appendChild(overlay);

  // set initial camera controls (simple)
  window.addEventListener('resize', onResize);
}

// handle resize
function onResize() {
  const container = document.getElementById('canvas-container');
  if (!renderer) return;
  const width = container.clientWidth;
  const height = Math.max(520, container.clientHeight);
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

// Convert simulation meters -> scene coordinates (x:forward, y:lane lateral)
function toScenePos(longitudinal_m, laneIndex) {
  // laneIndex 0: left lane (ego start), 1: right lane (target lane)
  const laneOffset = (laneIndex === 0) ? -1.5 : 1.5; // meters lateral
  return new THREE.Vector3(longitudinal_m * SCALE, laneOffset * SCALE, 0.75);
}

// Place cars based on state object
function placeCarsFromState(state) {
  // state contains x (meters) and lane index for each
  const map = {
    ego: state.ego,
    front_same: state.front_same,
    rear_same: state.rear_same,
    front_target: state.front_target,
    rear_target: state.rear_target
  };
  Object.keys(map).forEach(k => {
    const s = map[k];
    const vec = toScenePos(s.x, s.lane);
    cars[k].position.set(vec.x, vec.y, vec.z);
  });
}

// Animate loop (simple)
function animate() {
  animId = requestAnimationFrame(animate);
  renderer.render(scene, camera);
}

// ----- SIMULATION STATE TEMPLATES -----
function scenarioTemplate(name) {
  // returns a state object with positions (x in meters), speed (m/s), lane (0-left/1-right)
  // Simplified placement: ego at x=0, target lane to the right (1)
  if (name === 'safe') {
    return {
      ego: { x: 0, v: 20, lane: 0, lc_phase: 0 },
      front_same: { x: 25, v: 22, lane: 0 },
      rear_same: { x: -12, v: 18, lane: 0 },
      front_target: { x: 22, v: 20, lane: 1 },
      rear_target: { x: -18, v: 16, lane: 1 }, // far behind -> safe
    };
  } else if (name === 'borderline') {
    return {
      ego: { x: 0, v: 20, lane: 0, lc_phase: 0 },
      front_same: { x: 26, v: 22, lane: 0 },
      rear_same: { x: -13, v: 19, lane: 0 },
      front_target: { x: 18, v: 19, lane: 1 },
      rear_target: { x: -6, v: 18, lane: 1 }, // close follower -> borderline
    };
  } else { // cutin aggressive
    return {
      ego: { x: 0, v: 20, lane: 0, lc_phase: 0 },
      front_same: { x: 20, v: 20, lane: 0 },
      rear_same: { x: -10, v: 18, lane: 0 },
      front_target: { x: 16, v: 20, lane: 1 },
      rear_target: { x: -3, v: 21, lane: 1 }, // close & faster -> dangerous
    };
  }
}

// ----- UI & Worker logic -----
function initUI() {
  document.getElementById('reset-btn').addEventListener('click', resetScene);
  document.getElementById('run-check-btn').addEventListener('click', runSafetyCheck);
  document.getElementById('scenario-select').addEventListener('change', resetScene);
}

// Prepare and start the web worker
function startWorker() {
  if (worker) worker.terminate();
  worker = new Worker('dls_worker.js');
  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.type === 'result') {
      const verdictElm = document.getElementById('verdict');
      const timeElm = document.getElementById('time-ms');
      const traceOut = document.getElementById('trace-output');
      timeElm.innerText = msg.time_ms.toFixed(1);
      if (msg.safe) {
        verdictElm.innerText = 'SAFE ✓';
        verdictElm.style.color = '#7fffcc';
        traceOut.innerText = 'No counterexample — all branches safe for horizon.';
      } else {
        verdictElm.innerText = 'UNSAFE ✗';
        verdictElm.style.color = '#ff7b7b';
        traceOut.innerText = JSON.stringify(msg.counterexample, null, 2);
        // animate the counterexample
        animateCounterexample(msg.counterexample);
      }
    }
  };
}

// Run safety check: package current state, send to worker
function runSafetyCheck() {
  const scenario = document.getElementById('scenario-select').value;
  const state = currentState; // defined in resetScene
  // worker expects state, dt, depth
  document.getElementById('verdict').innerText = 'Running…';
  worker.postMessage({ type: 'run', state, dt: DT, depth: DEPTH });
}

// animate a counterexample sequence (simple step replay)
let replayTimer = null;
function animateCounterexample(trace) {
  // trace: array of states at each time step for the counterexample
  if (!Array.isArray(trace) || trace.length === 0) return;
  let step = 0;
  if (replayTimer) clearInterval(replayTimer);
  // Place cars at first frame before starting
  placeCarsFromState(trace[0]);
  replayTimer = setInterval(() => {
    step++;
    if (step >= trace.length) {
      clearInterval(replayTimer);
      replayTimer = null;
      return;
    }
    placeCarsFromState(trace[step]);
  }, DT * 1000); // play at real time
}

// reset scene using selected scenario
let currentState = null;
function resetScene() {
  const scenario = document.getElementById('scenario-select').value;
  currentState = scenarioTemplate(scenario);
  placeCarsFromState(currentState);
  document.getElementById('verdict').innerText = '—';
  document.getElementById('verdict').style.color = '#fff';
  document.getElementById('time-ms').innerText = '—';
  document.getElementById('trace-output').innerText = 'No counterexample yet.';
}

// Initialize everything
function startApp() {
  initScene();
  initUI();
  startWorker();
  resetScene();
  animate();
}

startApp();
