// app.js (module) — Enhanced visuals + playback + NGSIM sample loader
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.153.0/build/three.module.js';

// CONFIG
const DT = 0.5;
const DEPTH = 4;
const SCALE = 0.42;
const ROAD_LENGTH = 220;

// GLOBALS
let scene, camera, renderer, clock;
let cars = {};
let worker;
let replayTimer = null;
let replayState = null;
let replayStep = 0;
let replayPlaying = false;
let playbackSpeed = 1.0;

// Helper: make a procedural texture using canvas
function makeCarTexture(primary = '#00c777', stripe = '#ffffdd', plate = '#111111') {
  const w = 256, h = 128;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  // base
  ctx.fillStyle = primary; ctx.fillRect(0,0,w,h);
  // stripe
  ctx.fillStyle = stripe;
  ctx.fillRect(12,h/2 - 12, w-24, 24);
  // windows
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(18,14, w-36, 36);
  // plate
  ctx.fillStyle = plate;
  ctx.fillRect(w/2 - 40, h-28, 80, 14);
  ctx.fillStyle = '#fff';
  ctx.font = '12px Arial';
  ctx.fillText('DEMO', w/2 - 18, h-18);
  return new THREE.CanvasTexture(c);
}

function createCarMesh(texture, width=2, height=1.4, length=4.6) {
  const geom = new THREE.BoxGeometry(length * SCALE, width * SCALE, height * SCALE);
  const mat = new THREE.MeshStandardMaterial({ map: texture, metalness: 0.25, roughness: 0.6 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.castShadow = true;
  return mesh;
}

// SCENE INIT
function initScene() {
  const container = document.getElementById('canvas-container');
  container.innerHTML = '';
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x071026);

  const width = container.clientWidth;
  const height = Math.max(560, container.clientHeight);
  camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 1000);
  camera.position.set(-8, 36, 36);
  camera.up.set(0, 0, 1);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.shadowMap.enabled = true;
  container.appendChild(renderer.domElement);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x080820, 0.9);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 0.5);
  dir.position.set(-60, 100, 80); scene.add(dir);

  // road
  const roadWidth = 12;
  const planeGeom = new THREE.PlaneGeometry(ROAD_LENGTH * SCALE, roadWidth * SCALE);
  const planeMat = new THREE.MeshStandardMaterial({ color: 0x152330 });
  const road = new THREE.Mesh(planeGeom, planeMat);
  road.rotation.x = Math.PI / 2;
  road.receiveShadow = true;
  scene.add(road);

  // dashed lines
  const lineMat = new THREE.LineBasicMaterial({ color: 0x93a6b8 });
  for (let i = -1; i <= 1; i += 2) {
    const dashGeom = new THREE.BufferGeometry();
    const positions = [];
    for (let t = -ROAD_LENGTH/2; t < ROAD_LENGTH/2; t += 6) {
      positions.push((t)*SCALE, (i * 1.5)*SCALE, 0);
      positions.push((t+3)*SCALE, (i * 1.5)*SCALE, 0);
    }
    dashGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const line = new THREE.LineSegments(dashGeom, lineMat);
    line.rotation.x = Math.PI/2;
    scene.add(line);
  }

  // cars
  const texGreen = makeCarTexture('#00c777','#aaffcc','#052925');
  const texBlue = makeCarTexture('#789cff','#cfe4ff','#071330');
  const texOrange = makeCarTexture('#ffb86b','#ffe6c2','#2b1408');
  cars.ego = createCarMesh(texGreen);
  cars.front_same = createCarMesh(texBlue);
  cars.rear_same = createCarMesh(texBlue);
  cars.front_target = createCarMesh(texOrange);
  cars.rear_target = createCarMesh(texOrange);
  Object.values(cars).forEach(m => { m.position.z = 0.8; scene.add(m); });

  // overlay
  const overlay = document.createElement('div');
  overlay.className = 'canvas-overlay';
  overlay.innerText = '3D Top-down View';
  container.appendChild(overlay);

  window.addEventListener('resize', onResize);
}

// resize
function onResize() {
  const container = document.getElementById('canvas-container');
  if (!renderer) return;
  const width = container.clientWidth;
  const height = Math.max(560, container.clientHeight);
  renderer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

// mapping
function toScenePos(long_m, laneIndex) {
  const laneOffset = (laneIndex === 0) ? -1.5 : 1.5;
  return new THREE.Vector3(long_m * SCALE, laneOffset * SCALE, 0.8);
}

// place cars from state
function placeCarsFromState(state) {
  Object.keys(cars).forEach(k => {
    if (!state[k]) return;
    const s = state[k];
    const p = toScenePos(s.x, s.lane);
    cars[k].position.set(p.x, p.y, p.z);
  });
}

// SCENARIOS (including NGSIM embedded sample)
function scenarioTemplate(name) {
  if (name === 'safe') {
    return {
      ego:{x:0,v:20,lane:0,lc_phase:0},
      front_same:{x:28,v:22,lane:0},
      rear_same:{x:-14,v:18,lane:0},
      front_target:{x:25,v:20,lane:1},
      rear_target:{x:-22,v:16,lane:1}
    };
  } else if (name === 'borderline') {
    return {
      ego:{x:0,v:20,lane:0,lc_phase:0},
      front_same:{x:24,v:21,lane:0},
      rear_same:{x:-11,v:19,lane:0},
      front_target:{x:18,v:19,lane:1},
      rear_target:{x:-7,v:18,lane:1}
    };
  } else if (name === 'cutin') {
    return {
      ego:{x:0,v:20,lane:0,lc_phase:0},
      front_same:{x:22,v:20,lane:0},
      rear_same:{x:-9,v:18,lane:0},
      front_target:{x:16,v:20,lane:1},
      rear_target:{x:-3,v:21,lane:1}
    };
  } else { // ngsim_sample: a simple 3-frame recorded trajectory (approx.)
    // we will present the current frame as initial state and allow step playback via trace
    // Embedded mini-trajectory (meters, m/s) — 3 frames spaced at 0.5s
    const traj = {
      frames: [
        {
          ego:{x:0,v:19.5,lane:0,lc_phase:0},
          front_same:{x:24,v:21.5,lane:0},
          rear_same:{x:-10,v:18.2,lane:0},
          front_target:{x:20,v:20.0,lane:1},
          rear_target:{x:-5,v:19.8,lane:1}
        },
        {
          ego:{x:9.75,v:19.5,lane:0},
          front_same:{x:34.25,v:21.5,lane:0},
          rear_same:{x:-0.9,v:18.2,lane:0},
          front_target:{x:29.5,v:20.0,lane:1},
          rear_target:{x:1.4,v:19.8,lane:1}
        },
        {
          ego:{x:19.5,v:19.5,lane:0},
          front_same:{x:44.95,v:21.5,lane:0},
          rear_same:{x:9.7,v:18.2,lane:0},
          front_target:{x:39.0,v:20.0,lane:1},
          rear_target:{x:8.7,v:19.8,lane:1}
        }
      ]
    };
    // We'll use the first frame as initial
    return traj.frames[0];
  }
}

// UI init + worker
function initUI() {
  document.getElementById('reset-btn').addEventListener('click', resetScene);
  document.getElementById('run-check-btn').addEventListener('click', runSafetyCheck);
  document.getElementById('scenario-select').addEventListener('change', resetScene);
  document.getElementById('playback-speed').addEventListener('input', (ev)=>{
    playbackSpeed = parseFloat(ev.target.value);
    document.getElementById('speed-label').innerText = playbackSpeed.toFixed(2) + '×';
  });
  document.getElementById('play-btn').addEventListener('click', ()=>{ if (replayState) startReplay(); });
  document.getElementById('pause-btn').addEventListener('click', pauseReplay);
}

// worker start
function startWorker() {
  if (worker) worker.terminate();
  worker = new Worker('dls_worker.js');
  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (msg.type === 'result') {
      const verdictElm = document.getElementById('verdict');
      const timeElm = document.getElementById('time-ms');
      const nodesElm = document.getElementById('nodes');
      const traceOut = document.getElementById('trace-output');
      timeElm.innerText = msg.time_ms.toFixed(1);
      nodesElm.innerText = msg.nodes || '—';
      if (msg.safe) {
        verdictElm.innerText = 'SAFE ✓';
        verdictElm.style.color = '#8fffdc';
        traceOut.innerText = 'No counterexample — all branches safe for horizon.';
      } else {
        verdictElm.innerText = 'UNSAFE ✗';
        verdictElm.style.color = '#ff9b9b';
        traceOut.innerText = JSON.stringify(msg.counterexample, null, 2);
        replayState = msg.counterexample;
        replayStep = 0;
        // immediate animate first frame for clarity
        placeCarsFromState(replayState[0]);
      }
    }
  };
}

// run safety check
let currentState = null;
function runSafetyCheck() {
  const state = currentState;
  if (!state) return;
  document.getElementById('verdict').innerText = 'Running…';
  worker.postMessage({ type:'run', state, dt:DT, depth:DEPTH });
}

// reset scene
function resetScene() {
  const scenario = document.getElementById('scenario-select').value;
  currentState = scenarioTemplate(scenario);
  placeCarsFromState(currentState);
  document.getElementById('verdict').innerText = '—';
  document.getElementById('time-ms').innerText = '—';
  document.getElementById('nodes').innerText = '—';
  document.getElementById('trace-output').innerText = 'No counterexample yet.';
  replayState = null;
  replayStep = 0;
  pauseReplay();
}

// replay controls
function startReplay() {
  if (!replayState || replayState.length === 0) return;
  replayPlaying = true;
  pauseReplay(); // clear any existing
  replayTimer = setInterval(()=>{
    replayStep++;
    if (replayStep >= replayState.length) {
      clearInterval(replayTimer); replayTimer=null; replayPlaying=false; return;
    }
    placeCarsFromState(replayState[replayStep]);
  }, DT * 1000 / playbackSpeed);
}
function pauseReplay() {
  replayPlaying = false;
  if (replayTimer) { clearInterval(replayTimer); replayTimer=null; }
}

// animate loop
function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);
}

// Start app
function startApp(){
  initScene();
  initUI();
  startWorker();
  resetScene();
  animate();
}
startApp();
