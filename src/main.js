// main.js — Lighthaul: a relativistic courier game.
//
// Built on the SpaceRelativity engine (same shaders/audio/textures). The game
// layer turns the twin paradox into an economy:
//   * Fuel is Δv measured in RAPIDITY (φ = atanh β) — the proper delta-v of an
//     ideal rocket. Pushing toward c costs divergingly more, and you have to
//     budget the braking burn too.
//   * Cargo deadlines run on UNIVERSE time  -> fly fast on average.
//   * Passenger aging runs on SHIP time     -> keep γ high to keep them young.
//   * The pilot ages on ship time and retires at 68 — your life is the one
//     non-renewable resource. Slow cruising is cheap in fuel and ruinous in years.
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import {
  C_CAP, lorentz, aberrateDir,
  STAR_VERT, STAR_FRAG, GALAXY_VERT, GALAXY_FRAG, CMB_VERT, CMB_FRAG,
} from "./relativity.js";
import { makeGalaxyAtlas } from "./textures.js";
import { createAudio } from "./audio.js";

// ---------------------------------------------------------------------------
// Renderer / scene / camera
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setClearColor(0x000206, 1);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.85;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.1, 100000);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new OutputPass());

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
const START_AGE = 28;
const RETIRE_AGE = 68;
const TANK = 26;              // Δv budget in rapidity units
const FUEL_PRICE = 12;        // credits per rapidity unit
const DOCK_RADIUS = 15;       // ly
const DOCK_BETA = 0.2;

const game = {
  phase: "title",             // title | station | flight | results | over
  credits: 400,
  fuel: TANK,
  pilotAge: START_AGE,
  deliveries: 0,
  failures: 0,
  earned: 0,
  station: 0,
  offers: [],
  contract: null,
  lastResult: null,
};

const ship = {
  pos: new THREE.Vector3(),
  quat: new THREE.Quaternion(),
  throttle: 0,
  beta: 0,
  shipTime: 0,   // cumulative ship-clock years (drives pilot age)
  coordTime: 0,  // cumulative universe years (drives deadlines)
};

// Pilot-frame pacing (as in SpaceRelativity): each real second advances the
// ship clock ~PROPER_RATE years; universe time & distance scale with γ
// (soft-capped) — length contraction made real.
const PROPER_RATE = 0.4;
const GAMMA_CAP = 40;

function throttleToBeta(t) {
  t = Math.max(0, Math.min(1, t));
  return Math.min(1 - Math.pow(1 - t, 3), C_CAP);
}
function betaToThrottle(b) {
  return 1 - Math.cbrt(1 - Math.min(b, C_CAP));
}
const rapidity = (b) => Math.atanh(Math.min(b, C_CAP));

// ---------------------------------------------------------------------------
// Star layers (engine copy)
// ---------------------------------------------------------------------------
function makeStarLayer({ count, cell, tempFn, brightFn, sizeMul, scale }) {
  const positions = new Float32Array(count * 3);
  const temps = new Float32Array(count);
  const brights = new Float32Array(count);
  const sizes = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    positions[i * 3 + 0] = (Math.random() - 0.5) * cell;
    positions[i * 3 + 1] = (Math.random() - 0.5) * cell;
    positions[i * 3 + 2] = (Math.random() - 0.5) * cell;
    temps[i] = tempFn();
    brights[i] = brightFn();
    sizes[i] = 0.6 + Math.random() * 0.9;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("aTemp", new THREE.BufferAttribute(temps, 1));
  geo.setAttribute("aBright", new THREE.BufferAttribute(brights, 1));
  geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), cell * 4);

  const uniforms = {
    uShipPos: { value: ship.pos },
    uForward: { value: new THREE.Vector3(0, 0, -1) },
    uBeta: { value: 0 },
    uGamma: { value: 1 },
    uCell: { value: cell },
    uSizeMul: { value: sizeMul },
    uScale: { value: scale },
    uPixelRatio: { value: renderer.getPixelRatio() },
    uWarp: { value: 0 },
    uFxAberration: { value: 1 },
    uFxDoppler: { value: 1 },
    uFxBeaming: { value: 1 },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, vertexShader: STAR_VERT, fragmentShader: STAR_FRAG,
    transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  scene.add(points);
  const setDensity = (d) => geo.setDrawRange(0, Math.floor(count * Math.max(0, Math.min(1, d))));
  return { points, uniforms, setDensity };
}

function stellarTemp() {
  const r = Math.random();
  if (r < 0.74) return 2600 + Math.random() * 1600;
  if (r < 0.92) return 4200 + Math.random() * 2200;
  if (r < 0.985) return 6400 + Math.random() * 3600;
  return 10000 + Math.random() * 18000;
}

const nearStars = makeStarLayer({
  count: 28000, cell: 70,
  tempFn: stellarTemp,
  brightFn: () => 0.35 + Math.random() * 0.65,
  sizeMul: 2.4, scale: 26,
});
const farStars = makeStarLayer({
  count: 7000, cell: 900,
  tempFn: () => 3200 + Math.random() * 4200,
  brightFn: () => 0.08 + Math.random() * 0.25,
  sizeMul: 3.5, scale: 70,
});
nearStars.setDensity(0.62);
farStars.setDensity(0.28);

const galaxyAtlas = makeGalaxyAtlas(1024);
function makeGalaxyLayer({ count, cell, sizeMul, scale }) {
  const positions = new Float32Array(count * 3);
  const brights = new Float32Array(count);
  const sizes = new Float32Array(count);
  const tiles = new Float32Array(count);
  const angles = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    positions[i * 3 + 0] = (Math.random() - 0.5) * cell;
    positions[i * 3 + 1] = (Math.random() - 0.5) * cell;
    positions[i * 3 + 2] = (Math.random() - 0.5) * cell;
    brights[i] = 0.55 + Math.random() * 0.45;
    sizes[i] = (Math.random() < 0.12 ? 2.6 : 1.0) * (0.7 + Math.random() * 0.8);
    tiles[i] = Math.floor(Math.random() * 4);
    angles[i] = Math.random() * Math.PI * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("aBright", new THREE.BufferAttribute(brights, 1));
  geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute("aTile", new THREE.BufferAttribute(tiles, 1));
  geo.setAttribute("aAngle", new THREE.BufferAttribute(angles, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), cell * 4);
  const uniforms = {
    uShipPos: { value: ship.pos },
    uForward: { value: new THREE.Vector3(0, 0, -1) },
    uBeta: { value: 0 }, uGamma: { value: 1 },
    uCell: { value: cell }, uSizeMul: { value: sizeMul },
    uScale: { value: scale }, uPixelRatio: { value: renderer.getPixelRatio() },
    uWarp: { value: 0 },
    uFxAberration: { value: 1 }, uFxDoppler: { value: 1 }, uFxBeaming: { value: 1 },
    uAtlas: { value: galaxyAtlas },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, vertexShader: GALAXY_VERT, fragmentShader: GALAXY_FRAG,
    transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  scene.add(points);
  return { points, uniforms };
}
const galaxies = makeGalaxyLayer({ count: 110, cell: 1100, sizeMul: 220, scale: 90 });

const layers = [farStars, nearStars, galaxies];

// CMB skybox
const cmbUniforms = {
  uForward: { value: new THREE.Vector3(0, 0, -1) },
  uBeta: { value: 0 }, uGamma: { value: 1 }, uGain: { value: 0.5 },
};
const cmb = new THREE.Mesh(
  new THREE.SphereGeometry(9000, 48, 32),
  new THREE.ShaderMaterial({
    uniforms: cmbUniforms, vertexShader: CMB_VERT, fragmentShader: CMB_FRAG,
    side: THREE.BackSide, transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.AdditiveBlending,
  })
);
cmb.frustumCulled = false;
cmb.renderOrder = -10;
scene.add(cmb);

// ---------------------------------------------------------------------------
// Stations — procedurally named docks scattered across a ~1300 ly cluster
// ---------------------------------------------------------------------------
const _LON = ["b", "c", "d", "g", "k", "l", "m", "n", "r", "s", "t", "v", "z",
              "th", "dr", "kr", "tr", "br", "st", "ph", "vel", "cor"];
const _LC = ["b", "d", "g", "k", "l", "m", "n", "r", "s", "t", "v", "z"];
const _LV = ["a", "e", "i", "o", "u"];
const _LV1 = ["a", "e", "i", "o", "u", "ae", "ei", "ia", "au", "y"];
const _LEND = ["n", "r", "s", "l", "x", "th", "is", "or", "yx"];
const _SUFFIX = ["Station", "Port", "Relay", "Anchorage", "Hub", "Gate", "Depot", "Yards"];
const _pick = (a) => a[(Math.random() * a.length) | 0];

function coreName() {
  let n = _pick(_LON) + _pick(_LV1);
  const extra = Math.random() < 0.6 ? 1 : 2;
  for (let i = 0; i < extra; i++) n += _pick(_LC) + _pick(_LV);
  if (Math.random() < 0.45) n += _pick(_LEND);
  return n[0].toUpperCase() + n.slice(1);
}
function stationName() { return coreName() + " " + _pick(_SUFFIX); }

const stations = [{ name: stationName(), pos: new THREE.Vector3(0, 0, 0) }];
{
  let guard = 0;
  while (stations.length < 9 && guard++ < 800) {
    const p = new THREE.Vector3(
      (Math.random() * 2 - 1),
      (Math.random() * 2 - 1) * 0.5,
      (Math.random() * 2 - 1)
    ).multiplyScalar(620);
    if (p.length() < 70) continue;
    if (stations.every((s) => s.pos.distanceTo(p) > 100)) {
      stations.push({ name: stationName(), pos: p });
    }
  }
}

// HTML labels for stations (aberration-aware, target highlighted)
const labelsRoot = document.getElementById("labels");
for (const st of stations) {
  const el = document.createElement("div");
  el.className = "landmark";
  el.innerHTML = `<span class="dot"></span><span class="nm"></span><span class="d"></span>`;
  el.querySelector(".nm").textContent = st.name;
  labelsRoot.appendChild(el);
  st.el = el;
  st.dEl = el.querySelector(".d");
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------
const CARGO = ["medical isotopes", "a cryo seed vault", "quantum cores", "antimatter cells",
  "archive crystals", "terraforming spores", "vaccine printers", "a reactor lattice",
  "orbital tether spools", "heirloom soil"];
const PAX = ["Dr. Imura", "Envoy Ashari", "the Kessler family", "a colonist cohort",
  "Magistrate Voss", "two exogeologists", "a stasis choir", "Capt. Rhee (ret.)",
  "a diplomatic quartet", "the last archivist of Meridian"];

function makeContracts(fromIdx) {
  const offers = [];
  const used = new Set([fromIdx]);
  while (offers.length < 3 && used.size < stations.length) {
    const t = (Math.random() * stations.length) | 0;
    if (used.has(t)) continue;
    used.add(t);
    const d = stations[fromIdx].pos.distanceTo(stations[t].pos);
    if (Math.random() < 0.55) {
      // cargo: universe-time deadline — requires a minimum average speed
      const betaReq = 0.55 + Math.random() * 0.4;
      offers.push({
        type: "cargo", what: _pick(CARGO), to: t, d,
        deadline: d / betaReq + 4,
        pay: Math.round(90 + d * (0.9 + (betaReq - 0.5) * 3.2)),
      });
    } else {
      // passenger: ship-time aging cap — requires a minimum average gamma
      const gReq = 4 + Math.random() * 26;
      offers.push({
        type: "passenger", what: _pick(PAX), to: t, d,
        deadline: d / 0.7 + 8,
        maxAging: d / gReq * 1.15 + 0.6,
        pay: Math.round(160 + d * (0.7 + gReq * 0.14)),
      });
    }
  }
  return offers;
}

// ---------------------------------------------------------------------------
// Phase / screens
// ---------------------------------------------------------------------------
const el = (id) => document.getElementById(id);
const screens = { title: el("title"), station: el("station"), results: el("results"), over: el("gameover") };

function setPhase(p) {
  game.phase = p;
  for (const [k, s] of Object.entries(screens)) s.classList.toggle("hiddenS", k !== p);
  document.body.classList.toggle("flight", p === "flight");
  if (p === "station") buildStation();
  if (p === "results") buildResults();
  if (p === "over") buildGameOver();
  markDirty();
}

function fmtY(y) { return y >= 1000 ? (y / 1000).toFixed(2) + " kyr" : y.toFixed(1) + " yr"; }

function buildStation() {
  const s = stations[game.station];
  el("st-name").textContent = "Docked · " + s.name;
  el("st-stats").innerHTML =
    `pilot age <b>${game.pilotAge.toFixed(1)}</b> / retires ${RETIRE_AGE}` +
    ` &nbsp;·&nbsp; credits <b class="gold-t">₡${game.credits}</b>` +
    ` &nbsp;·&nbsp; Δv <b>${game.fuel.toFixed(1)}</b> / ${TANK}` +
    ` &nbsp;·&nbsp; deliveries <b>${game.deliveries}</b>`;

  game.offers = makeContracts(game.station);
  const box = el("st-offers");
  box.innerHTML = "";
  game.offers.forEach((c, i) => {
    const div = document.createElement("div");
    div.className = "offer";
    const need = c.type === "cargo"
      ? `needs ≥ <b>${Math.min(0.99, c.d / c.deadline).toFixed(2)}c</b> average`
      : `keep average γ ≥ <b>${(c.d / c.maxAging).toFixed(1)}</b> (they may age ≤ ${c.maxAging.toFixed(1)} yr)`;
    div.innerHTML =
      `<div class="t">${c.type === "cargo" ? "FREIGHT — " + c.what : "PASSAGE — " + c.what}` +
      `<span class="pay">₡${c.pay}</span></div>` +
      `<div class="sub">to <b>${stations[c.to].name}</b> · ${c.d.toFixed(0)} ly · ` +
      `deadline ${fmtY(c.deadline)} (universe) · ${need}</div>` +
      `<button class="btn" data-i="${i}">ACCEPT & UNDOCK</button>`;
    div.querySelector("button").addEventListener("click", () => depart(game.offers[i]));
    box.appendChild(div);
  });

  const missing = TANK - game.fuel;
  const cost = Math.ceil(missing * FUEL_PRICE);
  const rf = el("st-refuel");
  rf.textContent = missing < 0.05 ? "TANK FULL" : `REFUEL (₡${cost})`;
  rf.disabled = missing < 0.05;
}

el("st-refuel").addEventListener("click", () => {
  const missing = TANK - game.fuel;
  const affordable = Math.min(missing, game.credits / FUEL_PRICE);
  game.fuel += affordable;
  game.credits -= Math.ceil(affordable * FUEL_PRICE);
  buildStation();
});
el("st-retire").addEventListener("click", () => setPhase("over"));

function depart(c) {
  game.contract = { ...c, acceptCoord: ship.coordTime, acceptShip: ship.shipTime };
  ship.pos.copy(stations[game.station].pos);
  ship.throttle = 0;
  ship.beta = 0;
  dyn.prevBeta = 0;
  dyn.prevPhi = 0;
  // undock aimed at the destination
  _dir.copy(stations[c.to].pos).sub(ship.pos).normalize();
  ship.quat.setFromUnitVectors(new THREE.Vector3(0, 0, -1), _dir);
  el("c-dest").textContent = stations[c.to].name;
  el("c-age-row").style.display = c.type === "passenger" ? "flex" : "none";
  setPhase("flight");
  showToast("undocked — " + stations[c.to].name);
}

function dock() {
  const c = game.contract;
  const usedCoord = ship.coordTime - c.acceptCoord;
  const usedShip = ship.shipTime - c.acceptShip;
  let pay = c.pay, ok = true;
  const notes = [];
  if (usedCoord > c.deadline) {
    ok = false; pay = Math.round(pay * 0.25);
    notes.push(`LATE — arrived ${fmtY(usedCoord)} vs deadline ${fmtY(c.deadline)} (pay docked 75%)`);
  }
  if (c.type === "passenger" && usedShip > c.maxAging) {
    ok = false; pay = Math.round(pay * 0.2);
    notes.push(`passenger aged ${usedShip.toFixed(1)} yr — limit was ${c.maxAging.toFixed(1)} yr (pay docked 80%)`);
  }
  game.credits += pay;
  game.earned += pay;
  if (ok) game.deliveries++; else game.failures++;
  game.station = c.to;
  game.lastResult = { kind: "dock", ok, pay, usedCoord, usedShip, notes, c };
  game.contract = null;
  audio.warpSweep(ok);
  setPhase("results");
}

function callTow() {
  if (game.phase !== "flight") return;
  const c = game.contract;
  let nearest = 0, best = Infinity;
  stations.forEach((s, i) => {
    const d = s.pos.distanceTo(ship.pos);
    if (d < best) { best = d; nearest = i; }
  });
  const cost = Math.max(150, Math.round(game.credits * 0.4));
  game.credits = Math.max(0, game.credits - cost);
  game.pilotAge += 4;
  ship.shipTime += 4;
  game.fuel = Math.max(game.fuel, TANK * 0.5);
  game.station = nearest;
  game.failures++;
  game.lastResult = { kind: "tow", cost, c, nearest };
  game.contract = null;
  setPhase("results");
}

function buildResults() {
  const r = game.lastResult;
  if (r.kind === "tow") {
    el("rs-title").textContent = "Towed";
    el("rs-body").innerHTML =
      `A recovery tug hauled you to <b>${stations[r.nearest].name}</b>.<br/>` +
      `Contract <b class="bad">forfeited</b> · fee <b class="bad">₡${r.cost}</b> · ` +
      `the rescue cost you <b class="bad">4 years</b> of your life.<br/>` +
      `Tank restored to 50%.`;
  } else {
    el("rs-title").textContent = r.ok ? "Delivery complete ✓" : "Delivery botched";
    el("rs-body").innerHTML =
      `<b>${r.c.type === "cargo" ? r.c.what : r.c.what}</b> → <b>${stations[r.c.to].name}</b><br/>` +
      `universe time used <b>${fmtY(r.usedCoord)}</b> (deadline ${fmtY(r.c.deadline)})<br/>` +
      `ship time aboard <b>${r.usedShip.toFixed(2)} yr</b>` +
      (r.c.type === "passenger" ? ` (limit ${r.c.maxAging.toFixed(1)} yr)` : "") + `<br/>` +
      (r.notes.length ? `<span class="bad">${r.notes.join("<br/>")}</span><br/>` : "") +
      `paid <b class="${r.ok ? "gold-t" : "bad"}">₡${r.pay}</b>`;
  }
}
el("rs-continue").addEventListener("click", () => {
  if (game.pilotAge >= RETIRE_AGE) setPhase("over");
  else setPhase("station");
});

function buildGameOver() {
  const forced = game.pilotAge >= RETIRE_AGE;
  el("go-title").textContent = forced ? "Mandatory retirement" : "Retired";
  el("go-body").innerHTML =
    `You hung up the flight suit at <b>${game.pilotAge.toFixed(1)}</b>.<br/>` +
    `While you flew, the universe aged <b>${fmtY(ship.coordTime)}</b> — ` +
    `you lived <b>${fmtY(START_AGE + ship.shipTime - START_AGE)}</b> of it aboard.<br/>` +
    `Deliveries <b class="good">${game.deliveries}</b> · botched/towed <b class="bad">${game.failures}</b><br/>` +
    `Career earnings <b class="gold-t">₡${game.earned}</b> · final balance <b class="gold-t">₡${game.credits}</b>`;
}
el("go-new").addEventListener("click", () => location.reload());

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const keys = new Set();
const input = { yaw: 0, pitch: 0, roll: 0 };
let uiHidden = false;
let started = false;

const audio = createAudio();

function start() {
  if (started) return;
  started = true;
  try { window.focus(); } catch (_) {}
  audio.init();
  updateSoundIndicator();
  setPhase("station");
}
el("title").addEventListener("click", start);
window.addEventListener("keydown", (e) => {
  if (game.phase === "title") { start(); return; }
  if (game.phase !== "flight") return;
  keys.add(e.code);
  if (e.code === "Space") e.preventDefault();
  if (e.code === "KeyH") toggleUI();
  if (e.code === "KeyR") callTow();
  if (e.code === "KeyM") { audio.toggleMute(); updateSoundIndicator(); }
  if (e.code === "KeyV") cycleSpeedPreset();
  if (e.code === "Digit1") fx.aberration ^= 1;
  if (e.code === "Digit2") fx.doppler ^= 1;
  if (e.code === "Digit3") fx.beaming ^= 1;
  if (e.code === "Digit4") fx.contraction ^= 1;
  if (e.code === "Digit5") fx.cmb ^= 1;
});
window.addEventListener("keyup", (e) => keys.delete(e.code));

// drag steering (mouse + touch)
let dragging = false, dragId = null, lastX = 0, lastY = 0;
renderer.domElement.addEventListener("pointerdown", (e) => {
  if (game.phase !== "flight") return;
  dragging = true; dragId = e.pointerId;
  lastX = e.clientX; lastY = e.clientY;
});
window.addEventListener("pointermove", (e) => {
  if (!dragging || e.pointerId !== dragId || game.phase !== "flight") return;
  const dx = e.clientX - lastX, dy = e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  input.yaw -= dx * 0.0016;
  input.pitch -= dy * 0.0016;
});
window.addEventListener("pointerup", (e) => {
  if (e.pointerId === dragId) { dragging = false; dragId = null; }
});

// throttle bar drag
const throttleBarEl = el("throttleBar");
let throttleDrag = false;
function setThrottleFromPointer(clientY) {
  const r = throttleBarEl.getBoundingClientRect();
  ship.throttle = Math.max(0, Math.min(1, 1 - (clientY - r.top) / r.height));
}
throttleBarEl.addEventListener("pointerdown", (e) => {
  if (game.phase !== "flight") return;
  throttleDrag = true;
  try { throttleBarEl.setPointerCapture(e.pointerId); } catch (_) {}
  setThrottleFromPointer(e.clientY);
  e.preventDefault();
});
throttleBarEl.addEventListener("pointermove", (e) => { if (throttleDrag) setThrottleFromPointer(e.clientY); });
throttleBarEl.addEventListener("pointerup", () => { throttleDrag = false; });

// effect-row taps
const fx = { aberration: 1, doppler: 1, beaming: 1, contraction: 1, cmb: 1 };
const fxRows = { aberration: "fx-aberr", doppler: "fx-doppler", beaming: "fx-beam", contraction: "fx-contract", cmb: "fx-cmb" };
for (const [k, id] of Object.entries(fxRows)) {
  el(id).style.pointerEvents = "auto";
  el(id).style.cursor = "pointer";
  el(id).addEventListener("click", () => { fx[k] ^= 1; });
}
document.querySelector("#effects .snd").style.pointerEvents = "auto";
document.querySelector("#effects .snd").addEventListener("click", () => { audio.toggleMute(); updateSoundIndicator(); });

function toggleUI() {
  uiHidden = !uiHidden;
  el("hud").style.opacity = uiHidden ? 0.06 : 1;
}
function updateSoundIndicator() {
  const s = el("sound-state");
  if (s) s.textContent = audio.isMuted() ? "muted" : "on";
}

const SPEED_PRESETS = [0, 0.5, 0.9, 0.99, 0.9999];
function cycleSpeedPreset() {
  if (game.fuel <= 0) return;
  const current = throttleToBeta(ship.throttle);
  let next = SPEED_PRESETS.find((p) => p > current + 1e-4);
  if (next === undefined) next = 0;
  ship.throttle = betaToThrottle(next);
  showToast(next === 0 ? "→ full stop" : "→ " + (next >= 0.999 ? "0.9999 c" : next + " c"));
}

let toastTimer = null;
function showToast(text) {
  const t = el("toast");
  t.textContent = text;
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("on"), 1200);
}

// ---------------------------------------------------------------------------
// HUD refs & helpers
// ---------------------------------------------------------------------------
const hud = {
  pct: el("s-pct"), beta: el("s-beta"), gamma: el("s-gamma"), gforce: el("s-gforce"),
  age: el("s-age"), credits: el("s-credits"), fuel: el("s-fuel"),
  fuelFill: el("fuelFill"), fuelBar: el("fuelBar"),
  throttleFill: el("throttleFill"), throttlePct: el("throttlePct"),
  cDest: el("c-dest"), cDist: el("c-dist"), cDeadline: el("c-deadline"),
  cAging: el("c-aging"), cPay: el("c-pay"), cStatus: el("c-status"),
  fxAberr: el("fx-aberr"), fxDoppler: el("fx-doppler"), fxBeam: el("fx-beam"),
  fxContract: el("fx-contract"), fxCmb: el("fx-cmb"),
};
const flashEl = el("flash");
const gveilEl = el("gveil");
const viewmodeEl = el("viewmode");
let flashAmt = 0;
function flash(a) { flashAmt = Math.max(flashAmt, a); }

const _fwd = new THREE.Vector3();
const _prevFwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _proj = new THREE.Vector3();
const _q = new THREE.Quaternion();

function shipForward(out) { return out.set(0, 0, -1).applyQuaternion(ship.quat); }
function fmt(n, d = 1) {
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

const view = { lookYaw: 0 };
const dyn = { prevBeta: 0, prevPhi: 0, gForce: 0, shake: 0, fovKick: 0, veil: 0 };

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let last = performance.now();
let dirtyFrames = 3;
function markDirty() { dirtyFrames = 3; }

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (game.phase === "flight") {
    update(dt);
    composer.render();
  } else if (dirtyFrames > 0) {
    composer.render();
    dirtyFrames--;
  }
  requestAnimationFrame(frame);
}

function update(dt) {
  // --- throttle keys (fine default, Shift turbo) ---
  const turbo = keys.has("ShiftLeft") || keys.has("ShiftRight") ? 4 : 1;
  const rate = 0.14 * turbo;
  if (keys.has("KeyW") || keys.has("ArrowUp")) ship.throttle += rate * dt;
  if (keys.has("KeyS") || keys.has("ArrowDown")) ship.throttle -= rate * dt;
  if (keys.has("Space")) ship.throttle = 0;
  ship.throttle = Math.max(0, Math.min(1, ship.throttle));

  // dead stick: out of fuel = no thrust = you coast at your current beta
  if (game.fuel <= 0) ship.throttle = betaToThrottle(ship.beta);

  // --- steering (turn-rate heavy near c; roll free) ---
  const kYaw = (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0) -
               (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0);
  const kRoll = (keys.has("KeyE") ? 1 : 0) - (keys.has("KeyQ") ? 1 : 0);
  input.yaw += kYaw * 0.4 * dt;
  input.roll += kRoll * 0.6 * dt;

  shipForward(_prevFwd);
  const turnScale = 1 / (1 + (lorentz(ship.beta) - 1) * 0.6);
  _q.setFromAxisAngle(_up.set(0, 1, 0), input.yaw * turnScale);
  ship.quat.multiply(_q);
  _q.setFromAxisAngle(_right.set(1, 0, 0), input.pitch * turnScale);
  ship.quat.multiply(_q);
  _q.setFromAxisAngle(_dir.set(0, 0, -1), input.roll);
  ship.quat.multiply(_q);
  ship.quat.normalize();
  input.yaw *= Math.pow(0.0001, dt);
  input.pitch *= Math.pow(0.0001, dt);
  input.roll *= Math.pow(0.0001, dt);
  shipForward(_fwd);
  const omegaTurn = Math.acos(THREE.MathUtils.clamp(_prevFwd.dot(_fwd), -1, 1)) / Math.max(dt, 1e-4);

  // --- speed easing + FUEL: burn |Δrapidity| (proper Δv of the maneuver) ---
  const targetBeta = throttleToBeta(ship.throttle);
  ship.beta += (targetBeta - ship.beta) * Math.min(1, dt * 2.5);
  const gamma = lorentz(ship.beta);
  const phi = rapidity(ship.beta);
  const dphi = Math.abs(phi - dyn.prevPhi);
  dyn.prevPhi = phi;
  if (dphi > 0) game.fuel = Math.max(0, game.fuel - dphi);

  // --- pilot-frame pacing: universe time & distance scale with γ (capped) ---
  const gPace = GAMMA_CAP * Math.tanh(gamma / GAMMA_CAP);
  const dCoord = PROPER_RATE * gPace * dt;
  const ds = ship.beta * dCoord;
  ship.pos.addScaledVector(_fwd, ds);
  ship.coordTime += dCoord;
  const dShip = dCoord / gamma;
  ship.shipTime += dShip;
  game.pilotAge += dShip;

  // --- arrival check ---
  const c = game.contract;
  const tgt = stations[c.to];
  const dist = tgt.pos.distanceTo(ship.pos);
  if (dist < DOCK_RADIUS && ship.beta < DOCK_BETA) { dock(); return; }

  // --- push uniforms ---
  for (const layer of layers) {
    const u = layer.uniforms;
    u.uForward.value.copy(_fwd);
    u.uBeta.value = ship.beta;
    u.uGamma.value = gamma;
    u.uFxAberration.value = fx.aberration;
    u.uFxDoppler.value = fx.doppler;
    u.uFxBeaming.value = fx.beaming;
  }
  cmb.position.copy(ship.pos);
  cmbUniforms.uForward.value.copy(_fwd);
  cmbUniforms.uBeta.value = ship.beta;
  cmbUniforms.uGamma.value = gamma;
  cmbUniforms.uGain.value = fx.cmb ? 0.5 : 0;

  // --- felt G (linear γ³·dv/dt + centripetal γ²·v·ω) ---
  const coordAccel = (ship.beta - dyn.prevBeta) / Math.max(dt, 1e-4);
  dyn.prevBeta = ship.beta;
  const properAccel = coordAccel * Math.pow(gamma, 3);
  const turnProper = gamma * gamma * ship.beta * omegaTurn;
  const properTotal = Math.hypot(properAccel, turnProper);
  const surge = THREE.MathUtils.clamp(Math.abs(coordAccel) / 2.2, 0, 1);
  const turnSurge = THREE.MathUtils.clamp(turnProper / 22, 0, 1);
  const feltSurge = Math.max(surge, turnSurge);
  const targetG = Math.min(99, properTotal * 1.6);
  dyn.gForce += (targetG - dyn.gForce) * Math.min(1, dt * 6);
  const targetShake = Math.min(0.016, feltSurge * 0.012 + ship.beta * ship.beta * 0.0012);
  dyn.shake += (targetShake - dyn.shake) * Math.min(1, dt * 8);
  const targetKick = THREE.MathUtils.clamp(coordAccel * 4.0, -6, 8);
  dyn.fovKick += (targetKick - dyn.fovKick) * Math.min(1, dt * 5);
  dyn.veil = Math.min(0.6, feltSurge * 0.55 + Math.pow(ship.beta, 6) * 0.12);

  // --- look astern ---
  const targetYaw = keys.has("KeyB") ? Math.PI : 0;
  view.lookYaw += (targetYaw - view.lookYaw) * Math.min(1, dt * 5);

  // --- camera ---
  camera.position.copy(ship.pos);
  camera.quaternion.copy(ship.quat);
  if (view.lookYaw > 0.001) {
    _q.setFromAxisAngle(_up.set(0, 1, 0), view.lookYaw);
    camera.quaternion.multiply(_q);
  }
  if (dyn.shake > 1e-5) {
    _q.setFromAxisAngle(
      _dir.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
      dyn.shake * (Math.random() - 0.5) * 2);
    camera.quaternion.multiply(_q);
  }
  const contraction = fx.contraction ? 1 / gamma : 1;
  camera.fov = 72 * (0.7 + 0.3 * contraction) + dyn.fovKick;
  camera.updateProjectionMatrix();

  updateHUD(gamma, dist, dCoord / Math.max(dt, 1e-4));
  updateLabels();
  audio.update(ship.beta, ship.throttle, 0, feltSurge);

  gveilEl.style.opacity = dyn.veil.toFixed(3);
  viewmodeEl.classList.toggle("on", view.lookYaw > 0.4);
  if (flashAmt > 0) {
    flashEl.style.opacity = flashAmt.toFixed(3);
    flashAmt = Math.max(0, flashAmt - dt * 1.6);
  }
}

function updateHUD(gamma, dist, coordRate) {
  const pctC = ship.beta * 100;
  hud.pct.textContent = (pctC >= 99.99 ? fmt(pctC, 4) : fmt(pctC, 3)) + " %c";
  hud.beta.textContent = ship.beta.toFixed(ship.beta > 0.999 ? 7 : 6);
  hud.gamma.textContent = gamma > 1000 ? gamma.toExponential(2) : fmt(gamma, 4);
  hud.gforce.textContent = (dyn.gForce >= 99 ? "99+" : fmt(dyn.gForce, 1)) + " g";
  hud.gforce.style.color = dyn.gForce > 9 ? "var(--warn)" : "var(--hud)";
  hud.age.textContent = game.pilotAge.toFixed(1) + " yr";
  hud.credits.textContent = "₡" + game.credits;
  hud.fuel.textContent = game.fuel.toFixed(1) + " / " + TANK;
  hud.fuelFill.style.width = (game.fuel / TANK * 100).toFixed(1) + "%";
  hud.fuelBar.classList.toggle("low", game.fuel < TANK * 0.2);

  hud.throttleFill.style.height = (ship.throttle * 100) + "%";
  hud.throttlePct.textContent = game.fuel <= 0 ? "DEAD STICK" : Math.round(ship.throttle * 100) + "%";

  // contract tracker
  const c = game.contract;
  hud.cDist.textContent = dist.toFixed(1) + " ly";
  const remaining = c.deadline - (ship.coordTime - c.acceptCoord);
  hud.cDeadline.textContent = "T−" + fmtY(Math.max(0, remaining));
  hud.cDeadline.className = "v" + (remaining < c.deadline * 0.15 ? " bad" : "");
  if (c.type === "passenger") {
    const aged = ship.shipTime - c.acceptShip;
    hud.cAging.textContent = aged.toFixed(2) + " / " + c.maxAging.toFixed(1) + " yr";
    hud.cAging.className = "v" + (aged > c.maxAging * 0.8 ? " bad" : "");
  }
  hud.cPay.textContent = "₡" + c.pay;

  // status line: braking guidance & docking
  const lyPerSec = ship.beta * coordRate;              // current ly per real second
  const brakeDist = lyPerSec * 1.5 + 4;                 // rough easing-stop estimate
  let status = "", cls = "";
  if (dist < DOCK_RADIUS) {
    status = ship.beta < DOCK_BETA ? "DOCKING…" : "IN RANGE — slow below 0.20c";
    cls = "dockable";
  } else if (dist < brakeDist) {
    status = "⚠ CUT THROTTLE — braking distance";
    cls = "brake";
  } else if (game.fuel <= 0) {
    status = "FUEL EXPENDED — press R for a tow";
    cls = "brake";
  }
  hud.cStatus.textContent = status;
  hud.cStatus.className = "status " + cls;

  hud.fxAberr.className = fx.aberration ? "on" : "";
  hud.fxDoppler.className = fx.doppler ? "on" : "";
  hud.fxBeam.className = fx.beaming ? "on" : "";
  hud.fxContract.className = fx.contraction ? "on" : "";
  hud.fxCmb.className = fx.cmb ? "on" : "";
}

function updateLabels() {
  const labelFade = 1 - THREE.MathUtils.smoothstep(ship.beta, 0.9, 0.97);
  for (let i = 0; i < stations.length; i++) {
    const st = stations[i];
    const isTarget = game.contract && game.contract.to === i;
    // the target label stays visible at any speed; others fade near c
    const fade = isTarget ? 1 : labelFade;
    if (fade <= 0.001) { st.el.style.display = "none"; continue; }
    _dir.copy(st.pos).sub(ship.pos);
    const dist = _dir.length();
    if (dist < 1e-3) { st.el.style.display = "none"; continue; }
    _dir.multiplyScalar(1 / dist);
    const beta = fx.aberration ? ship.beta : 0;
    aberrateDir(_dir, _fwd, beta, _ab);
    _proj.copy(ship.pos).addScaledVector(_ab, dist);
    _proj.project(camera);
    if (_proj.z > 1 || _proj.z < -1) { st.el.style.display = "none"; continue; }
    const x = (_proj.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-_proj.y * 0.5 + 0.5) * window.innerHeight;
    st.el.style.display = "block";
    st.el.style.opacity = fade.toFixed(3);
    st.el.style.left = x + "px";
    st.el.style.top = y + "px";
    st.el.classList.toggle("target", !!isTarget);
    st.dEl.textContent = dist.toFixed(0) + " ly";
  }
}

// ---------------------------------------------------------------------------
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  for (const l of layers) l.uniforms.uPixelRatio.value = renderer.getPixelRatio();
  markDirty();
});

// debug hook for automated testing (not used by gameplay)
window.__lighthaul = { game, ship, stations, dock, setPhase };

requestAnimationFrame(frame);
