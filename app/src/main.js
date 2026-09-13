import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import './style.css';

// ---------- state ----------
let bones = [];            // {id,label,fma,region,regionLabel,group}
let boneMeshes = new Map(); // id -> mesh
let selected = null;
let learned = new Set(); // session-only, resets on refresh
try { localStorage.removeItem('osteo.learned'); } catch {} // clean up old persisted data
let currentRegion = 'all';
let raycaster = new THREE.Raycaster();
let pointerDown = null;

// ---------- three setup ----------
const canvas = document.getElementById('c3d');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setClearColor(0x0d1117);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
camera.position.set(0, 400, 1500);

// lights
scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x30281e, 1.15));
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(600, 900, 800);
scene.add(key);
const fill = new THREE.DirectionalLight(0xaebfff, 0.7);
fill.position.set(-700, 200, -600);
scene.add(fill);
const rim = new THREE.DirectionalLight(0x88ffe0, 0.35);
rim.position.set(0, -500, -900);
scene.add(rim);

// ground shadow-ish disc
const disc = new THREE.Mesh(
  new THREE.CircleGeometry(340, 48),
  new THREE.MeshBasicMaterial({ color: 0x161d29, transparent: true, opacity: 0.9 })
);
disc.rotation.x = -Math.PI / 2;
disc.position.y = -860;
scene.add(disc);

const skeleton = new THREE.Group();
scene.add(skeleton);

// ---------- colors ----------
const COLOR_BASE = new THREE.Color(0xe8e2d2);
const COLOR_DIM = new THREE.Color(0x5c6370);
const COLOR_HILI = new THREE.Color(0x36d1a0);
const COLOR_LEARNED = new THREE.Color(0x9db08f);

function boneMaterial() {
  return new THREE.MeshStandardMaterial({
    color: COLOR_BASE.clone(),
    roughness: 0.88,
    metalness: 0.03,
    side: THREE.DoubleSide,
  });
}

// ---------- load ----------
const loader = new GLTFLoader();
const [gltf, bonesData] = await Promise.all([
  loader.loadAsync('/skeleton.glb'),
  fetch('/bones.json').then(r => r.json()),
]);
bones = bonesData;

const bbox = new THREE.Box3();
for (const node of [...gltf.scene.children]) {
  if (!node.isMesh) continue;
  const id = parseInt(node.name.replace('fma', ''), 10);
  node.userData.boneId = id;
  node.material = boneMaterial();
  skeleton.add(node);
  boneMeshes.set(id, node);
  bbox.expandByObject(node);
}

// --- orientation detection ---
// BodyParts3D coords: find up axis by comparing skull (top) to calcaneus (bottom)
function centerOf(id) {
  const m = boneMeshes.get(id);
  if (!m) return null;
  const bb = new THREE.Box3().setFromObject(m);
  return bb.getCenter(new THREE.Vector3());
}
const skullC = centerOf(52734);   // frontal bone (top)
const heelC = centerOf(24498);    // left calcaneus (bottom)
let upAxis = 'y';
if (skullC && heelC) {
  const d = new THREE.Vector3().subVectors(skullC, heelC);
  upAxis = Math.abs(d.y) >= Math.abs(d.z) && Math.abs(d.y) >= Math.abs(d.x) ? 'y' : (Math.abs(d.z) >= Math.abs(d.x) ? 'z' : 'x');
}
// rotate so up-axis becomes +Y, front (+Z camera default) reasonable
if (upAxis === 'z') skeleton.rotation.x = -Math.PI / 2;   // +Z -> +Y
else if (upAxis === 'x') skeleton.rotation.z = Math.PI / 2; // +X -> +Y
skeleton.updateMatrixWorld(true);

// --- normalize scale: uniform, height -> 1600, feet on y=0 ---
const bbox2 = new THREE.Box3().setFromObject(skeleton);
const size2 = bbox2.getSize(new THREE.Vector3());
const scale = 1600 / size2.y;
const center2 = bbox2.getCenter(new THREE.Vector3());
skeleton.scale.setScalar(scale);
skeleton.position.set(-center2.x * scale, -bbox2.min.y * scale, -center2.z * scale);
skeleton.updateMatrixWorld(true);

// camera target mid-body
const target = new THREE.Vector3(0, 780, 0);

// ---------- controls: custom orbit (touch + mouse) ----------
let sph = { r: 2000, theta: Math.PI / 2, phi: Math.PI / 2 }; // phi: polar from +y
function applyCam() {
  sph.phi = Math.max(0.12, Math.min(Math.PI - 0.12, sph.phi));
  sph.r = Math.max(650, Math.min(3400, sph.r));
  camera.position.set(
    target.x + sph.r * Math.sin(sph.phi) * Math.sin(sph.theta),
    target.y + sph.r * Math.cos(sph.phi),
    target.z + sph.r * Math.sin(sph.phi) * Math.cos(sph.theta)
  );
  camera.lookAt(target);
}
applyCam();

// pan: move target along camera-right + world-up
const _panRight = new THREE.Vector3();
const _panUp = new THREE.Vector3(0, 1, 0);
function pan(dx, dy) {
  camera.getWorldDirection(_panRight); // forward
  _panRight.y = 0;
  _panRight.normalize();
  _panRight.cross(camera.up); // forward x up = camera-right
  const speed = sph.r * 0.0012;
  target.addScaledVector(_panRight, dx * speed);
  target.addScaledVector(_panUp, dy * speed);
  target.x = Math.max(-700, Math.min(700, target.x));
  target.y = Math.max(0, Math.min(1700, target.y));
  applyCam();
}

const active = new Map(); // active touch pointers
let dragMode = null; // 'rotate' | 'pan' | 'zoom' | null
let touchStart = null; // {x, y, t, lx, ly}
let intentDecided = false;
let pinchDist = 0; // last two-finger distance (0 = none)

function touchPairs() {
  const pts = [...active.values()];
  return Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
}

canvas.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse') {
    if (e.button === 0) {
      dragMode = 'rotate';
      pointerDown = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
    } else { // right or middle: pan
      dragMode = 'pan';
      pointerDown = { x: e.clientX, y: e.clientY, moved: false };
    }
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    hideHint();
    return;
  }
  // touch
  active.set(e.pointerId, [e.clientX, e.clientY]);
  if (active.size >= 2) {
    // two fingers: zoom ONLY. any single-finger intent is cancelled.
    dragMode = 'zoom';
    touchStart = null;
    pointerDown = null;
    intentDecided = true;
    pinchDist = touchPairs();
  } else if (active.size === 1) {
    dragMode = null;
    intentDecided = false;
    pinchDist = 0;
    touchStart = { x: e.clientX, y: e.clientY, t: performance.now(), lx: e.clientX, ly: e.clientY };
  }
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  hideHint();
});

canvas.addEventListener('pointermove', e => {
  if (e.pointerType === 'mouse') {
    if (!dragMode || !pointerDown) return;
    const dx = e.clientX - pointerDown.x, dy = e.clientY - pointerDown.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) pointerDown.moved = true;
    if (dragMode === 'rotate') {
      sph.theta -= dx * 0.0055;
      sph.phi -= dy * 0.0055;
    } else if (dragMode === 'pan') {
      // grab: cursor right -> skeleton follows right (target moves left)
      pan(-dx, dy);
    }
    pointerDown.x = e.clientX; pointerDown.y = e.clientY;
    applyCam();
    return;
  }

  // touch
  if (!active.has(e.pointerId)) return;
  active.set(e.pointerId, [e.clientX, e.clientY]);

  if (active.size === 2) {
    // ZOOM ONLY — no pan mixed in
    const d = touchPairs();
    if (pinchDist > 0 && d > 0) {
      sph.r *= pinchDist / d; // spread (d grows) -> r shrinks -> zoom IN; pinch together -> zoom OUT
      applyCam();
    }
    pinchDist = d;
    return;
  }
  if (active.size > 2) return;

  // single finger — intent detection: quick swipe = rotate, hold-then-drag = pan
  if (!touchStart) return;
  const totalDist = Math.hypot(e.clientX - touchStart.x, e.clientY - touchStart.y);
  const elapsed = performance.now() - touchStart.t;

  if (!intentDecided) {
    if (totalDist > 8 && elapsed < 260) {
      dragMode = 'rotate'; // moved soon: swipe
      intentDecided = true;
    } else if (elapsed >= 260) {
      dragMode = 'pan'; // held still: move-around mode locked
      intentDecided = true;
    } else {
      return; // still deciding
    }
  }

  const dx = e.clientX - touchStart.lx, dy = e.clientY - touchStart.ly;
  touchStart.lx = e.clientX; touchStart.ly = e.clientY;

  if (dragMode === 'rotate') {
    sph.theta -= dx * 0.0055;
    sph.phi -= dy * 0.0055;
    applyCam();
  } else if (dragMode === 'pan') {
    pan(-dx, dy); // grab: finger right -> skeleton follows right
  }
});

canvas.addEventListener('pointerup', e => {
  if (e.pointerType === 'mouse') {
    const tapPick = pointerDown && dragMode === 'rotate' && !pointerDown.moved
      && performance.now() - pointerDown.t < 400;
    if (tapPick) pick(e.clientX, e.clientY);
    dragMode = null; pointerDown = null;
    return;
  }
  // touch up
  const wasZoom = dragMode === 'zoom';
  const t0 = touchStart;
  const decided = intentDecided;
  active.delete(e.pointerId);
  pinchDist = 0;
  if (active.size === 0) {
    // tap = pick (quick, barely moved, never committed to a gesture)
    if (!wasZoom && t0 && !decided) {
      const dist = Math.hypot(e.clientX - t0.x, e.clientY - t0.y);
      const elapsed = performance.now() - t0.t;
      if (dist < 10 && elapsed < 350) pick(e.clientX, e.clientY);
    }
    dragMode = null; pointerDown = null; touchStart = null; intentDecided = false;
  } else if (active.size === 1) {
    // one finger remains after zoom: fresh undecided state for it
    dragMode = null; intentDecided = false;
    const only = [...active.values()][0];
    touchStart = { x: only[0], y: only[1], t: performance.now(), lx: only[0], ly: only[1] };
  }
});
canvas.addEventListener('pointercancel', e => {
  if (e.pointerType === 'touch') active.delete(e.pointerId);
  if (active.size === 0) { dragMode = null; pointerDown = null; touchStart = null; intentDecided = false; pinchDist = 0; }
});

canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  sph.r *= (1 + Math.sign(e.deltaY) * 0.09);
  applyCam();
}, { passive: false });

// ---------- picking ----------
function pick(cx, cy) {
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((cx - rect.left) / rect.width) * 2 - 1,
    -((cy - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects([...boneMeshes.values()], false);
  if (hits.length) {
    selectBone(hits[0].object.userData.boneId, hits[0].point);
  } else {
    selectBone(null);
  }
}

// ---------- selection + materials ----------
function applyRegionFilter() {
  for (const [id, mesh] of boneMeshes) {
    const b = bones.find(x => x.id === id);
    if (!b) continue;
    const inRegion = currentRegion === 'all' || b.region === currentRegion;
    const dim = currentRegion !== 'all' && !inRegion;
    mesh.material.color.copy(dim ? COLOR_DIM : (learned.has(id) ? COLOR_LEARNED : COLOR_BASE));
    mesh.userData.dimmed = dim;
  }
}

const labelLine = document.getElementById('label-line');
const labelTag = document.getElementById('label-tag');
const labelText = document.getElementById('label-text');
let labelAnchor = null;

function selectBone(id, hitPoint) {
  selected = id;
  for (const [bid, mesh] of boneMeshes) {
    const b = bones.find(x => x.id === bid);
    if (!b) continue;
    const inRegion = currentRegion === 'all' || b.region === currentRegion;
    let col;
    if (bid === id) col = COLOR_HILI;
    else if (currentRegion !== 'all' && !inRegion) col = COLOR_DIM;
    else if (learned.has(bid)) col = COLOR_LEARNED;
    else col = COLOR_BASE;
    mesh.material.color.copy(col);
    mesh.material.emissive = new THREE.Color(bid === id ? 0x0a4d38 : 0x000000);
  }
  if (id == null) {
    labelLine.hidden = true;
    labelTag.hidden = true;
    closeSheet();
    return;
  }
  const b = bones.find(x => x.id === id);
  labelText.textContent = b.label;
  labelTag.hidden = false;
  labelLine.hidden = false;
  // anchor at bone's screen-projected centroid, offset toward screen edge
  const mesh = boneMeshes.get(id);
  const bb = new THREE.Box3().setFromObject(mesh);
  labelAnchor = bb.getCenter(new THREE.Vector3());
  if (hitPoint) {
    // prefer picked point but bias outward from body center
    labelAnchor.copy(hitPoint);
  }
  openSheet(b);
  learned.add(id);
  updateProgress();
}

// ---------- label positioning ----------
function updateLabel() {
  if (!labelAnchor || selected == null) return;
  const v = labelAnchor.clone().project(camera);
  const rect = canvas.getBoundingClientRect();
  let x = (v.x * 0.5 + 0.5) * rect.width;
  let y = (-v.y * 0.5 + 0.5) * rect.height;
  // clamp label inside screen
  const pad = 14;
  const tagW = Math.max(120, labelText.textContent.length * 9 + 34);
  let lx = Math.max(pad, Math.min(rect.width - tagW - pad, x + 90));
  let ly = Math.max(pad, Math.min(rect.height - 64, y - 90));
  labelTag.style.left = lx + 'px';
  labelTag.style.top = ly + 'px';
  // leader line from anchor point to label
  const ax = Math.max(pad, Math.min(rect.width - pad, x));
  const ay = Math.max(pad, Math.min(rect.height - pad, y));
  const dx = lx - ax, dy = ly - ay;
  const len = Math.hypot(dx, dy);
  const ang = Math.atan2(dy, dx);
  labelLine.style.left = ax + 'px';
  labelLine.style.top = ay + 'px';
  labelLine.style.width = len + 'px';
  labelLine.style.transform = `rotate(${ang}rad)`;
  labelLine.style.transformOrigin = '0 0';
}

// ---------- UI: region bar ----------
const REGION_ORDER = ['all', 'skull', 'spine', 'thorax', 'shoulder', 'arm', 'hand', 'pelvis', 'leg', 'foot'];
const REGION_ICON = {
  all: 'All', skull: 'Skull', spine: 'Spine', thorax: 'Ribcage', shoulder: 'Shoulder',
  arm: 'Arm', hand: 'Hand', pelvis: 'Pelvis', leg: 'Leg', foot: 'Foot',
};
const regionbar = document.getElementById('regionbar');
function buildRegionbar() {
  regionbar.innerHTML = '';
  for (const r of REGION_ORDER) {
    const btn = document.createElement('button');
    btn.className = 'rchip' + (r === currentRegion ? ' active' : '');
    btn.textContent = REGION_ICON[r];
    btn.onclick = () => {
      currentRegion = r;
      selectBone(null);
      buildRegionbar();
      applyRegionFilter();
      // frame region
      if (r === 'all') { target.set(0, 780, 0); sph.r = 2000; }
      else {
        const meshes = bones.filter(b => b.region === r).map(b => boneMeshes.get(b.id)).filter(Boolean);
        const bb = new THREE.Box3();
        meshes.forEach(m => bb.expandByObject(m));
        const c = bb.getCenter(new THREE.Vector3());
        target.set(c.x, c.y, c.z);
        sph.r = Math.max(650, Math.min(3400, bb.getSize(new THREE.Vector3()).length() * 1.4));
      }
      applyCam();
    };
    regionbar.appendChild(btn);
  }
}

// ---------- progress ----------
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
function updateProgress() {
  const total = bones.length;
  const n = learned.size;
  progressBar.style.width = (100 * n / total) + '%';
  progressText.textContent = `${n} / ${total}`;
}

// ---------- bottom sheet ----------
const sheet = document.getElementById('sheet');
const sheetContent = document.getElementById('sheet-content');
function openSheet(b) {
  const isLearned = learned.has(b.id);
  const siblings = bones.filter(x => x.region === b.region).length;
  sheetContent.innerHTML = `
    <div class="sh-title">${b.label}</div>
    <div class="sh-sub">${b.regionLabel} · ${b.group}</div>
    <div class="sh-meta">
      <div class="chip">FMA ${b.id}</div>
      <div class="chip">${b.fma}</div>
    </div>
    <div class="sh-actions">
      <button class="sh-btn" id="sh-view">Zoom to bone</button>
      <button class="sh-btn ghost" id="sh-hide">Hide label</button>
    </div>
  `;
  sheet.classList.remove('hidden');
  requestAnimationFrame(() => sheet.classList.add('open'));
  document.getElementById('sh-view').onclick = () => {
    const mesh = boneMeshes.get(b.id);
    const bb = new THREE.Box3().setFromObject(mesh);
    const c = bb.getCenter(new THREE.Vector3());
    target.set(c.x, c.y, c.z);
    sph.r = Math.max(420, bb.getSize(new THREE.Vector3()).length() * 3.2);
    applyCam();
  };
  document.getElementById('sh-hide').onclick = () => selectBone(null);
}
function closeSheet() {
  sheet.classList.remove('open');
  setTimeout(() => sheet.classList.add('hidden'), 250);
}
document.getElementById('sheet-grip').addEventListener('click', closeSheet);

// ---------- list overlay ----------
const listOverlay = document.getElementById('list-overlay');
const listBody = document.getElementById('list-body');
const searchInput = document.getElementById('search-input');
const regionTabs = document.getElementById('region-tabs');
let listRegion = 'all';

function buildList() {
  const q = (searchInput.value || '').toLowerCase().trim();
  let items = bones;
  if (listRegion !== 'all') items = items.filter(b => b.region === listRegion);
  if (q) items = items.filter(b => b.label.toLowerCase().includes(q) || b.fma.toLowerCase().includes(q));
  const groups = new Map();
  for (const b of items) {
    if (!groups.has(b.group)) groups.set(b.group, []);
    groups.get(b.group).push(b);
  }
  let html = '';
  for (const [g, bs] of groups) {
    html += `<div class="lg-title">${g}</div>`;
    for (const b of bs) {
      const cl = learned.has(b.id) ? ' learned' : '';
      html += `<button class="litem${cl}" data-id="${b.id}">${b.label}<span class="lcheck">✓</span></button>`;
    }
  }
  listBody.innerHTML = html || '<div class="lg-empty">No bones match.</div>';
  listBody.querySelectorAll('.litem').forEach(el => {
    el.onclick = () => {
      closeList();
      selectBone(+el.dataset.id);
      const mesh = boneMeshes.get(+el.dataset.id);
      const bb = new THREE.Box3().setFromObject(mesh);
      const c = bb.getCenter(new THREE.Vector3());
      target.set(c.x, c.y, c.z);
      sph.r = Math.max(420, bb.getSize(new THREE.Vector3()).length() * 3.2);
      applyCam();
    };
  });
}
function buildTabs() {
  regionTabs.innerHTML = '';
  for (const r of REGION_ORDER) {
    const btn = document.createElement('button');
    btn.className = 'rtab' + (r === listRegion ? ' active' : '');
    btn.textContent = REGION_ICON[r];
    btn.onclick = () => { listRegion = r; buildTabs(); buildList(); };
    regionTabs.appendChild(btn);
  }
}
document.getElementById('btn-list').onclick = () => {
  listOverlay.classList.remove('hidden');
  buildTabs(); buildList(); searchInput.value = '';
  setTimeout(() => searchInput.focus(), 60);
};
document.getElementById('btn-search').onclick = () => {
  listOverlay.classList.remove('hidden');
  buildTabs(); buildList();
  setTimeout(() => searchInput.focus(), 60);
};
document.getElementById('list-close').onclick = closeList;
function closeList() { listOverlay.classList.add('hidden'); }
searchInput.addEventListener('input', buildList);

// ---------- quiz ----------
const quizOverlay = document.getElementById('quiz-overlay');
let quiz = null;
document.getElementById('btn-quiz').onclick = startQuiz;
document.getElementById('quiz-close').onclick = () => { quizOverlay.classList.add('hidden'); quiz = null; applyRegionFilter(); selectBone(null); };

function startQuiz() {
  quizOverlay.classList.remove('hidden');
  quiz = { i: 0, correct: 0, total: 0, pool: [...bones].sort(() => Math.random() - 0.5).slice(0, 15) };
  nextQuestion();
}
function nextQuestion() {
  if (!quiz) return;
  if (quiz.i >= quiz.pool.length) {
    document.getElementById('quiz-prompt').textContent = `Done! ${quiz.correct} / ${quiz.total} correct`;
    const ch2 = document.getElementById('quiz-choices');
    ch2.innerHTML = `<button class="qchoice" id="q-next">Next round →</button>`;
    document.getElementById('q-next').onclick = () => {
      quiz.pool = [...bones].sort(() => Math.random() - 0.5).slice(0, 15);
      quiz.i = 0; quiz.correct = 0; quiz.total = 0;
      nextQuestion();
    };
    document.getElementById('quiz-feedback').textContent = quiz.correct === quiz.total ? 'Perfect! 🦴' : 'Keep practicing!';
    return;
  }
  const answer = quiz.pool[quiz.i];
  // 3 decoys from same region if possible
  const decoyPool = bones.filter(b => b.id !== answer.id && b.region === answer.region).sort(() => Math.random() - 0.5).slice(0, 3);
  const decoys = decoyPool.length >= 3 ? decoyPool : [...bones].filter(b => b.id !== answer.id).sort(() => Math.random() - 0.5).slice(0, 3);
  const choices = [answer, ...decoys].sort(() => Math.random() - 0.5);
  document.getElementById('quiz-prompt').textContent = 'Which bone is highlighted?';
  document.getElementById('quiz-feedback').textContent = '';
  const ch = document.getElementById('quiz-choices');
  ch.innerHTML = choices.map(c => `<button class="qchoice" data-id="${c.id}">${c.label}</button>`).join('');
  ch.querySelectorAll('.qchoice').forEach(el => {
    el.onclick = () => answerQuiz(+el.dataset.id, answer.id, el);
  });
  // highlight bone
  for (const [bid, mesh] of boneMeshes) {
    mesh.material.color.copy(bid === answer.id ? COLOR_HILI : COLOR_DIM);
  }
  labelLine.hidden = true; labelTag.hidden = true;
  // frame it
  const mesh = boneMeshes.get(answer.id);
  const bb = new THREE.Box3().setFromObject(mesh);
  const c = bb.getCenter(new THREE.Vector3());
  target.set(c.x, c.y, c.z);
  sph.r = Math.max(520, bb.getSize(new THREE.Vector3()).length() * 3.4);
  applyCam();
}
function answerQuiz(picked, answerId, el) {
  if (!quiz) return;
  quiz.total++;
  const fb = document.getElementById('quiz-feedback');
  if (picked === answerId) {
    quiz.correct++;
    el.classList.add('right');
    fb.textContent = 'Correct!';
    fb.className = 'good';
    learned.add(answerId);
    updateProgress();
  } else {
    el.classList.add('wrong');
    document.getElementById('quiz-choices').querySelector(`[data-id="${answerId}"]`)?.classList.add('right');
    const ans = bones.find(b => b.id === answerId);
    fb.textContent = `It's the ${ans.label}`;
    fb.className = 'bad';
  }
  document.getElementById('quiz-score').textContent = `${quiz.correct} / ${quiz.total}`;
  document.querySelectorAll('.qchoice').forEach(b => b.disabled = true);
  setTimeout(() => { if (quiz) { quiz.i++; nextQuestion(); } }, 1100);
}

// ---------- view buttons ----------
function viewTo(theta, phi, r) { sph.theta = theta; sph.phi = phi; if (r) sph.r = r; applyCam(); }
document.getElementById('btn-front').onclick = () => viewTo(Math.PI / 2, Math.PI / 2.15);
document.getElementById('btn-back').onclick = () => viewTo(-Math.PI / 2, Math.PI / 2.15);
document.getElementById('btn-left-v').onclick = () => viewTo(Math.PI, Math.PI / 2.15);
document.getElementById('btn-right-v').onclick = () => viewTo(0, Math.PI / 2.15);
document.getElementById('btn-reset').onclick = () => { target.set(0, 780, 0); viewTo(Math.PI / 2, Math.PI / 2.2, 2000); };

// ---------- hint ----------
const hintEl = document.getElementById('hint');
function hideHint() { hintEl.classList.add('gone'); }

// ---------- resize ----------
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------- loop ----------
renderer.setAnimationLoop(() => {
  renderer.render(scene, camera);
  updateLabel();
});

// ---------- init ----------
buildRegionbar();
updateProgress();
window.__osteo = { scene, bones, boneMeshes, learned, THREE, skeleton, sph, target, camera };
const loadingEl = document.getElementById('loading');
loadingEl.classList.add('done');
setTimeout(() => loadingEl.remove(), 650);
