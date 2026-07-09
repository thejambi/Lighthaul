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
  C_CAP, lorentz,
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
const START_AGE = 22;
const RETIRE_AGE = 82;      // rejuvenation-era flight certification, not a deathbed
const TANK = 14;             // Δv budget in rapidity units (scarce — can't max every leg)
const FUEL_PRICE = 20;       // base credits per rapidity unit (before bulk discount)
const FUEL_BULK_DISC = 0.02; // discount per Δv unit in the fill-up...
const FUEL_MAX_DISC = 0.35;  // ...capped here. Big fills (a large tank run low) are cheapest.
const LOW_FUEL = 6;          // Δv below which the dock nags you to refuel (see buildStation)
const DOCK_RADIUS = 15;      // ly
const DOCK_BETA = 0.2;
const THRUST_RATE = 0.14;   // base throttle change per second (W/S, ↑/↓)
const TURBO_X = 4;          // Shift multiplier — "turbo thrust"
const WARP_X = 9;           // X multiplier — "warp thrust", unlocked by Redline Coils
const SPOOL = 2.5;          // drive response: how fast β chases the throttle setting
const WARP_SPOOL = 4.4;     // a warp burn spools β harder — faster real accel, higher felt G
const AP_DECEL = 0.14;      // autopilot throttle-down rate = the S-key rate
const PREFLIGHT = 10;       // seconds after undock: clock frozen, aim at the target (or thrust to launch early)
const AIM_RATE = 2.2;       // autopilot slerp rate onto the target heading (per second)
const DRAG_SENS = 0.004;    // radians of turn per pixel dragged (before ship handling)
const KEY_TURN = 1.3;       // yaw rad/s for a held A/D key (before ship handling)
const ROLL_TURN = 1.6;      // roll rad/s for a held Q/E key
const STEER_RESP = 32;      // how fast the turn eases to the input — ×handling (crisp vs. inertial)
const LOAD_K = 9;           // maneuvering accel -> felt inertial load (g)
const DMG_RATE = 0.10;      // integrity lost per (g over rating) per second

// Ship outfits, bought at a dock. Levels persist across the career and tune the
// core dials. `costs` is the price of each successive tier (its length = max
// level). Each station stocks a fixed pair, so the map is worth learning.
const UPGRADES = {
  tank:      { icon: "⬢", name: "Fuel Cell Array", desc: "+3 Δv tank capacity",        costs: [200, 320, 460, 620] },
  drive:     { icon: "⚡", name: "Drive Efficiency", desc: "−12% fuel burned per Δv",     costs: [240, 400, 560] },
  damper:    { icon: "◇", name: "Inertial Dampers", desc: "−15% felt maneuvering load",  costs: [260, 420, 600] },
  broker:    { icon: "✦", name: "Broker License",   desc: "+8% pay on every contract",   costs: [280, 460, 640] },
  rejuv:     { icon: "✚", name: "Rejuv Course",      desc: "+6 yr before retirement",     costs: [300, 460, 640, 840] },
  overdrive: { icon: "»", name: "Redline Coils",    desc: "a 9 nearer c — faster legs & less aging", costs: [400, 720, 1150, 1700, 2400, 3300] },
  autopilot: { icon: "◈", name: "Docking Assist",   desc: "auto-brakes to a clean dock", costs: [500], oneShot: true },
};

// Ship classes, chosen at career start. Each is a different trade fed into the
// same dial getters the upgrades use, so a class just sets the baseline and
// upgrades stack on top. A difficulty spread: the Courier is soft and forgiving,
// the Interceptor a thin-hulled glass cannon for precise hands. `tank` is base Δv,
// `fuelEff`/`damper`/`handling` multiply fuel burned / felt load / turn rate.
// `pips` (1–5) are display-only ratings for the select screen.
const CLASSES = {
  courier: {
    name: "Courier", tag: "FORGIVING",
    tank: 14, fuelEff: 1.0, damper: 0.85, handling: 1.0, credits: 450,
    pips: { tank: 3, fuel: 3, handling: 3, care: 5 },
    blurb: "Balanced and gentle on the load — quick to point, hard to wreck. The pilot's-first-ship all-rounder.",
  },
  hauler: {
    name: "Hauler", tag: "BULK CARGO",
    tank: 20, fuelEff: 1.12, damper: 1.2, handling: 0.7, credits: 320,
    pips: { tank: 5, fuel: 2, handling: 1, care: 2 },
    blurb: "A big-tank freighter for long, fast rugged-cargo runs. Turns like a moon and feels every G — keep fragile passengers off it.",
  },
  interceptor: {
    name: "Interceptor", tag: "HIGH SKILL",
    tank: 10, fuelEff: 0.8, damper: 1.15, handling: 1.45, credits: 300,
    pips: { tank: 1, fuel: 5, handling: 5, care: 2 },
    blurb: "A featherweight racer: sips fuel, turns on a spark, flies high-γ passenger work cheap. Tiny tank, thin hull — precise hands only.",
  },
};

// Stylized top-down ship silhouettes (nose up) — shown on the select cards, at
// the dock, and on the ship-stats card. Cyan hull, gold cockpit, soft engine glow.
const SHIP_ART = {
  courier: `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" class="ship-svg" aria-hidden="true">
    <ellipse cx="60" cy="102" rx="12" ry="5" fill="#8fe9ff" opacity=".22"/>
    <ellipse cx="53" cy="101" rx="4" ry="3" fill="#eafcff" opacity=".7"/>
    <ellipse cx="67" cy="101" rx="4" ry="3" fill="#eafcff" opacity=".7"/>
    <path d="M60 50 L22 84 L32 90 L60 72 L88 90 L98 84 Z" fill="#4f9fbb"/>
    <path d="M60 12 C71 32 72 66 66 98 L54 98 C48 66 49 32 60 12 Z" fill="#8fe9ff"/>
    <ellipse cx="60" cy="40" rx="5.5" ry="10" fill="#ffd76a"/>
    <rect x="50" y="92" width="8" height="9" rx="2.5" fill="#3f8098"/>
    <rect x="62" y="92" width="8" height="9" rx="2.5" fill="#3f8098"/>
  </svg>`,
  hauler: `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" class="ship-svg" aria-hidden="true">
    <ellipse cx="47" cy="104" rx="8" ry="5" fill="#8fe9ff" opacity=".22"/>
    <ellipse cx="73" cy="104" rx="8" ry="5" fill="#8fe9ff" opacity=".22"/>
    <ellipse cx="47" cy="103" rx="4" ry="3" fill="#eafcff" opacity=".7"/>
    <ellipse cx="73" cy="103" rx="4" ry="3" fill="#eafcff" opacity=".7"/>
    <rect x="23" y="46" width="12" height="34" rx="4" fill="#3f8098"/>
    <rect x="85" y="46" width="12" height="34" rx="4" fill="#3f8098"/>
    <path d="M42 22 L78 22 Q86 22 86 34 L86 96 Q86 100 82 100 L38 100 Q34 100 34 96 L34 34 Q34 22 42 22 Z" fill="#7ad3ea"/>
    <path d="M54 12 L66 12 L72 22 L48 22 Z" fill="#8fe9ff"/>
    <line x1="34" y1="54" x2="86" y2="54" stroke="#2c5c6e" stroke-width="2"/>
    <line x1="34" y1="74" x2="86" y2="74" stroke="#2c5c6e" stroke-width="2"/>
    <rect x="51" y="27" width="18" height="9" rx="3" fill="#ffd76a"/>
  </svg>`,
  interceptor: `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" class="ship-svg" aria-hidden="true">
    <ellipse cx="60" cy="105" rx="9" ry="5" fill="#8fe9ff" opacity=".22"/>
    <ellipse cx="60" cy="104" rx="4" ry="3" fill="#eafcff" opacity=".8"/>
    <path d="M60 44 L14 99 L34 96 L60 70 L86 96 L106 99 Z" fill="#4f9fbb"/>
    <path d="M60 8 L67 56 L64 103 L56 103 L53 56 Z" fill="#8fe9ff"/>
    <path d="M60 22 L63 42 L57 42 Z" fill="#ffd76a"/>
  </svg>`,
};

const game = {
  phase: "title",             // title | select | station | flight | results | over
  cls: "courier",             // chosen ship class (default until the select screen)
  credits: 400,
  fuel: TANK,
  pilotAge: START_AGE,
  deliveries: 0,
  failures: 0,
  earned: 0,
  station: 0,
  offers: [],
  contract: null,
  integrity: 1,               // cargo/passenger condition on the current run (0..1)
  preflight: 0,               // seconds left in the frozen pre-launch/aim window
  testFlight: false,          // free-flight sandbox — no contract, clock, fuel, or damage
  debug: false,               // play-test mode: free upgrades + teleport (armed at ship-select)
  upgrades: { tank: 0, drive: 0, damper: 0, broker: 0, rejuv: 0, overdrive: 0, autopilot: 0 },
  lastResult: null,
};

// --- persistent records (localStorage): the one thing that outlives a career,
// so every run is measured against your best. Rank is earned on final balance —
// the game's whole pitch is "retire rich", and the nest egg is what you keep.
const RECORDS_KEY = "lighthaul.records.v1";
const RANKS = [        // final-balance thresholds → title (tune after playtesting)
  [16000, "Lightspeed Legend"],
  [10000, "Void Baron"],
  [6000,  "Master Courier"],
  [3000,  "Journeyman Courier"],
  [1000,  "Drifter"],
  [0,     "Deadhead"],
];
function rankFor(bal) { return (RANKS.find(([m]) => bal >= m) || RANKS[RANKS.length - 1])[1]; }
const records = Object.assign(
  { bestBalance: 0, bestEarned: 0, mostDeliveries: 0, careers: 0 },
  (() => { try { return JSON.parse(localStorage.getItem(RECORDS_KEY)) || {}; } catch (_) { return {}; } })()
);
function commitCareer() {                 // fold this career into the saved bests
  const beat = {
    balance: game.credits > records.bestBalance,
    earned: game.earned > records.bestEarned,
    deliveries: game.deliveries > records.mostDeliveries,
  };
  records.bestBalance = Math.max(records.bestBalance, game.credits);
  records.bestEarned = Math.max(records.bestEarned, game.earned);
  records.mostDeliveries = Math.max(records.mostDeliveries, game.deliveries);
  records.careers += 1;
  try { localStorage.setItem(RECORDS_KEY, JSON.stringify(records)); } catch (_) {}
  return beat;
}

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
const REDLINE_GAMMA = 2000;   // γ above which the HUD SPEED/Lorentz readouts go red + buzz

// Effective speed cap. C_CAP is the stock governor; each Redline Coils level
// shrinks the remaining gap to c by 10× (adds a nine), so top-throttle γ climbs
// and you age even less — for more Δv.
// clamp keeps 1−β ≥ 5e-13 (γ ≈ 1e6): below that, doubles round β to exactly 1
// and γ/rapidity blow up to Infinity. Level 6 sits right at that floor.
function capBeta() { return Math.min(1 - 5e-13, 1 - (1 - C_CAP) * Math.pow(10, -game.upgrades.overdrive)); }

// The pilot-frame pacing softcap also lifts with each Redline Coils level, so
// redline legs actually cover ground faster in real time (≈ PROPER_RATE·gammaCap
// ly/s at saturation) — NOT just age less. Aging (d/βγ) and universe time (d/β)
// fall out independent of gammaCap, so this only speeds the wall-clock journey.
function gammaCap() { return GAMMA_CAP * (1 + 0.25 * game.upgrades.overdrive); }

function throttleToBeta(t) {
  t = Math.max(0, Math.min(1, t));
  return Math.min(1 - Math.pow(1 - t, 3), capBeta());
}
function betaToThrottle(b) {
  return 1 - Math.cbrt(1 - Math.min(b, capBeta()));
}
const rapidity = (b) => Math.atanh(Math.min(b, capBeta()));

// Forward-simulate "holding S" from a given speed to find how many ly it takes
// to bleed down to dock speed — i.e. the distance out at which the autopilot must
// start braking. Mirrors the real throttle/β/pacing dynamics from update().
function apBrakeDistance(beta0) {
  let beta = beta0;
  let throttle = betaToThrottle(beta0);
  let dist = 0;
  const h = 0.05;                       // integration step (= the game's dt cap)
  for (let i = 0; i < 2000 && beta > DOCK_BETA; i++) {
    throttle = Math.max(0, throttle - AP_DECEL * h);
    beta += (throttleToBeta(throttle) - beta) * Math.min(1, h * SPOOL);
    const gc = gammaCap();
    const gp = gc * Math.tanh(lorentz(beta) / gc);
    dist += beta * PROPER_RATE * gp * h;
  }
  return dist;
}

// --- upgrade effects: each derived dial folds in the owned level. Kept as live
// getters (not baked constants) so buying mid-career takes effect immediately.
const UP_KEYS = Object.keys(UPGRADES);
function shipCls()   { return CLASSES[game.cls]; }                                    // active ship class
function tankCap()   { return shipCls().tank + game.upgrades.tank * 3; }              // Δv capacity
function retireAge() { return RETIRE_AGE + game.upgrades.rejuv * 6; }                 // career length (pilot, not ship)
function loadFactor(){ return shipCls().damper * (1 - game.upgrades.damper * 0.15); } // felt maneuvering load ×
function fuelFactor(){ return shipCls().fuelEff * (1 - game.upgrades.drive * 0.12); } // fuel burned ×
function payMult()   { return 1 + game.upgrades.broker * 0.08; }        // contract pay ×
function contractPay(c) { return Math.round(c.pay * payMult()); }

// bulk fuel discount: the per-Δv price drops with the size of the fill-up. Δv is
// rapidity, so brake fuel is capacity-independent — a big tank you let run low
// before topping off buys the cheapest fuel.
function fuelDiscount(qty) { return Math.min(FUEL_MAX_DISC, Math.max(0, qty) * FUEL_BULK_DISC); }
function fuelUnitPrice(qty) { return FUEL_PRICE * (1 - fuelDiscount(qty)); }
function fuelCost(qty) { return Math.ceil(qty * fuelUnitPrice(qty)); }

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
// Seeded RNG so a map can be replayed. Only the WORLD (station layout, names,
// shops) and the contracts draw from `rng` — visual star fields stay on
// Math.random. A career's seed is fixed at ship-select; the same string always
// rebuilds the same cluster.
function strToSeed(str) {                          // string → 32-bit seed (FNV-1a)
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a) {                            // fast seedable PRNG → [0,1)
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randomSeed() { return Math.random().toString(36).slice(2, 8); }  // short shareable string
let worldSeed = "";
let rng = Math.random;                             // reassigned by placeStations()

const _LON = ["b", "c", "d", "g", "k", "l", "m", "n", "r", "s", "t", "v", "z",
              "th", "dr", "kr", "tr", "br", "st", "ph", "vel", "cor"];
const _LC = ["b", "d", "g", "k", "l", "m", "n", "r", "s", "t", "v", "z"];
const _LV = ["a", "e", "i", "o", "u"];
const _LV1 = ["a", "e", "i", "o", "u", "ae", "ei", "ia", "au", "y"];
const _LEND = ["n", "r", "s", "l", "x", "th", "is", "or", "yx"];
const _SUFFIX = ["Station", "Port", "Relay", "Anchorage", "Hub", "Gate", "Depot", "Yards"];
const _pick = (a) => a[(rng() * a.length) | 0];

function coreName() {
  let n = _pick(_LON) + _pick(_LV1);
  const extra = rng() < 0.6 ? 1 : 2;
  for (let i = 0; i < extra; i++) n += _pick(_LC) + _pick(_LV);
  if (rng() < 0.45) n += _pick(_LEND);
  return n[0].toUpperCase() + n.slice(1);
}
function stationName() { return coreName() + " " + _pick(_SUFFIX); }

// A compact cluster keeps hops short enough that a career is many deliveries,
// not a couple of doomed voyages (a 500 ly hop ages you centuries below ~0.999c).
// The persistent `stations` array (and its DOM labels) is created once; a new
// seed rewrites the names/positions/shops in place so label elements survive.
const stations = [];
const labelsRoot = document.getElementById("labels");

function placeStations(seed) {
  worldSeed = seed || randomSeed();
  rng = mulberry32(strToSeed(worldSeed));

  const built = [{ name: stationName(), pos: new THREE.Vector3(0, 0, 0) }];
  let guard = 0;
  while (built.length < 9 && guard++ < 800) {
    const p = new THREE.Vector3(
      (rng() * 2 - 1),
      (rng() * 2 - 1) * 0.5,
      (rng() * 2 - 1)
    ).multiplyScalar(170);
    if (p.length() < 30) continue;
    if (built.every((s) => s.pos.distanceTo(p) > 40)) {
      built.push({ name: stationName(), pos: p });
    }
  }

  // Each dock stocks a fixed pair of outfits, so different places sell different
  // upgrades — the map is worth learning. Guarantee every upgrade is sold somewhere.
  built.forEach((s) => {
    const a = _pick(UP_KEYS);
    let b = _pick(UP_KEYS);
    while (b === a) b = _pick(UP_KEYS);
    s.shop = [a, b];
  });
  UP_KEYS.forEach((k) => {
    if (!built.some((s) => s.shop.includes(k))) {
      _pick(built).shop[(rng() * 2) | 0] = k;
    }
  });

  // Commit into the persistent array, creating each station's DOM label on the
  // first build and just refreshing name/pos/shop on later re-seeds.
  built.forEach((b, i) => {
    let st = stations[i];
    if (!st) {
      const div = document.createElement("div");
      div.className = "landmark";
      div.innerHTML = `<span class="dot"></span><span class="tag"><span class="nm"></span><span class="d"></span></span>`;
      labelsRoot.appendChild(div);
      st = stations[i] = { el: div, dEl: div.querySelector(".d") };
    }
    st.name = b.name; st.pos = b.pos; st.shop = b.shop;
    st.el.querySelector(".nm").textContent = b.name;
  });
}
placeStations(randomSeed());   // an initial cluster so menus/test-flight work pre-career

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
    const t = (rng() * stations.length) | 0;
    if (used.has(t)) continue;
    used.add(t);
    const d = stations[fromIdx].pos.distanceTo(stations[t].pos);
    // inertial rating: max maneuvering G the load tolerates. Lower = more
    // fragile = must burn/brake gently = a demand premium on the pay.
    if (rng() < 0.55) {
      // cargo: universe-time deadline — requires a minimum average speed
      const betaReq = 0.55 + rng() * 0.4;
      const gLimit = Math.round(4 + rng() * 14);        // 4–18 g
      offers.push({
        type: "cargo", what: _pick(CARGO), to: t, d, gLimit,
        deadline: d / betaReq + 4,
        pay: Math.round((90 + d * (0.9 + (betaReq - 0.5) * 3.2)) * (1 + Math.max(0, 11 - gLimit) * 0.05)),
      });
    } else {
      // passenger: ship-time aging cap — requires a minimum average gamma. Kept
      // humane: γ demands top out near 0.997c (not an impossible 0.9993c), and
      // the cap carries a fixed +slack for the accel/brake ramp — which ages them
      // at low γ, worse the gentler (lower-g) the ramp has to be.
      const gReq = 4 + rng() * 12;                       // need average γ ≈ 3–13
      const gLimit = Math.round(4 + rng() * 4);          // 4–8 g (humans)
      offers.push({
        type: "passenger", what: _pick(PAX), to: t, d, gLimit,
        deadline: d / 0.7 + 10,
        maxAging: d / gReq * 1.25 + 1.5,
        pay: Math.round((160 + d * (0.7 + gReq * 0.2)) * (1 + Math.max(0, 8 - gLimit) * 0.06)),
      });
    }
  }
  return offers;
}

// ---------------------------------------------------------------------------
// Phase / screens
// ---------------------------------------------------------------------------
const el = (id) => document.getElementById(id);
// #shipcard is listed so setPhase hides it on any real transition; it's never a
// phase itself — it's opened as an overlay on the station screen.
const screens = { title: el("title"), select: el("select"), station: el("station"), results: el("results"), over: el("gameover"), ship: el("shipcard") };

function setPhase(p) {
  game.phase = p;
  for (const [k, s] of Object.entries(screens)) s.classList.toggle("hiddenS", k !== p);
  document.body.classList.toggle("flight", p === "flight");
  if (p !== "flight") audio.silence();     // don't let the engine drone hang on non-flight screens
  // generate the three contracts once, on arrival — not on every re-render
  // (so refuelling doesn't re-roll the offers)
  if (p === "station") { game.offers = makeContracts(game.station); mapSelected = -1; buildStation(); }
  if (p === "results") buildResults();
  if (p === "over") buildGameOver();
  markDirty();
}

function fmtY(y) { return y >= 1000 ? (y / 1000).toFixed(2) + " kyr" : y.toFixed(1) + " yr"; }

function buildStation() {
  const s = stations[game.station];
  el("st-name").textContent = "Docked · " + s.name;
  el("st-stats").innerHTML =
    `pilot age <b>${game.pilotAge.toFixed(1)}</b> / retires ${retireAge()}` +
    ` &nbsp;·&nbsp; credits <b class="gold-t">₡${game.credits}</b>` +
    ` &nbsp;·&nbsp; Δv <b>${game.fuel.toFixed(1)}</b> / ${tankCap()}` +
    ` &nbsp;·&nbsp; deliveries <b>${game.deliveries}</b>`;

  const seedBtn = el("st-seed");
  seedBtn.textContent = "seed " + worldSeed + " · tap to copy";
  seedBtn.classList.remove("copied");
  el("st-debug").style.display = game.debug ? "" : "none";

  el("st-ship").innerHTML =
    `<div class="ship-mini">${SHIP_ART[game.cls]}</div>` +
    `<div class="ship-meta"><div class="ship-nm">${shipCls().name} <span class="cc-tag">${shipCls().tag}</span></div>` +
    `<div class="ship-sub">tap for ship stats ▸</div></div>`;

  const missing = tankCap() - game.fuel;
  const rf = el("st-refuel");
  if (missing < 0.05) {
    rf.textContent = "TANK FULL";
  } else {
    const disc = Math.round(fuelDiscount(missing) * 100);
    rf.textContent = disc >= 3 ? `REFUEL ₡${fuelCost(missing)} · −${disc}%` : `REFUEL (₡${fuelCost(missing)})`;
  }
  rf.disabled = missing < 0.05;

  // low-Δv reminder: fuel is rapidity, so the cost to accelerate-and-brake a leg
  // doesn't shrink with a bigger tank — the threshold is absolute (~a 0.99c round
  // trip: 2·atanh .99 − atanh .2 ≈ 5.1, plus a little margin). Nags + pulses the
  // refuel button so a player doesn't undock into a dead stick.
  const low = game.fuel < LOW_FUEL;
  const lf = el("st-lowfuel");
  lf.style.display = low ? "block" : "none";
  if (low) lf.innerHTML =
    `⚠ LOW Δv — <b>${game.fuel.toFixed(1)}</b> in the tank. A fast leg (~0.99c out and brake) ` +
    `burns about <b>5</b>; top up before you undock or you risk a dead stick.`;
  rf.classList.toggle("urge", low && !rf.disabled);

  // the star chart IS the contract browser — render it as part of the dock.
  // Selection survives a re-render (refuel/upgrade) and resets on arrival.
  if (mapSelected >= 0) {
    selectMapNode(mapSelected);
  } else {
    buildStarMap();
    el("map-detail").innerHTML = '<span class="dim">Tap a destination to plan the leg — ✓/✗ shows what your chosen speed can deliver.</span>';
  }

  buildShop();
}

// --- outfitting: this dock's two stocked upgrades, with tier pips + buy buttons
function buildShop() {
  const box = el("st-shop");
  let html = '<div class="shop-hd">OUTFITTING · this dock stocks</div>';
  for (const k of stations[game.station].shop) {
    const u = UPGRADES[k];
    const lv = game.upgrades[k];
    const max = u.costs.length;
    // autopilot counts as owned if the easter egg already switched it on
    const owned = k === "autopilot" ? (lv > 0 || autopilotAssist) : lv >= max;
    const cost = u.costs[lv];
    let pips = "";
    if (!u.oneShot) for (let i = 0; i < max; i++) pips += `<span class="pip ${i < lv ? "on" : ""}"></span>`;
    let ctrl;
    if (owned) ctrl = `<span class="shop-max">${u.oneShot ? "OWNED" : "MAX"}</span>`;
    else {
      const afford = game.debug || game.credits >= cost;   // debug: buy anything, price still shown
      ctrl = `<button class="btn ${afford ? "gold" : ""} shop-buy" data-k="${k}"${afford ? "" : " disabled"}>₡${cost}</button>`;
    }
    html += `<div class="shop-row"><span class="shop-ic">${u.icon}</span>` +
      `<span class="shop-main"><b>${u.name}</b><span class="pips">${pips}</span>` +
      `<span class="shop-desc">${u.desc}</span></span>${ctrl}</div>`;
  }
  box.innerHTML = html;
  box.querySelectorAll(".shop-buy").forEach((b) => b.addEventListener("click", () => buyUpgrade(b.dataset.k)));
}

function buyUpgrade(k) {
  const lv = game.upgrades[k];
  const cost = UPGRADES[k].costs[lv];
  if (cost === undefined) return;
  if (!game.debug) {                    // debug play-test mode: outfits are free
    if (game.credits < cost) return;
    game.credits -= cost;
  }
  game.upgrades[k] = lv + 1;
  if (k === "autopilot") { autopilotAssist = true; updateAutopilotIndicator(false); }
  updateBadges();
  buildStation();               // re-render stats, offer pay, and shop
  showEggToast(`${UPGRADES[k].icon} ${UPGRADES[k].name} installed`);
}

el("st-refuel").addEventListener("click", () => {
  const missing = tankCap() - game.fuel;
  if (missing < 0.05) return;
  const unit = fuelUnitPrice(missing);          // bulk rate set by the size of the fill
  const affordable = Math.min(missing, game.credits / unit);
  game.fuel += affordable;
  game.credits -= Math.ceil(affordable * unit);
  buildStation();
});
el("st-retire").addEventListener("click", () => setPhase("over"));

// copy the current map seed to the clipboard so a good cluster can be replayed
el("st-seed").addEventListener("click", () => {
  const btn = el("st-seed");
  const done = () => { btn.textContent = "seed " + worldSeed + " · copied ✓"; btn.classList.add("copied"); };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(worldSeed).then(done, fallbackCopy);
    else fallbackCopy();
  } catch (_) { fallbackCopy(); }
  function fallbackCopy() {                      // execCommand path for non-secure contexts
    const ta = document.createElement("textarea");
    ta.value = worldSeed; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (_) {}
    document.body.removeChild(ta); done();
  }
});

// ---------------------------------------------------------------------------
// Star chart — the dock's contract browser & trip planner, rendered inside the
// station screen. Nodes are stations; gold routes are open contracts, each with
// pay + g-rating and a live ✓/✗ for the chosen cruise speed. Every station sits
// in a large invisible hit-group (node + label both tappable — finger-sized).
// ---------------------------------------------------------------------------
let mapBeta = 0.999;
let mapSelected = -1;

// can this contract be delivered cruising at beta b, on the current tank?
function contractFeasible(c, b) {
  const g = lorentz(b);
  const meets = c.type === "cargo" ? c.d / b <= c.deadline : c.d / (b * g) <= c.maxAging;
  return meets && 2 * rapidity(b) <= game.fuel;
}

function buildStarMap() {
  const svg = el("map-svg");
  // Match the viewBox to the rendered box: a square viewBox in a wide container
  // letterboxes the chart into the middle, wasting the whole margin. H stays 100
  // so font/radius sizes render the same; W stretches to the real aspect.
  const rect = svg.getBoundingClientRect();     // clientWidth/Height are 0 on SVG elements
  const aspect = rect.height > 40               // trust only a real layout, not a collapsed one
    ? Math.min(2.6, Math.max(1, rect.width / rect.height)) : 1.9;
  const H = 100, W = Math.round(H * aspect), pad = 12;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const s of stations) {
    minX = Math.min(minX, s.pos.x); maxX = Math.max(maxX, s.pos.x);
    minZ = Math.min(minZ, s.pos.z); maxZ = Math.max(maxZ, s.pos.z);
  }
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  // one uniform scale, but fit each axis against its own frame edge — an
  // elongated cluster zooms until its long axis fills the chart instead of
  // shrinking to leave empty margins on the short one
  const scale = Math.min((W - 2 * pad) / Math.max(maxX - minX, 1),
                         (H - 2 * pad) / Math.max(maxZ - minZ, 1));
  stations.forEach((s) => {
    s._mx = W / 2 + (s.pos.x - cx) * scale;
    s._my = H / 2 + (s.pos.z - cz) * scale;
  });

  // Label layout: estimate each label's footprint and dodge neighbours — prefer
  // the right side, flip left or nudge vertically when names would collide.
  // `placed` starts with every node dot so labels never sit on other stations.
  const placed = stations.map((st) => ({ x1: st._mx - 2.6, y1: st._my - 2.6, x2: st._mx + 2.6, y2: st._my + 2.6 }));
  const collides = (b, skip) => placed.some((o, idx) =>
    idx !== skip && b.x1 < o.x2 && b.x2 > o.x1 && b.y1 < o.y2 && b.y2 > o.y1);
  stations.forEach((st, i) => {
    const c = game.offers.find((o) => o.to === i);
    st._nm = st.name.replace(/ (Station|Anchorage|Depot|Yards|Relay|Port|Hub|Gate)$/, "");
    let w = 3 + st._nm.length * 1.9;                     // ~monospace advance at font-size 3
    if (c) w = Math.max(w, 24);                          // the ✓/✗ sub-line can be wider than the name
    const up = 2.4, dn = c ? 6.2 : 2.2;                  // taller footprint when a sub-line follows
    const box = (side, dy) => side > 0
      ? { x1: st._mx + 2, y1: st._my + dy - up, x2: st._mx + 2 + w, y2: st._my + dy + dn }
      : { x1: st._mx - 2 - w, y1: st._my + dy - up, x2: st._mx - 2, y2: st._my + dy + dn };
    const pref = st._mx + 3 + w > W - 2 ? -1 : 1;        // flip when the frame edge is in the way
    const alt = -pref;
    const fits = (b) => b.x1 >= 1 && b.x2 <= W - 1 && b.y1 >= 0.5 && b.y2 <= H - 0.5;
    let pick = [pref, 0];
    for (const cand of [[pref, 0], [alt, 0], [pref, 5], [pref, -5], [alt, 5], [alt, -5],
                        [pref, 9], [alt, 9], [pref, -9], [alt, -9]]) {
      const b = box(cand[0], cand[1]);
      if (fits(b) && !collides(b, i)) { pick = cand; break; }
    }
    st._lside = pick[0]; st._ldy = pick[1];
    placed.push(box(pick[0], pick[1]));
  });

  let out = "";
  const dock = stations[game.station];
  for (const c of game.offers) {
    const b = stations[c.to];
    out += `<line x1="${dock._mx}" y1="${dock._my}" x2="${b._mx}" y2="${b._my}" class="map-edge" data-edge="${c.to}"/>`;
  }
  stations.forEach((st, i) => {
    const isDock = i === game.station;
    const c = game.offers.find((o) => o.to === i);
    const cls = isDock ? "dock" : c ? "dest" : "node";
    const r = isDock ? 2.4 : c ? 2.0 : 1.3;
    const tx = st._lside > 0 ? st._mx + 3 : st._mx - 3;
    const anchor = st._lside > 0 ? "" : ' text-anchor="end"';
    out += `<g class="map-hit" data-i="${i}">` +
      `<circle cx="${st._mx}" cy="${st._my}" r="6" class="hit"/>` +
      `<circle cx="${st._mx}" cy="${st._my}" r="${r}" class="map-node ${cls}"/>` +
      `<text x="${tx}" y="${st._my + 1 + st._ldy}"${anchor} class="map-label ${cls}">${st._nm}</text>`;
    if (c) {
      const ok = contractFeasible(c, mapBeta);
      out += `<text x="${tx}" y="${st._my + 4.6 + st._ldy}"${anchor} class="map-sub ${ok ? "ok" : "no"}">` +
        `${ok ? "✓" : "✗"} ₡${contractPay(c)} · ${c.gLimit}g</text>`;
    }
    out += `</g>`;
  });
  svg.innerHTML = out;
}

function selectMapNode(i) {
  mapSelected = i;
  buildStarMap();
  // highlight selection
  const node = el("map-svg").querySelector(`g[data-i="${i}"] .map-node`);
  if (node) node.classList.add("sel");
  const edge = el("map-svg").querySelector(`.map-edge[data-edge="${i}"]`);
  if (edge) edge.classList.add("sel");

  const box = el("map-detail");
  if (i === game.station) {
    box.innerHTML = `<div class="name">${stations[i].name}</div><span class="dim">You are docked here.</span>`;
    return;
  }
  const b = mapBeta, g = lorentz(b);
  const d = stations[game.station].pos.distanceTo(stations[i].pos);
  const uni = d / b, aged = d / (b * g), dv = 2 * rapidity(b);
  const fuelOk = dv <= game.fuel;
  const c = game.offers.find((o) => o.to === i);

  let html = `<div class="name">${stations[i].name}</div>`;
  html += `<span class="k">distance</span> ${d.toFixed(0)} ly &nbsp;·&nbsp; ` +
          `<span class="k">Δv</span> <span class="${fuelOk ? "" : "bad"}">${dv.toFixed(1)}</span> / ${game.fuel.toFixed(1)}<br/>`;
  html += `at <b>${b}c</b>: <span class="k">universe</span> ${fmtY(uni)} &nbsp;·&nbsp; ` +
          `<span class="k">you age</span> <b>${aged.toFixed(2)} yr</b><br/>`;
  if (c) {
    const need = c.type === "cargo"
      ? `deadline ${fmtY(c.deadline)} — need ≥ ${Math.min(0.99, c.d / c.deadline).toFixed(2)}c`
      : `age cap ${c.maxAging.toFixed(1)} yr — need γ ≥ ${(c.d / c.maxAging).toFixed(1)}`;
    const meets = c.type === "cargo" ? uni <= c.deadline : aged <= c.maxAging;
    const frag = c.gLimit <= 6 ? `<span class="bad">fragile: ${c.gLimit}g</span>` : `${c.gLimit}g`;
    html += `<span class="k">${c.type === "cargo" ? "FREIGHT" : "PASSAGE"}</span> ${c.what} · ` +
            `<span class="gold-t">₡${contractPay(c)}</span> · ${frag}<br/>` +
            `<span class="${meets ? "good" : "bad"}">${meets ? "✓ meets" : "✗ misses"}</span> ${need}` +
            ` <button class="btn ${meets ? "gold" : ""}" id="map-accept" style="margin-left:8px;padding:5px 12px">ACCEPT & UNDOCK</button>`;
  } else {
    html += `<span class="dim">no contract to this station</span>`;
  }
  if (game.debug) html += `<div class="dbg-line"><button class="btn dbg-btn" id="map-tp">◈ TELEPORT HERE</button>` +
    `<span class="dim">debug — dock instantly, re-rolls contracts</span></div>`;
  box.innerHTML = html;

  const acc = el("map-accept");
  if (acc) acc.addEventListener("click", () => {
    if (acc.dataset.armed) depart(c);
    else { acc.dataset.armed = "1"; acc.textContent = "CONFIRM UNDOCK"; acc.classList.add("armed"); }
  });
  const tp = el("map-tp");
  if (tp) tp.addEventListener("click", () => teleport(i));
}

// debug: dock instantly at any station (no flight, no fuel/age cost). setPhase
// re-rolls that dock's contracts and rebuilds the screen, like a real arrival.
function teleport(i) {
  game.station = i;
  ship.pos.copy(stations[i].pos);
  ship.throttle = 0; ship.beta = 0;
  setPhase("station");
  showEggToast("◈ teleported to " + stations[i].name);
}

// tap anywhere in a station's hit-group (node, label, or the padding around them)
el("map-svg").addEventListener("click", (e) => {
  const t = e.target.closest("[data-i]");
  if (t) selectMapNode(+t.dataset.i);
});
el("map-speeds").addEventListener("click", (e) => {
  const btn = e.target.closest(".mapspd");
  if (!btn) return;
  mapBeta = parseFloat(btn.dataset.b);
  el("map-speeds").querySelectorAll(".mapspd").forEach((b) => b.classList.toggle("active", b === btn));
  if (mapSelected >= 0) selectMapNode(mapSelected);
  else buildStarMap();                    // recolor the ✓/✗ sub-lines for the new speed
});

// ---------------------------------------------------------------------------
// Ship card — the current ship's effective stats (base class + owned upgrades).
// Opened by tapping the ship strip at the dock.
// ---------------------------------------------------------------------------
function openShip() { buildShipStats(); el("shipcard").classList.remove("hiddenS"); }
function closeShip() { el("shipcard").classList.add("hiddenS"); }

function buildShipStats() {
  const c = shipCls(), u = game.upgrades;
  el("shipcard-art").innerHTML = SHIP_ART[game.cls];
  el("shipcard-name").textContent = c.name;
  el("shipcard-tag").textContent = c.tag;
  const mult = (x) => x.toFixed(2) + "×";
  const row = (lab, val, note, q = "") =>
    `<div class="sc-row"><span class="sc-lab">${lab}</span>` +
    `<span class="sc-val ${q}">${val}</span><span class="sc-note">${note || ""}</span></div>`;
  const q = (x, lowerBetter) => {                 // strength/weakness vs the 1.0 baseline
    if (Math.abs(x - 1) < 0.01) return "";
    return (lowerBetter ? x < 1 : x > 1) ? "good" : "bad";
  };
  const owned = u.autopilot || autopilotAssist;
  el("shipcard-stats").innerHTML =
    row("Δv tank", tankCap().toFixed(0),
      u.tank ? `base ${c.tank} + ${u.tank * 3} · Fuel Cell ×${u.tank}` : `base ${c.tank}`) +
    row("fuel burn", mult(fuelFactor()),
      "per Δv" + (u.drive ? ` · drive −${u.drive * 12}%` : ""), q(fuelFactor(), true)) +
    row("felt load", mult(loadFactor()),
      "maneuvering G" + (u.damper ? ` · dampers −${u.damper * 15}%` : ""), q(loadFactor(), true)) +
    row("handling", mult(c.handling), "turn & throttle response", q(c.handling, false)) +
    row("top speed", "γ ≤ " + Math.round(lorentz(capBeta())).toLocaleString(),
      u.overdrive ? `redline ×${u.overdrive} — nearer c` : "stock governor", u.overdrive ? "good" : "") +
    row("contract pay", "×" + payMult().toFixed(2),
      u.broker ? `broker +${u.broker * 8}%` : "no broker license", q(payMult(), false)) +
    row("retires at", retireAge().toFixed(0),
      u.rejuv ? `base ${RETIRE_AGE} + ${u.rejuv * 6} · rejuv` : `base ${RETIRE_AGE}`) +
    row("docking assist", owned ? "installed" : "—", owned ? "auto-brakes to a clean dock" : "");
}

el("st-ship").addEventListener("click", openShip);
el("shipcard-back").addEventListener("click", closeShip);

// ---------------------------------------------------------------------------
// Test flight — take the current ship out for a free spin. No contract, clock,
// fuel, or damage. Reached by tapping a ship silhouette (select cards / ship
// card) or the ship card's TEST FLIGHT button. ESC / the EXIT chip returns you.
// ---------------------------------------------------------------------------
let testReturn = "station";
function startTestFlight(clsKey, returnScreen) {
  game.cls = clsKey;
  game.testFlight = true;
  game.contract = null;
  game.preflight = 0;
  testReturn = returnScreen;
  ship.pos.copy(stations[game.station].pos);
  ship.throttle = 0; ship.beta = 0;
  ship.quat.identity();
  dyn.prevBeta = 0; dyn.prevPhi = 0; dyn.load = 0;
  av.yaw = av.pitch = av.roll = 0; dragYaw = dragPitch = 0; aimStation = null;
  apBraking = false;
  refreshWarpZones();
  el("tf-name").textContent = shipCls().name;
  el("testBanner").style.display = "flex";
  closeShip();
  setPhase("flight");
}
function exitTestFlight() {
  if (!game.testFlight) return;
  game.testFlight = false;
  el("testBanner").style.display = "none";
  el("contract").style.display = "";        // restore the tracker for real flights
  setPhase(testReturn);
}
el("tf-exit").addEventListener("click", exitTestFlight);
el("shipcard-test").addEventListener("click", () => startTestFlight(game.cls, "station"));
el("shipcard-art").addEventListener("click", () => startTestFlight(game.cls, "station"));

function depart(c) {
  game.contract = { ...c, acceptCoord: ship.coordTime, acceptShip: ship.shipTime };
  game.integrity = 1;
  ship.pos.copy(stations[game.station].pos);
  ship.throttle = 0;
  ship.beta = 0;
  dyn.prevBeta = 0;
  dyn.prevPhi = 0;
  dyn.load = 0;
  apBraking = false;
  av.yaw = av.pitch = av.roll = 0; dragYaw = dragPitch = 0; aimStation = null;   // clean steering
  game.preflight = PREFLIGHT;            // frozen window to find & aim at the target
  // undock facing OFF the target by ~60–100° (mostly yaw) — you aim during the
  // countdown, or the autopilot slerps you on. Never a hopeless 180.
  _dir.copy(stations[c.to].pos).sub(ship.pos).normalize();
  ship.quat.setFromUnitVectors(_FWD, _dir);
  const offAng = (60 + Math.random() * 40) * Math.PI / 180 * (Math.random() < 0.5 ? 1 : -1);
  _q.setFromAxisAngle(_up.set((Math.random() - 0.5) * 0.5, 1, (Math.random() - 0.5) * 0.5).normalize(), offAng);
  ship.quat.multiply(_q);
  el("c-dest").textContent = stations[c.to].name;
  el("c-age-row").style.display = c.type === "passenger" ? "flex" : "none";
  updateBadges();
  disarmTow();
  setPhase("flight");
  showToast("undocked — " + stations[c.to].name);
}

function dock() {
  const c = game.contract;
  const usedCoord = ship.coordTime - c.acceptCoord;
  const usedShip = ship.shipTime - c.acceptShip;
  let pay = contractPay(c), ok = true;
  const notes = [];
  if (usedCoord > c.deadline) {
    ok = false; pay = Math.round(pay * 0.25);
    notes.push(`LATE — arrived ${fmtY(usedCoord)} vs deadline ${fmtY(c.deadline)} (pay docked 75%)`);
  }
  if (c.type === "passenger" && usedShip > c.maxAging) {
    ok = false; pay = Math.round(pay * 0.2);
    notes.push(`passenger aged ${usedShip.toFixed(1)} yr — limit was ${c.maxAging.toFixed(1)} yr (pay docked 80%)`);
  }
  // inertial damage: exceeding the rating stressed the load
  if (game.integrity < 0.995) {
    pay = Math.round(pay * (0.4 + 0.6 * game.integrity)); // floor at 40% even if wrecked
    const pct = Math.round((1 - game.integrity) * 100);
    notes.push(`${c.type === "passenger" ? "passengers roughed up" : "cargo stressed"} — ${pct}% over-rating damage (pay cut)`);
    if (game.integrity < 0.6) ok = false;
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
  if (game.phase !== "flight" || game.testFlight) return;   // nothing to tow in a free flight
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
  game.fuel = Math.max(game.fuel, tankCap() * 0.5);
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
  if (game.pilotAge >= retireAge()) setPhase("over");
  else setPhase("station");
});

function buildGameOver() {
  const forced = game.pilotAge >= retireAge();
  // commit exactly once per career (setPhase("over") only fires on a real
  // transition, but guard anyway so a re-render can't double-count)
  const beat = game._recorded ? { balance: false, earned: false, deliveries: false } : commitCareer();
  game._recorded = true;
  updateTitleRecords();
  const star = (on) => on ? ` <span class="rec-new">★ record</span>` : "";
  el("go-title").textContent = forced ? "Mandatory retirement" : "Retired";
  el("go-body").innerHTML =
    `<div class="rank">rank earned · <b class="gold-t">${rankFor(game.credits)}</b></div>` +
    `You hung up the flight suit at <b>${game.pilotAge.toFixed(1)}</b>, flying the <b>${shipCls().name}</b>.<br/>` +
    `While you flew, the universe aged <b>${fmtY(ship.coordTime)}</b> — ` +
    `you lived <b>${fmtY(ship.shipTime)}</b> of it aboard.<br/>` +
    `Deliveries <b class="good">${game.deliveries}</b>${star(beat.deliveries)} · ` +
    `botched/towed <b class="bad">${game.failures}</b><br/>` +
    `Career earnings <b class="gold-t">₡${game.earned}</b>${star(beat.earned)} · ` +
    `final balance <b class="gold-t">₡${game.credits}</b>${star(beat.balance)}` +
    `<div class="alltime">— all-time —&nbsp; richest retirement <b class="gold-t">₡${records.bestBalance}</b>` +
    ` · most deliveries <b>${records.mostDeliveries}</b> · careers flown <b>${records.careers}</b></div>`;
}
el("go-new").addEventListener("click", () => location.reload());

// title-screen records line (hidden until you've retired at least once)
function updateTitleRecords() {
  const t = el("title-records");
  if (!t) return;
  if (!records.careers) { t.style.display = "none"; return; }
  t.style.display = "block";
  t.innerHTML =
    `<span class="k">richest retirement</span> <b class="gold-t">₡${records.bestBalance}</b>` +
    ` · <span class="k">most deliveries</span> <b>${records.mostDeliveries}</b>` +
    ` · <span class="k">careers flown</span> <b>${records.careers}</b>`;
}
updateTitleRecords();

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const keys = new Set();
const av = { yaw: 0, pitch: 0, roll: 0 };   // smoothed angular velocity (rad/s)
let dragYaw = 0, dragPitch = 0;             // this-frame drag deltas, consumed each frame
let aimStation = null;                      // tapped/assisted aim target (a station) or null
let uiHidden = false;
let started = false;
let autopilotAssist = false;   // easter-egg "docking assist" — auto-cuts throttle to dock
let apBraking = false;         // set each frame when the assist is actively braking

const audio = createAudio();

function start() {
  if (started) return;
  started = true;
  try { window.focus(); } catch (_) {}
  audio.init();
  updateSoundIndicator();
  setPhase("select");           // choose a ship before the first contract
}
el("title").addEventListener("click", start);

// ship-class picker (shown once, at the top of a career)
function buildClassSelect() {
  const box = el("class-list");
  if (!box) return;
  const pipBar = (n) => { let s = ""; for (let i = 0; i < 5; i++) s += `<span class="pip ${i < n ? "on" : ""}"></span>`; return s; };
  const stat = (lab, n) => `<div class="cc-stat"><span class="cc-lab">${lab}</span><span class="pips">${pipBar(n)}</span></div>`;
  box.innerHTML = "";
  for (const [key, c] of Object.entries(CLASSES)) {
    const div = document.createElement("div");
    div.className = "classcard";
    div.innerHTML =
      `<div class="cc-art" data-cls="${key}" title="Take it for a test flight">${SHIP_ART[key]}` +
      `<span class="cc-testhint">▸ test fly</span></div>` +
      `<div class="cc-head"><span class="cc-name">${c.name}</span>` +
      `<span class="cc-tag"${key === "interceptor" ? ' id="egg-badge"' : ""}>${c.tag}</span></div>` +
      stat("Δv tank", c.pips.tank) + stat("fuel economy", c.pips.fuel) +
      stat("handling", c.pips.handling) + stat("cargo care", c.pips.care) +
      `<div class="cc-stat"><span class="cc-lab">start credits</span><span class="cc-credits gold-t">₡${c.credits}</span></div>` +
      `<div class="cc-blurb">${c.blurb}</div>` +
      `<button class="btn gold" data-cls="${key}">FLY THE ${c.name.toUpperCase()}</button>`;
    box.appendChild(div);
  }
  box.querySelectorAll("button[data-cls]").forEach((b) =>
    b.addEventListener("click", () => applyClass(b.dataset.cls)));
  box.querySelectorAll(".cc-art[data-cls]").forEach((a) =>
    a.addEventListener("click", () => startTestFlight(a.dataset.cls, "select")));

  // easter egg: tap the Interceptor's "HIGH SKILL" badge 5× to arm play-test mode
  // for whichever ship you then pick (free upgrades + teleport). Resets each career.
  const badge = el("egg-badge");
  if (badge) badge.addEventListener("click", (e) => {
    e.stopPropagation();
    eggTaps++;
    clearTimeout(eggTapTimer);
    eggTapTimer = setTimeout(() => (eggTaps = 0), 1200);
    if (eggTaps >= 5) {
      eggTaps = 0; debugArmed = true;
      badge.classList.add("armed");
      showEggToast("◈ DEBUG ARMED — pick a ship to fly it");
    }
  });
}
let debugArmed = false, eggTaps = 0, eggTapTimer = null;

function applyClass(key) {
  game.cls = key;
  const c = CLASSES[key];
  game.credits = c.credits;
  game.fuel = c.tank;           // start with a full tank of the class's size
  game.debug = debugArmed;      // the badge easter egg arms it; a career keeps it, next resets
  debugArmed = false;
  const seedEl = el("seed-input");
  placeStations(seedEl ? seedEl.value.trim() : "");   // typed seed, or a fresh random one
  setPhase("station");
}
buildClassSelect();
window.addEventListener("keydown", (e) => {
  if (game.phase === "title") { start(); return; }
  if (game.phase !== "flight") return;
  if (e.code === "Escape") { exitTestFlight(); return; }   // leave a test flight
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

// --- easter egg: the docking assist (a hand for new pilots — it auto-brakes so
// you always dock cleanly). Enable it with the Konami code on a keyboard, or by
// tapping the station header five times on touch.
function toggleAutopilot() {
  autopilotAssist = !autopilotAssist;
  if (!autopilotAssist) apBraking = false;
  updateAutopilotIndicator(true);
  showEggToast(autopilotAssist ? "◈ DOCKING ASSIST ON" : "docking assist off");
}
function updateAutopilotIndicator(doFlash) {
  const b = el("autoBadge");
  b.classList.toggle("on", autopilotAssist);
  if (doFlash) { b.classList.remove("flash"); void b.offsetWidth; b.classList.add("flash"); }
}

// Owned outfits shown as a compact HUD badge (autopilot has its own green badge).
const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII"];
function updateBadges() {
  const b = el("upgradeBadge");
  const owned = UP_KEYS.filter((k) => k !== "autopilot" && game.upgrades[k] > 0);
  b.classList.toggle("on", owned.length > 0);
  if (owned.length) {
    b.innerHTML = owned
      .map((k) => `${UPGRADES[k].icon}<span class="rl">${ROMAN[game.upgrades[k]]}</span>`)
      .join("<span class='bsep'>·</span>");
  }
  refreshWarpZones();          // warp thrust zones follow Redline Coils ownership
}
let eggToastTimer = null;
function showEggToast(text) {
  const t = el("eggToast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(eggToastTimer);
  eggToastTimer = setTimeout(() => t.classList.remove("show"), 1600);
}

// keyboard: Konami code  ↑ ↑ ↓ ↓ ← → ← → B A
const KONAMI = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown",
                "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "KeyB", "KeyA"];
let konamiIdx = 0;
window.addEventListener("keydown", (e) => {
  konamiIdx = e.code === KONAMI[konamiIdx] ? konamiIdx + 1 : (e.code === KONAMI[0] ? 1 : 0);
  if (konamiIdx === KONAMI.length) { konamiIdx = 0; toggleAutopilot(); }
});

// touch: tap the "Docked · …" station header 5 times quickly
let headerTaps = 0, headerTapTimer = null;
el("st-name").addEventListener("click", () => {
  headerTaps++;
  clearTimeout(headerTapTimer);
  headerTapTimer = setTimeout(() => (headerTaps = 0), 1200);
  if (headerTaps >= 5) { headerTaps = 0; toggleAutopilot(); }
});

// drag steering (mouse + touch). A drag pans; a tap (barely moved) on a station
// marker slews the ship onto it (assisted aim).
let dragging = false, dragId = null, lastX = 0, lastY = 0, downX = 0, downY = 0;
renderer.domElement.addEventListener("pointerdown", (e) => {
  if (game.phase !== "flight") return;
  dragging = true; dragId = e.pointerId;
  lastX = downX = e.clientX; lastY = downY = e.clientY;
});
window.addEventListener("pointermove", (e) => {
  if (!dragging || e.pointerId !== dragId || game.phase !== "flight") return;
  const dx = e.clientX - lastX, dy = e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  dragYaw -= dx * DRAG_SENS;
  dragPitch -= dy * DRAG_SENS;
});
window.addEventListener("pointerup", (e) => {
  if (e.pointerId !== dragId) return;
  dragging = false; dragId = null;
  if (game.phase === "flight" && Math.hypot(e.clientX - downX, e.clientY - downY) < 6) {
    const i = stationAtScreen(e.clientX, e.clientY, 70);   // tapped a marker? aim at it
    // a tap's stray pixel or two of movement must NOT count as steering, or it
    // would cancel the aim next frame — drop the pending drag so the slew holds.
    if (i >= 0) { aimStation = stations[i]; dragYaw = dragPitch = 0; }
  }
});
// the off-screen target arrow is a tap target too: aim at the destination
el("targetArrow").addEventListener("click", () => {
  if (game.phase === "flight" && game.contract) { aimStation = stations[game.contract.to]; dragYaw = dragPitch = 0; }
});

// throttle bar drag
// Press-and-hold zones on the thrust bar ramp the throttle while held (like
// W / Shift+W / X+W), instead of jumping to the tapped position — precise on
// touch. Zones top→bottom: [warp-up] turbo-up, up, down, turbo-down [warp-down].
// The triple-arrow warp zones only appear once Redline Coils are owned.
const throttleBarEl = el("throttleBar");
let throttleHeld = false;
let touchThrottleRate = 0;   // signed throttle delta per second from the held zone
let activeZoneEl = null;
// mirror the warp zones onto the bar when the drive can reach redline
function refreshWarpZones() { throttleBarEl.classList.toggle("warp", game.upgrades.overdrive > 0); }
function zoneFromPointer(clientY) {
  const r = throttleBarEl.getBoundingClientRect();
  const frac = (clientY - r.top) / r.height;   // 0 = top, 1 = bottom
  const turbo = THRUST_RATE * TURBO_X, warp = THRUST_RATE * WARP_X;
  if (game.upgrades.overdrive > 0) {           // 6 zones: warp | turbo | fine, each way
    if (frac < 0.12) return [warp, ".tz-uuu"];
    if (frac < 0.25) return [turbo, ".tz-uu"];
    if (frac < 0.50) return [THRUST_RATE, ".tz-u"];
    if (frac < 0.75) return [-THRUST_RATE, ".tz-d"];
    if (frac < 0.88) return [-turbo, ".tz-dd"];
    return [-warp, ".tz-ddd"];
  }
  if (frac < 0.15) return [turbo, ".tz-uu"];
  if (frac < 0.50) return [THRUST_RATE, ".tz-u"];
  if (frac < 0.85) return [-THRUST_RATE, ".tz-d"];
  return [-turbo, ".tz-dd"];
}
function setZone(clientY) {
  const [rate, sel] = zoneFromPointer(clientY);
  touchThrottleRate = rate;
  const zEl = throttleBarEl.querySelector(sel);
  if (zEl !== activeZoneEl) {
    if (activeZoneEl) activeZoneEl.classList.remove("active");
    activeZoneEl = zEl;
    if (activeZoneEl) activeZoneEl.classList.add("active");
  }
}
function clearZone() {
  throttleHeld = false;
  touchThrottleRate = 0;
  if (activeZoneEl) { activeZoneEl.classList.remove("active"); activeZoneEl = null; }
}
throttleBarEl.addEventListener("pointerdown", (e) => {
  if (game.phase !== "flight") return;
  throttleHeld = true;
  try { throttleBarEl.setPointerCapture(e.pointerId); } catch (_) {}
  setZone(e.clientY);
  e.preventDefault();
});
throttleBarEl.addEventListener("pointermove", (e) => { if (throttleHeld) setZone(e.clientY); });
throttleBarEl.addEventListener("pointerup", clearZone);
throttleBarEl.addEventListener("pointercancel", clearZone);
window.addEventListener("pointerup", () => { if (throttleHeld) clearZone(); });

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

// touch action buttons (mobile): mute + a confirm-then-fire tow
el("btn-mute").addEventListener("click", () => { audio.toggleMute(); updateSoundIndicator(); });
let towArmed = false, towTimer = null;
function disarmTow() {
  towArmed = false; clearTimeout(towTimer);
  const b = el("btn-tow"); b.textContent = "TOW"; b.classList.remove("armed");
}
el("btn-tow").addEventListener("click", () => {
  if (game.phase !== "flight") return;
  const b = el("btn-tow");
  if (!towArmed) {                 // first tap arms; forfeiting a contract shouldn't be a fat-finger
    towArmed = true; b.textContent = "SURE?"; b.classList.add("armed");
    clearTimeout(towTimer); towTimer = setTimeout(disarmTow, 2500);
    return;
  }
  disarmTow();
  callTow();
});

function toggleUI() {
  uiHidden = !uiHidden;
  el("hud").style.opacity = uiHidden ? 0.06 : 1;
}
function updateSoundIndicator() {
  const s = el("sound-state");
  if (s) s.textContent = audio.isMuted() ? "muted" : "on";
  const b = el("btn-mute");
  if (b) b.textContent = audio.isMuted() ? "🔇" : "🔊";
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
  cRating: el("c-rating"), cInteg: el("c-integrity"), integFill: el("integFill"), integBar: el("integBar"),
  fxAberr: el("fx-aberr"), fxDoppler: el("fx-doppler"), fxBeam: el("fx-beam"),
  fxContract: el("fx-contract"), fxCmb: el("fx-cmb"),
  countdown: el("countdown"), targetArrow: el("targetArrow"),
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
const _FWD = new THREE.Vector3(0, 0, -1);   // ship's nose in local space (never mutated)
const _UP = new THREE.Vector3(0, 1, 0);
const _ZERO = new THREE.Vector3(0, 0, 0);
const _m4 = new THREE.Matrix4();
const _aimQuat = new THREE.Quaternion();

function shipForward(out) { return out.set(0, 0, -1).applyQuaternion(ship.quat); }

// Smoothly rotate the ship so its nose points at a world position (used by the
// autopilot and by tap-to-aim).
function aimAtPos(pos, dt, rate) {
  _dir.copy(pos).sub(ship.pos).normalize();
  _m4.lookAt(_ZERO, _dir, _UP);           // orientation whose −z faces the point
  _aimQuat.setFromRotationMatrix(_m4);
  ship.quat.slerp(_aimQuat, Math.min(1, dt * rate));
}

// Which station's on-screen marker is nearest to a screen point (within radius px)?
// Used to turn a tap into an aim target. Returns an index or -1.
function stationAtScreen(px, py, radius) {
  let best = -1, bestD = radius;
  for (let i = 0; i < stations.length; i++) {
    _proj.copy(stations[i].pos).project(camera);
    if (_proj.z > 1) continue;             // behind the camera
    const sx = (_proj.x * 0.5 + 0.5) * window.innerWidth;
    const sy = (-_proj.y * 0.5 + 0.5) * window.innerHeight;
    const d = Math.hypot(sx - px, sy - py);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}
function fmt(n, d = 1) {
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

const view = { lookYaw: 0 };
const dyn = { prevBeta: 0, prevPhi: 0, load: 0, shake: 0, fovKick: 0, veil: 0 };

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
  // --- throttle keys: fine default, Shift = turbo, X = warp (Redline Coils only,
  // even faster than turbo). Per-ship responsiveness: nimble hulls spin the drive
  // up/down fast, heavy hulls are sluggish (shares handling).
  const warpKey = keys.has("KeyX") && game.upgrades.overdrive > 0;
  const mult = warpKey ? WARP_X : (keys.has("ShiftLeft") || keys.has("ShiftRight")) ? TURBO_X : 1;
  const thr = shipCls().handling;
  const rate = THRUST_RATE * mult * thr;
  if (keys.has("KeyW") || keys.has("ArrowUp")) ship.throttle += rate * dt;
  if (keys.has("KeyS") || keys.has("ArrowDown")) ship.throttle -= rate * dt;
  if (touchThrottleRate) ship.throttle += touchThrottleRate * thr * dt; // held thrust-bar zone
  // a warp burn (keyboard X, or the warp thrust-bar band) also spools the drive
  // harder below, so the speed itself climbs faster — not just the lever
  const warpBurn = warpKey || Math.abs(touchThrottleRate) > 1.0;
  if (keys.has("Space")) ship.throttle = 0;
  ship.throttle = Math.max(0, Math.min(1, ship.throttle));

  // dead stick: out of fuel = no thrust = you coast at your current beta
  if (game.fuel <= 0) ship.throttle = betaToThrottle(ship.beta);

  // --- steering: drag/keys set a desired turn rate; the ship eases to it at a
  // pace set by its HANDLING — nimble hulls are crisp and precise (little coast),
  // heavy hulls are laggy and inertial. γ still makes turning heavy near c; roll
  // is free. Consuming the drag each frame (no accumulator) kills the old overshoot.
  const kYaw = (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0) -
               (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0);
  const kRoll = (keys.has("KeyE") ? 1 : 0) - (keys.has("KeyQ") ? 1 : 0);
  const agility = shipCls().handling;
  const desYaw   = (kYaw * KEY_TURN + dragYaw / Math.max(dt, 1e-4)) * agility;   // rad/s
  const desPitch = (dragPitch / Math.max(dt, 1e-4)) * agility;
  dragYaw = 0; dragPitch = 0;
  const manualSteer = kYaw !== 0 || kRoll !== 0 || Math.abs(desYaw) > 1e-3 || Math.abs(desPitch) > 1e-3;
  const resp = Math.min(1, dt * STEER_RESP * agility);
  av.yaw   += (desYaw   - av.yaw)   * resp;
  av.pitch += (desPitch - av.pitch) * resp;
  av.roll  += (kRoll * ROLL_TURN - av.roll) * Math.min(1, dt * 6);
  if (manualSteer) aimStation = null;          // taking manual control cancels tap-to-aim

  shipForward(_prevFwd);
  const turnScale = 1 / (1 + (lorentz(ship.beta) - 1) * 0.6);   // relativistic turn penalty (γ)
  _q.setFromAxisAngle(_up.set(0, 1, 0), av.yaw * turnScale * dt);    ship.quat.multiply(_q);
  _q.setFromAxisAngle(_right.set(1, 0, 0), av.pitch * turnScale * dt); ship.quat.multiply(_q);
  _q.setFromAxisAngle(_dir.set(0, 0, -1), av.roll * dt);            ship.quat.multiply(_q);
  ship.quat.normalize();
  shipForward(_fwd);
  const omegaTurn = Math.acos(THREE.MathUtils.clamp(_prevFwd.dot(_fwd), -1, 1)) / Math.max(dt, 1e-4);

  // --- pre-launch window: clock & aging frozen, ship at rest. It ends on the
  // timer OR the instant you apply thrust — a breather you can cut short.
  if (game.preflight > 0) {
    if (ship.throttle > 0) game.preflight = 0;                   // thrusting = launch now
    else game.preflight = Math.max(0, game.preflight - dt);
    if (game.preflight === 0) showToast("GO — clock running");   // fires once, on the GO frame
  }
  const launching = game.preflight > 0;
  if (launching) ship.throttle = 0;                             // stay put until GO

  // --- assisted aim: the autopilot holds the contract target; a tapped marker
  // locks onto it the same way. Both hold the target dead-centre until you steer
  // manually (which clears the lock up in the steering block).
  const aimGoal = (autopilotAssist && game.contract) ? stations[game.contract.to].pos : (aimStation && aimStation.pos);
  if (aimGoal && !manualSteer) {
    // launch aim is quick; a deliberate tap is snappier than the autopilot's gentle hold
    const aimRate = launching ? AIM_RATE : (autopilotAssist ? AIM_RATE * 0.5 : AIM_RATE * 1.3);
    aimAtPos(aimGoal, dt, aimRate * agility);
    shipForward(_fwd);                    // refresh heading after the assist turned us
  }

  // --- autopilot docking assist (easter egg): behaves exactly like holding the
  // S key — a steady throttle-down at the normal rate — kicked off at the precise
  // distance where that brings you to dock speed right at the 15 ly mark. The
  // start point is found by forward-simulating the hold-S trajectory.
  if (autopilotAssist && game.contract && game.fuel > 0 && !launching) {
    const apTgt = stations[game.contract.to];
    const apDist = apTgt.pos.distanceTo(ship.pos);
    _dir.copy(apTgt.pos).sub(ship.pos).normalize();
    if (_fwd.dot(_dir) > 0.2) {
      if (!apBraking && ship.beta > DOCK_BETA && apDist < 200 &&
          apDist - DOCK_RADIUS <= apBrakeDistance(ship.beta)) {
        apBraking = true;
      }
      if (apBraking) {
        // hold "S": steady throttle-down, floored at a slow drift so the ship
        // keeps creeping into the dock rather than stopping short of it
        ship.throttle = Math.max(betaToThrottle(0.15), ship.throttle - AP_DECEL * dt);
      }
    }
  }

  // --- speed easing + FUEL: burn |Δrapidity| (proper Δv of the maneuver) ---
  const targetBeta = throttleToBeta(ship.throttle);
  ship.beta += (targetBeta - ship.beta) * Math.min(1, dt * (warpBurn ? WARP_SPOOL : SPOOL));
  const gamma = lorentz(ship.beta);
  const phi = rapidity(ship.beta);
  const dphi = Math.abs(phi - dyn.prevPhi);
  dyn.prevPhi = phi;
  if (dphi > 0 && !game.testFlight) game.fuel = Math.max(0, game.fuel - dphi * fuelFactor());

  // --- pilot-frame pacing: universe time & distance scale with γ (capped).
  // Frozen during the launch window (no motion, no clocks, no aging). In a free
  // test flight there's no contract and no career clock — just movement.
  const c = game.contract;
  const tgt = c ? stations[c.to] : null;
  let dCoord = 0;
  if (!launching) {
    const gc = gammaCap();
    const gPace = gc * Math.tanh(gamma / gc);
    dCoord = PROPER_RATE * gPace * dt;
    ship.pos.addScaledVector(_fwd, ship.beta * dCoord);
    if (!game.testFlight) {                     // test flight doesn't burn the career clock
      ship.coordTime += dCoord;
      const dShip = dCoord / gamma;
      ship.shipTime += dShip;
      game.pilotAge += dShip;
    }
  }
  const dist = tgt ? tgt.pos.distanceTo(ship.pos) : 0;
  if (!launching && c && dist < DOCK_RADIUS && ship.beta < DOCK_BETA) { dock(); return; }

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

  // --- inertial load (the dampers cancel the diverging PROPER accel of cruising;
  // this is the residual maneuvering load the crew/cargo actually feel — how hard
  // you're burning/braking plus a little turning). Bounded, unlike the raw γ³ term.
  const coordAccel = (ship.beta - dyn.prevBeta) / Math.max(dt, 1e-4);
  dyn.prevBeta = ship.beta;
  const loadTarget = (Math.abs(coordAccel) * LOAD_K +
                     THREE.MathUtils.clamp(omegaTurn * ship.beta * 5, 0, 10)) * loadFactor();
  dyn.load += (loadTarget - dyn.load) * Math.min(1, dt * 5);

  // exceed the contract's inertial rating and you damage the load (no cargo to
  // stress in a free test flight)
  if (c) {
    const overG = dyn.load - c.gLimit;
    if (overG > 0) game.integrity = Math.max(0, game.integrity - overG * DMG_RATE * dt);
  }

  const surge = THREE.MathUtils.clamp(Math.abs(coordAccel) / 2.2, 0, 1);
  const feltSurge = Math.max(surge, THREE.MathUtils.clamp(dyn.load / 22, 0, 1));
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
  updateTargetArrow();
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
  // redline payoff: past REDLINE_GAMMA the SPEED & Lorentz readouts glow red and
  // buzz, harder the deeper into the redline you push
  const redline = gamma > REDLINE_GAMMA;
  const shake = redline ? Math.min(1.15, 0.4 + 0.28 * Math.log10(gamma / REDLINE_GAMMA)).toFixed(2) : 0;
  for (const elm of [hud.pct, hud.gamma]) {
    elm.classList.toggle("redline", redline);
    if (redline) elm.style.setProperty("--shake", shake);
  }
  const gl = game.contract && game.contract.gLimit;
  const over = gl && dyn.load > gl;
  hud.gforce.textContent = fmt(dyn.load, 1) + (gl ? " / " + gl + " g" : " g");
  hud.gforce.style.color = over ? "var(--warn)" : (gl && dyn.load > gl * 0.8) ? "var(--gold)" : "var(--hud)";
  hud.age.textContent = game.pilotAge.toFixed(1) + " yr";
  hud.credits.textContent = "₡" + game.credits;
  const cap = tankCap();
  hud.fuel.textContent = game.fuel.toFixed(1) + " / " + cap;
  hud.fuelFill.style.width = (game.fuel / cap * 100).toFixed(1) + "%";
  hud.fuelBar.classList.toggle("low", game.fuel < cap * 0.2);

  hud.throttleFill.style.height = (ship.throttle * 100) + "%";
  hud.throttlePct.textContent = game.fuel <= 0 ? "DEAD STICK" : Math.round(ship.throttle * 100) + "%";

  hud.fxAberr.className = fx.aberration ? "on" : "";
  hud.fxDoppler.className = fx.doppler ? "on" : "";
  hud.fxBeam.className = fx.beaming ? "on" : "";
  hud.fxContract.className = fx.contraction ? "on" : "";
  hud.fxCmb.className = fx.cmb ? "on" : "";

  // contract tracker — hidden in a free test flight (no contract)
  const c = game.contract;
  if (!c) { el("contract").style.display = "none"; hud.countdown.style.display = "none"; return; }
  el("contract").style.display = "";
  hud.cDist.textContent = dist.toFixed(1) + " ly";
  const remaining = c.deadline - (ship.coordTime - c.acceptCoord);
  hud.cDeadline.textContent = "T−" + fmtY(Math.max(0, remaining));
  hud.cDeadline.className = "v" + (remaining < c.deadline * 0.15 ? " bad" : "");
  if (c.type === "passenger") {
    const aged = ship.shipTime - c.acceptShip;
    hud.cAging.textContent = aged.toFixed(2) + " / " + c.maxAging.toFixed(1) + " yr";
    hud.cAging.className = "v" + (aged > c.maxAging * 0.8 ? " bad" : "");
  }
  hud.cRating.textContent = c.gLimit + " g";
  const integPct = Math.round(game.integrity * 100);
  hud.cInteg.textContent = integPct + "%";
  hud.cInteg.className = "v" + (game.integrity < 0.6 ? " bad" : "");
  hud.integFill.style.width = integPct + "%";
  hud.integBar.classList.toggle("hurt", game.integrity < 0.6);
  hud.cPay.textContent = "₡" + contractPay(c);

  // status line: braking guidance & docking
  const lyPerSec = ship.beta * coordRate;              // current ly per real second
  const brakeDist = lyPerSec * 1.5 + 4;                 // rough easing-stop estimate
  // bearing to the destination: +1 = dead ahead, <0 = behind your nose
  _dir.copy(stations[c.to].pos).sub(ship.pos).normalize();
  const bearing = shipForward(_ab).dot(_dir);
  let status = "", cls = "";
  if (game.preflight > 0) {
    status = bearing > 0.985 ? "◈ ON TARGET — hold" : "◷ AIM AT THE MARKER";
    cls = "dockable";
  } else if (dyn.load > c.gLimit) {
    status = "⚠ OVER INERTIAL RATING — ease off";
    cls = "brake";
  } else if (dist < DOCK_RADIUS) {
    status = ship.beta < DOCK_BETA ? "DOCKING…" : "IN RANGE — slow below 0.20c";
    cls = "dockable";
  } else if (bearing < 0) {
    status = "⚠ TARGET ASTERN — turn back to the marker";
    cls = "brake";
  } else if (apBraking) {
    status = "◈ AUTOPILOT DOCKING…";
    cls = "dockable";
  } else if (dist < brakeDist) {
    status = "⚠ CUT THROTTLE — braking distance";
    cls = "brake";
  } else if (game.fuel <= 0) {
    status = "FUEL EXPENDED — call a tow (R / button)";
    cls = "brake";
  }
  hud.cStatus.textContent = status;
  hud.cStatus.className = "status " + cls;

  // pre-launch countdown overlay
  if (game.preflight > 0) {
    hud.countdown.style.display = "block";
    hud.countdown.innerHTML = `<div class="cd-num">${Math.ceil(game.preflight)}</div>` +
      `<div class="cd-hint">AIM AT ${stations[c.to].name}</div>` +
      `<div class="cd-sub">thrust when you're ready to launch</div>`;
  } else if (hud.countdown.style.display !== "none") {
    hud.countdown.style.display = "none";
  }
}

function updateLabels() {
  const labelFade = 1 - THREE.MathUtils.smoothstep(ship.beta, 0.9, 0.97);
  for (let i = 0; i < stations.length; i++) {
    const st = stations[i];
    const isTarget = game.contract && game.contract.to === i;
    // the target label stays visible at any speed; others fade near c
    const fade = isTarget ? 1 : labelFade;
    if (fade <= 0.001) { st.el.style.display = "none"; continue; }
    const dist = st.pos.distanceTo(ship.pos);
    if (dist < 1e-3) { st.el.style.display = "none"; continue; }
    // Project the TRUE station position (not aberrated). A nav marker should read
    // as an honest bearing: it swings to the edge and off-screen as you fly past,
    // instead of aberration pinning it to the forward cone so you can't tell you
    // overshot.
    _proj.copy(st.pos).project(camera);
    // hide behind-camera and near-edge labels so no clipped text hugs the edges
    // (x is tighter because the labels are wide horizontal text)
    if (_proj.z > 1 || _proj.z < -1 ||
        _proj.x < -0.9 || _proj.x > 0.9 || _proj.y < -0.96 || _proj.y > 0.96) {
      st.el.style.display = "none"; continue;
    }
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

// Edge arrow pointing to the contract target whenever it's off-screen (during the
// launch aim, and after an overshoot). Hidden when the target is on-screen — its
// own label marks it then.
function updateTargetArrow() {
  const arrow = hud.targetArrow;
  const c = game.contract;
  if (!c) { arrow.style.display = "none"; return; }
  _proj.copy(stations[c.to].pos).project(camera);
  let x = _proj.x, y = _proj.y;
  const behind = _proj.z > 1;
  if (behind) { x = -x; y = -y; }          // point toward it even when it's behind us
  if (!behind && Math.abs(x) <= 0.94 && Math.abs(y) <= 0.94) { arrow.style.display = "none"; return; }
  const len = Math.hypot(x, y) || 1;
  const nx = x / len, ny = y / len;
  const s = 0.9 / Math.max(Math.abs(nx), Math.abs(ny));   // push out to a screen-edge rect
  const px = (nx * s * 0.5 + 0.5) * window.innerWidth;
  const py = (-ny * s * 0.5 + 0.5) * window.innerHeight;
  const ang = Math.atan2(-ny, nx) * 180 / Math.PI;        // screen-space angle (y flipped)
  arrow.style.display = "block";
  arrow.style.left = px + "px";
  arrow.style.top = py + "px";
  arrow.style.transform = `translate(-50%,-50%) rotate(${ang}deg)`;
}

// ---------------------------------------------------------------------------
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  for (const l of layers) l.uniforms.uPixelRatio.value = renderer.getPixelRatio();
  // the star chart's viewBox tracks its container aspect — refit on resize
  if (game.phase === "station") {
    if (mapSelected >= 0) selectMapNode(mapSelected); else buildStarMap();
  }
  markDirty();
});

// debug hook for automated testing (not used by gameplay)
window.__lighthaul = { game, ship, stations, dock, setPhase };

requestAnimationFrame(frame);
