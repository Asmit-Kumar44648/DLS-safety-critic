// app.js (module) — Updated: UI sliders -> worker params + safe scenario adjusted
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.153.0/build/three.module.js';

// CONFIG
const DT = 0.5;
const DEPTH = 4;
const SCALE = 0.42;
const ROAD_LENGTH = 220;

// GLOBALS
let scene, camera, renderer;
let cars = {};
let worker;
let replayTimer = null;
let replayState = null;
let replayStep = 0;
let playbackSpeed = 1.0;

// texture helper (procedural)
function makeCarTexture(primary = '#00c777', stripe = '#caffdf') {
  const w = 256, h = 128;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = primary; ctx.fillRect(0,0,w,h);
  ctx.fillStyle = stripe; ctx.fillRect(10,h/2-12,w-20,24);
  ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(16,12,w-32,32);
  ctx.fillStyle = '#111'; ctx.fillRect(w/2-36,h-28,72,14);
  ctx.fillStyle = '#fff'; ctx.font='12px Arial'; ctx.fillText('DEMO',w/2-18,h-18);
  return new THREE.CanvasTexture(c);
}
function createCarMesh(texture, width=2, height=1.4, length=4.6) {
  const geom = new THREE.BoxGeometry(length * SCALE, width * SCALE, height * SCALE);
  const mat = new THREE.MeshStandardMaterial({ map: texture, metalness: 0.25, roughness: 0.6 });
  return new THREE.Mesh(geom, mat);
}

// Scene init (same as before, simplified)
function initScene() {
  const container = document.getElementById('canvas-container'); container.innerHTML = '';
  scene = new THREE.Scene(); scene.background = new THREE.Color(0x071026);
  const width = container.clientWidth, height = Math.max(560, container.clientHeight);
  camera = new THREE.PerspectiveCamera(42, width/height, 0.1, 1000);
  camera.position.set(-8,36,36); camera.up.set(0,0,1); camera.lookAt(0,0,0);
  renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setSize(width, height); renderer.shadowMap.enabled = true;
  container.appendChild(renderer.domElement);
  const hemi = new THREE.HemisphereLight(0xffffff,0x080820,0.9); scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff,0.5); dir.position.set(-60,100,80); scene.add(dir);
  const planeGeom = new THREE.PlaneGeometry(ROAD_LENGTH * SCALE, 12 * SCALE);
  const planeMat = new THREE.MeshStandardMaterial({ color: 0x152330 });
  const road = new THREE.Mesh(planeGeom, planeMat); road.rotation.x = Math.PI/2; road.receiveShadow = true; scene.add(road);

  // dashed lines
  const lineMat = new THREE.LineBasicMaterial({ color: 0x93a6b8 });
  for (let i = -1; i <= 1; i += 2) {
    const dashGeom = new THREE.BufferGeometry(); const positions=[]
    for (let t = -ROAD_LENGTH/2; t < ROAD_LENGTH/2; t += 6) {
      positions.push((t)*SCALE,(i*1.5)*SCALE,0); positions.push((t+3)*SCALE,(i*1.5)*SCALE,0);
    }
    dashGeom.setAttribute('position', new THREE.Float32BufferAttribute(positions,3));
    const line = new THREE.LineSegments(dashGeom,lineMat); line.rotation.x=Math.PI/2; scene.add(line);
  }

  // cars
  const texG = makeCarTexture('#00c777','#bfffe0'); const texB = makeCarTexture('#789cff','#dbe9ff'); const texO = makeCarTexture('#ffb86b','#ffe6c2');
  cars.ego = createCarMesh(texG); cars.front_same = createCarMesh(texB); cars.rear_same = createCarMesh(texB); cars.front_target = createCarMesh(texO); cars.rear_target = createCarMesh(texO);
  Object.values(cars).forEach(m=>{ m.position.z = 0.8; scene.add(m); });

  const overlay = document.createElement('div'); overlay.className='canvas-overlay'; overlay.innerText='3D Top-down View'; container.appendChild(overlay);
  window.addEventListener('resize', onResize);
}

function onResize(){ const container=document.getElementById('canvas-container'); if(!renderer) return; renderer.setSize(container.clientWidth, Math.max(560,container.clientHeight)); camera.aspect = container.clientWidth/Math.max(560,container.clientHeight); camera.updateProjectionMatrix(); }

function toScenePos(long_m, laneIndex){ const laneOffset = (laneIndex===0)? -1.5 : 1.5; return new THREE.Vector3(long_m * SCALE, laneOffset * SCALE, 0.8); }
function placeCarsFromState(state){ Object.keys(cars).forEach(k=>{ if(!state[k]) return; const s = state[k]; const p = toScenePos(s.x, s.lane); cars[k].position.set(p.x,p.y,p.z); }); }

// Scenario templates: SAFE adjusted to be clearly safe under default params
function scenarioTemplate(name){
  if(name==='safe'){
    return {
      ego:{x:0,v:20,lane:0,lc_phase:0},
      front_same:{x:28,v:22,lane:0},
      rear_same:{x:-14,v:18,lane:0},
      front_target:{x:26,v:20,lane:1},
      rear_target:{x:-30,v:16,lane:1} // far behind -> safe
    };
  } else if(name==='borderline'){
    return {
      ego:{x:0,v:20,lane:0,lc_phase:0},
      front_same:{x:24,v:21,lane:0},
      rear_same:{x:-11,v:19,lane:0},
      front_target:{x:18,v:19,lane:1},
      rear_target:{x:-7,v:18,lane:1}
    };
  } else if(name==='cutin'){
    return {
      ego:{x:0,v:20,lane:0,lc_phase:0},
      front_same:{x:22,v:20,lane:0},
      rear_same:{x:-9,v:18,lane:0},
      front_target:{x:16,v:20,lane:1},
      rear_target:{x:-3,v:21,lane:1}
    };
  } else {
    // tiny NGSIM-like sample (first-frame)
    return {
      ego:{x:0,v:19.5,lane:0,lc_phase:0},
      front_same:{x:24,v:21.5,lane:0},
      rear_same:{x:-10,v:18.2,lane:0},
      front_target:{x:20,v:20.0,lane:1},
      rear_target:{x:-5,v:19.8,lane:1}
    };
  }
}

// UI wiring + worker start
function initUI() {
  document.getElementById('reset-btn').addEventListener('click', resetScene);
  document.getElementById('run-check-btn').addEventListener('click', runSafetyCheck);
  document.getElementById('scenario-select').addEventListener('change', resetScene);

  // sliders
  const front = document.getElementById('front-gap'), rear = document.getElementById('rear-gap'), ttc = document.getElementById('ttc-min'), lcDelay = document.getElementById('lc-delay');
  const frontVal = document.getElementById('front-val'), rearVal = document.getElementById('rear-val'), ttcVal = document.getElementById('ttc-val'), lcVal = document.getElementById('lc-delay-val');

  [front, rear, ttc, lcDelay].forEach(inp => inp.addEventListener('input', () => {
    frontVal.innerText = front.value; rearVal.innerText = rear.value; ttcVal.innerText = parseFloat(ttc.value).toFixed(1);
    lcVal.innerText = lcDelay.value;
  }));

  document.getElementById('playback-speed').addEventListener('input', (ev)=>{ playbackSpeed = parseFloat(ev.target.value); document.getElementById('speed-label').innerText = playbackSpeed.toFixed(2) + '×'; });
  document.getElementById('play-btn').addEventListener('click', ()=>{ if(replayState) startReplay(); });
  document.getElementById('pause-btn').addEventListener('click', pauseReplay);
}

function startWorker(){
  if(worker) worker.terminate();
  worker = new Worker('dls_worker.js');
  worker.onmessage = (ev) => {
    const msg = ev.data;
    const verdictElm = document.getElementById('verdict'); const timeElm = document.getElementById('time-ms'); const nodesElm = document.getElementById('nodes'); const traceOut = document.getElementById('trace-output');
    timeElm.innerText = msg.time_ms.toFixed(1); nodesElm.innerText = msg.nodes || '—';
    if(msg.safe){ verdictElm.innerText='SAFE ✓'; verdictElm.style.color='#8fffdc'; traceOut.innerText='No counterexample — all branches safe for horizon.'; replayState=null; }
    else { verdictElm.innerText='UNSAFE ✗'; verdictElm.style.color='#ff9b9b'; traceOut.innerText=JSON.stringify(msg.counterexample,null,2); replayState=msg.counterexample; replayStep=0; placeCarsFromState(replayState[0]); }
  };
}

function runSafetyCheck(){
  const state = currentState;
  if(!state) return;
  // gather UI params
  const params = {
    safeFront: parseFloat(document.getElementById('front-gap').value),
    safeRear: parseFloat(document.getElementById('rear-gap').value),
    ttcMin: parseFloat(document.getElementById('ttc-min').value),
    lcDelaySteps: parseInt(document.getElementById('lc-delay').value,10)
  };
  document.getElementById('verdict').innerText = 'Running…';
  worker.postMessage({ type:'run', state, dt:DT, depth:DEPTH, params });
}

// replay helpers
function startReplay(){ if(!replayState) return; pauseReplay(); replayTimer = setInterval(()=>{ replayStep++; if(replayStep>=replayState.length){ clearInterval(replayTimer); replayTimer=null; return; } placeCarsFromState(replayState[replayStep]); }, DT*1000 / playbackSpeed); }
function pauseReplay(){ if(replayTimer){ clearInterval(replayTimer); replayTimer=null; } }

// state and reset
let currentState = null;
function resetScene(){ const s = document.getElementById('scenario-select').value; currentState = scenarioTemplate(s); placeCarsFromState(currentState); document.getElementById('verdict').innerText='—'; document.getElementById('time-ms').innerText='—'; document.getElementById('nodes').innerText='—'; document.getElementById('trace-output').innerText='No counterexample yet.'; replayState=null; replayStep=0; pauseReplay(); }

// Render loop
function animate(){ requestAnimationFrame(animate); renderer.render(scene,camera); }

// start everything
function startApp(){ initScene(); initUI(); startWorker(); resetScene(); animate(); }
startApp();
