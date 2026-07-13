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
const REP_PER_DELIVERY = 0.03; // contract pay ramps +3% per successful delivery (reputation)...
const REP_MAX = 0.75;         // ...capped at +75%, a built-in raise atop the Broker License
const DOCK_RADIUS = 15;      // ly
const DOCK_BETA = 0.2;
const THRUST_RATE = 0.14;   // base throttle change per second (W/S, ↑/↓)
const TURBO_X = 4;          // Shift multiplier — "turbo thrust"
const WARP_X = 9;           // X multiplier — "warp thrust", unlocked by Redline Coils
const SPOOL = 2.5;          // drive response: how fast β chases the throttle setting. (Multiplied by Redline Coils level + 1 for warp burn.)
const AP_DECEL = 0.14;      // autopilot throttle-down rate floor = the S-key rate
const AP_BRAKE_G = 0.9995;    // autopilot brakes up to this fraction of the cargo's g-rating
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
    name: "Courier", tag: "FORGIVING", unlock: 0,
    tank: 14, fuelEff: 1.0, damper: 0.85, handling: 1.0, credits: 450,
    pips: { tank: 3, fuel: 3, handling: 3, care: 5 },
    blurb: "Balanced and gentle on the load — quick to point, hard to wreck. The pilot's-first-ship all-rounder.",
  },
  hauler: {
    name: "Hauler", tag: "BULK CARGO", unlock: 3000,      // retire ranked Journeyman Courier
    tank: 20, fuelEff: 1.12, damper: 1.2, handling: 0.7, credits: 320,
    pips: { tank: 5, fuel: 2, handling: 1, care: 2 },
    blurb: "A big-tank freighter for long, fast rugged-cargo runs. Turns like a moon and feels every G — keep fragile passengers off it.",
  },
  interceptor: {
    name: "Interceptor", tag: "HIGH SKILL", unlock: 6000, // retire ranked Master Courier
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
  maxGamma: 1,                // highest Lorentz factor reached this career (a persisted record)
  deepLicense: false,         // earned by delivering after touching γ ≥ DEEP_GAMMA — opens long-haul space
  upgrades: { tank: 0, drive: 0, damper: 0, broker: 0, rejuv: 0, overdrive: 0, autopilot: 0 },
  lastResult: null,
};

// --- persistent records (localStorage): the one thing that outlives a career,
// so every run is measured against your best. Rank is earned on final balance —
// the game's whole pitch is "retire rich", and the nest egg is what you keep.
const RECORDS_KEY = "lighthaul.records.v1";
const RANKS = [        // final-balance thresholds → title (tune after playtesting)
  // the redline tiers: only a Deep Space License era of long hauls climbs here
  [128000, "The Ageless"],
  [64000,  "Deep Space Magnate"],
  [32000,  "Redline Royalty"],
  // reachable on core-cluster work alone
  [16000, "Lightspeed Legend"],
  [10000, "Void Baron"],
  [6000,  "Master Courier"],
  [3000,  "Journeyman Courier"],
  [1000,  "Drifter"],
  [0,     "Deadhead"],
];
function rankFor(bal) { return (RANKS.find(([m]) => bal >= m) || RANKS[RANKS.length - 1])[1]; }
// the rank above the one earned (null at the top) — shown as a target at retirement
function nextRank(bal) {
  const i = RANKS.findIndex(([m]) => bal >= m);
  return i > 0 ? RANKS[i - 1] : null;
}
const records = Object.assign(
  { bestBalance: 0, bestEarned: 0, mostDeliveries: 0, topGamma: 0, careers: 0 },
  (() => { try { return JSON.parse(localStorage.getItem(RECORDS_KEY)) || {}; } catch (_) { return {}; } })()
);
function commitCareer() {                 // fold this career into the saved bests
  const beat = {
    balance: game.credits > records.bestBalance,
    earned: game.earned > records.bestEarned,
    deliveries: game.deliveries > records.mostDeliveries,
    gamma: game.maxGamma > records.topGamma,
  };
  records.bestBalance = Math.max(records.bestBalance, game.credits);
  records.bestEarned = Math.max(records.bestEarned, game.earned);
  records.mostDeliveries = Math.max(records.mostDeliveries, game.deliveries);
  records.topGamma = Math.max(records.topGamma, game.maxGamma);
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
const REDLINE_RAMP = 0.5;     // past the softcap, a slow log climb (see pace()) so redline speeds keep gaining
const REDLINE_GAMMA = 2000;   // γ above which the HUD SPEED/Lorentz readouts go red + buzz
// Deep Space License: complete a delivery having touched this γ (needs Redline
// Coils L3+ — stock tops out at γ 1000) and long-haul brokers open up.
const DEEP_GAMMA = 25000;
const DEEP_MIN = 800, DEEP_MAX = 2500;   // ly — the long-haul halo beyond the cluster
const LONG_HAUL = 500;                   // ly — legs beyond this use the long-haul contract tier
const HUD_FADE_LO = 0.35;     // below this β the desktop help/effects panels are fully shown...
const HUD_FADE_HI = 0.85;     // ...above this they've faded away (only after the first delivery)

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

// Effective γ used for coordinate-time / distance accrual (the "pace"). Below the
// cap it equals the raw γ (true proper velocity βγ). Past the cap the tanh would
// flat-line, so a slow logarithmic tail keeps redline speeds covering ground
// faster — noticeably, but so damped a leg can never pass in a single frame.
// Used by both the flight loop and the autopilot brake-distance sim, so they stay
// in sync. Aging (d/βγ) and deadlines (d/β) are untouched — this is wall-clock only.
function pace(gamma) {
  const gc = gammaCap();
  return gc * Math.tanh(gamma / gc) + REDLINE_RAMP * gc * Math.log1p(Math.max(0, gamma / gc - 1));
}

function throttleToBeta(t) {
  t = Math.max(0, Math.min(1, t));
  return Math.min(1 - Math.pow(1 - t, 3), capBeta());
}
function betaToThrottle(b) {
  return 1 - Math.cbrt(1 - Math.min(b, capBeta()));
}
const rapidity = (b) => Math.atanh(Math.min(b, capBeta()));

// Forward-simulate the throttle-down from a given speed to find how many ly it
// takes to bleed to dock speed — i.e. the distance out at which the autopilot
// must start braking. Mirrors the real throttle/β/pacing dynamics from update(),
// at whatever throttle-down rate the autopilot has chosen for this cargo.
function apBrakeDistance(beta0, decel) {
  let beta = beta0;
  let throttle = betaToThrottle(beta0);
  let dist = 0;
  const h = 0.05;                       // integration step (= the game's dt cap)
  for (let i = 0; i < 2000 && beta > DOCK_BETA; i++) {
    throttle = Math.max(0, throttle - decel * h);
    beta += (throttleToBeta(throttle) - beta) * Math.min(1, h * SPOOL);
    const gp = pace(lorentz(beta));
    dist += beta * PROPER_RATE * gp * h;
  }
  return dist;
}

// How hard the autopilot may brake for this contract: aim the peak maneuvering
// load at AP_BRAKE_G of the g-rating, so rugged cargo stops late & hard while
// fragile freight still eases in. During the brake β tracks the throttle, so
// peak |dβ/dt| ≈ 2.7·decel (the throttle→β cubic steepens as throttle falls),
// and felt load = |dβ/dt|·LOAD_K·loadFactor — invert that for the rate. Never
// gentler than the old fixed rate, nor wilder than 5× it.
function apDecelFor(gLimit) {
  const d = (gLimit * AP_BRAKE_G) / (LOAD_K * loadFactor() * 2.7);
  return THREE.MathUtils.clamp(d, AP_DECEL, AP_DECEL * 5);
}
// The rate the autopilot actually pulls the throttle down: the g-budgeted rate,
// but never faster than the player's own best throttle-down (turbo, or warp with
// Redline Coils, scaled by handling) — so the assist can't do the superhuman
// instant stop a hot arrival would otherwise get.
function apDecelRate(gLimit) {
  const playerMax = THRUST_RATE * (game.upgrades.overdrive > 0 ? WARP_X : TURBO_X) * shipCls().handling;
  return Math.min(apDecelFor(gLimit), playerMax);
}

// --- upgrade effects: each derived dial folds in the owned level. Kept as live
// getters (not baked constants) so buying mid-career takes effect immediately.
const UP_KEYS = Object.keys(UPGRADES);
function shipCls()   { return CLASSES[game.cls]; }                                    // active ship class
function tankCap()   { return shipCls().tank + game.upgrades.tank * 3; }              // Δv capacity
function retireAge() { return RETIRE_AGE + game.upgrades.rejuv * 6; }                 // career length (pilot, not ship)
function loadFactor(){ return shipCls().damper * (1 - game.upgrades.damper * 0.15); } // felt maneuvering load ×
function fuelFactor(){ return shipCls().fuelEff * (1 - game.upgrades.drive * 0.12); } // fuel burned ×
function payMult()   { return 1 + game.upgrades.broker * 0.08; }        // contract pay × (Broker License)
function repMult()   { return 1 + Math.min(game.deliveries * REP_PER_DELIVERY, REP_MAX); } // reputation ramp
function contractPay(c) { return Math.round(c.pay * payMult() * repMult()); }

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
              "th", "dr", "kr", "tr", "br", "st", "ph", "vel", "cor",
              "f", "h", "j", "p", "w", "sh", "ch", "gr", "pr", "fr", "cl", "gl",
              "bl", "sk", "sp", "sl", "thr", "str", "vor", "mor", "sar", "hel",
              "ser", "zor", "syn", "lyr", "thal", "cyg"];
const _LC = ["b", "d", "g", "k", "l", "m", "n", "r", "s", "t", "v", "z",
             "c", "f", "p", "x", "th", "sh", "ch", "ph", "ss", "ll", "nn", "rr",
             "nd", "nt", "rn", "ld", "sk", "st", "dr", "tr"];
const _LV = ["a", "e", "i", "o", "u", "y"];   // medial vowel stays crisp (diphthongs pile up if repeated)
const _LV1 = ["a", "e", "i", "o", "u", "ae", "ei", "ia", "au", "y",
              "ea", "eo", "io", "oa", "ou", "ui", "ya", "yo"];
const _LEND = ["n", "r", "s", "l", "x", "th", "is", "or", "yx",
               "m", "k", "d", "sh", "ss", "ll", "rn", "sk", "st", "nx", "rk",
               "ld", "nt", "ron", "dor", "thar", "vex", "nyx", "rax", "dex", "mir", "var"];
const _SUFFIX = [
  "Station", 
  "Port", 
  "Relay", 
  "Anchorage", 
  "Hub", 
  "Gate", 
  "Depot", 
  "Yards",
  "Outpost",
  "Citadel",
  "Nexus",
  "Terminal",
  "Dock",
  "Haven",
  "Bastion",
  "Platform",
  "Array",
  "Beacon",
  "Sentinel",
  "Forge",
  "Spire",
  "Ring",
  "Core",
  "Node",
  "Stronghold",
  "Enclave",
  "Aerie",
  "Perch",
  "Vista",
  "Orbital"
];
// strip the trailing " <Suffix>" for compact map labels — derived from _SUFFIX
// so any suffix added above is trimmed automatically (all are plain words)
const _SUFFIX_RE = new RegExp(" (?:" + _SUFFIX.join("|") + ")$");
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

  // Deep-space halo: a few far stations (DEEP_MIN–DEEP_MAX ly out) for licensed
  // long-haul work. Same seeded rng, so a seed replays them; hidden from the
  // chart, contracts, and flight labels until the career earns the license.
  const deepN = 3 + ((rng() * 2) | 0);
  let dguard = 0;
  while (built.filter((s) => s.deep).length < deepN && dguard++ < 200) {
    const p = new THREE.Vector3(rng() * 2 - 1, (rng() * 2 - 1) * 0.4, rng() * 2 - 1)
      .normalize().multiplyScalar(DEEP_MIN + rng() * (DEEP_MAX - DEEP_MIN));
    if (built.every((s) => !s.deep || s.pos.distanceTo(p) > 400)) {
      built.push({ name: stationName(), pos: p, deep: true });
    }
  }

  // Each dock stocks a fixed pair of outfits, so different places sell different
  // upgrades — the map is worth learning. Guarantee every upgrade is sold in the
  // CORE cluster (deep stations are gated, so nothing essential may hide there).
  built.forEach((s) => {
    const a = _pick(UP_KEYS);
    let b = _pick(UP_KEYS);
    while (b === a) b = _pick(UP_KEYS);
    s.shop = [a, b];
  });
  const core = built.filter((s) => !s.deep);
  UP_KEYS.forEach((k) => {
    if (!core.some((s) => s.shop.includes(k))) {
      core[(rng() * core.length) | 0].shop[(rng() * 2) | 0] = k;
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
    st.name = b.name; st.pos = b.pos; st.shop = b.shop; st.deep = !!b.deep;
    st._shown = true;   // no inline display yet = visible; first label pass may need to hide it
    st.el.querySelector(".nm").textContent = b.name;
  });
  // drop leftovers when a re-seed produced fewer stations (deep count varies 3–4)
  for (let i = built.length; i < stations.length; i++) stations[i].el.remove();
  stations.length = built.length;
}
placeStations(randomSeed());   // an initial cluster so menus/test-flight work pre-career

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------
const CARGO = ["medical isotopes", "a cryo seed vault", "quantum cores", "antimatter cells",
  "archive crystals", "terraforming spores", "vaccine printers", "a reactor lattice",
  "orbital tether spools", "heirloom soil", "singularity ballast", "a caged plasma sun",
  "prototype warp coils", "memory diamonds", "a bonsai biosphere", "salvaged AI cores",
  "a monastery's relics", "self-replicating looms", "cryo-preserved coral", "living timber",
  "a shard of a dead moon", "unlabeled medical vats", "a black-box flight recorder",
  "gene-locked seed grain", "a whale in a tank", "contraband star charts"];
// Passenger templates: {N} fills with a generated person/house name, {P} with a
// generated place — same seeded generators as the station names, so every career
// meets fresh people from worlds that may not even be on the chart.
const PAX = ["Dr. {N}", "Envoy {N}", "the {N} family", "a colonist cohort from {P}",
  "Magistrate {N}", "two exogeologists", "a stasis choir from {P}", "Capt. {N} (ret.)",
  "a diplomatic quartet", "the last archivist of {P}", "Ambassador {N}",
  "the {N} twins", "a pilgrim caravan from {P}", "a fugitive heiress", "a touring orchestra",
  "three cryo-nauts", "a xenolinguist", "Dr. {N} and her live samples", "a newlywed couple",
  "a witness in protective transit", "an off-world monk", "a delegation of terraformers from {P}"];

// A place a shipment hails from — sometimes a bare world, sometimes a full
// facility name. It doesn't need to exist on the chart; the galaxy is bigger
// than your cluster.
function placeName() { return rng() < 0.4 ? stationName() : coreName(); }
function fillNames(t) {
  return t.replace("{N}", coreName()).replace("{P}", placeName());
}
function cargoName() { return _pick(CARGO) + (rng() < 0.7 ? " from " + placeName() : ""); }
function paxName() { return fillNames(_pick(PAX)); }

// Long-haul-only flavor: shipments and sleepers that suit a thousand-ly crossing.
const CARGO_DEEP = ["a generation-ship seed core", "a dormant AI archive",
  "the relics of a lost expedition", "a prefabbed embassy, crated", "a sealed sleeper vault"];
const PAX_DEEP = ["a cryo-sealed magnate", "the exiled heir of {P}", "a deep-survey crew in stasis",
  "an exiled queen and her court", "a terraforming vanguard in cryo"];

// One offer for the leg fromIdx → t. Legs beyond LONG_HAUL ly use the long-haul
// tier: flatter pay per ly (they'd trivialize the economy otherwise), and
// passenger aging caps that stay HUMAN (2–6 yr) no matter the distance — cryo
// transit whose caps demand averaging γ in the hundreds. Only redline hardware
// can fly those; below it your own aging (d/βγ) kills the run anyway.
function makeOffer(fromIdx, t) {
  const d = stations[fromIdx].pos.distanceTo(stations[t].pos);
  const long = d > LONG_HAUL;
  // inertial rating: max maneuvering G the load tolerates. Lower = more
  // fragile = must burn/brake gently = a demand premium on the pay.
  if (rng() < 0.55) {
    // cargo: universe-time deadline — requires a minimum average speed
    const betaReq = long ? 0.9 + rng() * 0.09 : 0.55 + rng() * 0.4;
    const gLimit = Math.round(4 + rng() * 14);        // 4–18 g
    return {
      type: "cargo", long, to: t, d, gLimit,
      what: long && rng() < 0.4 ? fillNames(_pick(CARGO_DEEP)) : cargoName(),
      deadline: d / betaReq + (long ? 25 : 4),
      pay: long
        ? Math.round((250 + d * (0.45 + (betaReq - 0.9) * 2)) * (1 + Math.max(0, 11 - gLimit) * 0.05))
        : Math.round((90 + d * (0.9 + (betaReq - 0.5) * 3.2)) * (1 + Math.max(0, 11 - gLimit) * 0.05)),
    };
  }
  if (long) {
    // long-haul passage: cryo pods. The cap is a human handful of years over a
    // thousand-ly leg — that's an average γ in the hundreds, redline territory.
    const maxAging = 2 + rng() * 4;                    // 2–6 yr, distance be damned
    const gLimit = Math.round(3 + rng() * 4);          // 3–7 g (fragile pods)
    return {
      type: "passenger", long, to: t, d, gLimit,
      what: rng() < 0.45 ? fillNames(_pick(PAX_DEEP)) : paxName(),
      deadline: d / 0.7 + 50,
      maxAging,
      pay: Math.round((400 + d * 0.55) * (1 + Math.max(0, 8 - gLimit) * 0.06)),
    };
  }
  // passenger: ship-time aging cap — requires a minimum average gamma. Kept
  // humane: γ demands top out near 0.997c (not an impossible 0.9993c), and
  // the cap carries a fixed +slack for the accel/brake ramp — which ages them
  // at low γ, worse the gentler (lower-g) the ramp has to be.
  const gReq = 4 + rng() * 12;                         // need average γ ≈ 3–13
  const gLimit = Math.round(4 + rng() * 4);            // 4–8 g (humans)
  return {
    type: "passenger", long, to: t, d, gLimit,
    what: paxName(),
    deadline: d / 0.7 + 10,
    maxAging: d / gReq * 1.25 + 1.5,
    pay: Math.round((160 + d * (0.7 + gReq * 0.2)) * (1 + Math.max(0, 8 - gLimit) * 0.06)),
  };
}

function makeContracts(fromIdx) {
  const offers = [];
  const used = new Set([fromIdx]);
  // Always three offers on the board. Licensed docks mix in the deep halo —
  // randomly 1 or 2 long-haul slots; the rest stay core-cluster work.
  const nLong = game.deepLicense ? 1 + ((rng() * 2) | 0) : 0;
  let guard = 0;
  while (offers.length < 3 - nLong && guard++ < 200) {
    const t = (rng() * stations.length) | 0;
    if (used.has(t) || stations[t].deep) continue;
    used.add(t);
    offers.push(makeOffer(fromIdx, t));
  }
  if (nLong) {
    const deepIdx = stations.map((s, i) => (s.deep && i !== fromIdx ? i : -1)).filter((i) => i >= 0);
    while (offers.length < 3 && deepIdx.length) {
      const t = deepIdx.splice((rng() * deepIdx.length) | 0, 1)[0];
      offers.push(makeOffer(fromIdx, t));
    }
    // deep neighbours ran short (e.g. docked out in the halo) — top up with core
    guard = 0;
    while (offers.length < 3 && guard++ < 200) {
      const t = (rng() * stations.length) | 0;
      if (used.has(t) || stations[t].deep) continue;
      used.add(t);
      offers.push(makeOffer(fromIdx, t));
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
  if (p === "flight") { uiHidden = false; el("hud").style.opacity = 1; setFlightHelp(); }   // clear leftover hide; set the cheat-sheet
  if (p !== "flight") document.body.classList.remove("deadstick");
  if (p !== "flight") audio.silence();     // don't let the engine drone hang on non-flight screens
  // generate the three contracts once, on arrival — not on every re-render
  // (so refuelling doesn't re-roll the offers)
  if (p === "station") { game.offers = makeContracts(game.station); mapSelected = -1; buildStation(); }
  if (p === "results") buildResults();
  if (p === "over") buildGameOver();
  markDirty();
}

function fmtY(y) { return y >= 1000 ? (y / 1000).toFixed(2) + " kyr" : y.toFixed(1) + " yr"; }
// Lorentz factor for the records — a plain rounded integer with thousands
// separators (γ ranges from 1 to ~1e6 with maxed Redline Coils).
function fmtGamma(g) { return Math.round(g).toLocaleString(); }

function buildStation() {
  const s = stations[game.station];
  resetRetire();                          // clear any armed "confirm retire" on a fresh render
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
    el("map-detail").innerHTML = '<span class="dim">Tap a destination to plan the run.</span>';
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
  if (k === "autopilot") { apUnlocked = true; autopilotAssist = true; updateAutopilotIndicator(false); }
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
// retiring ends the career, so it takes a confirming second tap (auto-disarms
// after a few seconds, and any dock re-render resets it)
let retireArmed = false, retireTimer = null;
function resetRetire() {
  retireArmed = false;
  clearTimeout(retireTimer);
  const b = el("st-retire");
  b.textContent = "RETIRE NOW";
  b.classList.remove("armed");
}
el("st-retire").addEventListener("click", () => {
  if (retireArmed) { resetRetire(); setPhase("over"); return; }
  retireArmed = true;
  const b = el("st-retire");
  b.textContent = "CONFIRM RETIRE?";
  b.classList.add("armed");
  clearTimeout(retireTimer);
  retireTimer = setTimeout(resetRetire, 3000);
});

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
let mapSelected = -1;

// The minimum this contract demands: the slowest average speed that still meets
// its clause, plus whether your governor can reach it and your tank can afford
// the round-trip Δv. Cargo is bound by the universe-time deadline (d/β); a
// passenger by the aging cap (d/βγ ≤ maxAging → βγ ≥ K, closed-formed below).
function contractReq(c) {
  const d = c.d;
  let betaMin;
  if (c.type === "cargo") {
    betaMin = d / c.deadline;
  } else {
    const K = d / c.maxAging;                       // required proper velocity βγ
    betaMin = Math.max(K / Math.sqrt(1 + K * K), d / c.deadline);   // aging vs the soft deadline
  }
  betaMin = Math.min(betaMin, 1 - 1e-12);
  const dv = 2 * Math.atanh(betaMin);               // accel + brake at that speed
  const reachable = betaMin <= capBeta();
  const affordable = dv <= game.fuel;
  // Meeting the clause isn't enough on a long haul — YOU age d/βγ too. Check the
  // aging at the fastest speed you can afford against your remaining career.
  const pb = planBeta();
  const survivable = pb > 1e-9 && game.pilotAge + d / (pb * lorentz(pb)) < retireAge();
  return { betaMin, gammaMin: lorentz(betaMin), dv, reachable, affordable, survivable,
           feasible: reachable && affordable && survivable };
}
// Fastest round-trip speed your current Δv (and governor) allows — for planning
// a leg to a station with no contract. 2·atanh(β) = fuel ⇒ β = tanh(fuel/2).
function planBeta() { return Math.min(Math.tanh(game.fuel / 2), capBeta()); }

// β near c needs many 9s to read right (γ carries the real precision).
function fmtBeta(b) {
  if (b < 0.9999) return b.toFixed(4);
  const nines = Math.min(9, Math.floor(-Math.log10(Math.max(1 - b, 1e-12))));
  return b.toFixed(nines + 2);
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

  // Fit the CORE cluster only — deep-space stations are hundreds of ly out and
  // would crush the cluster to a dot; they render as edge markers instead.
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const s of stations) {
    if (s.deep) continue;
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
    if (s.deep) return;
    s._mx = W / 2 + (s.pos.x - cx) * scale;
    s._my = H / 2 + (s.pos.z - cz) * scale;
  });

  // Label layout: estimate each label's footprint and dodge neighbours — prefer
  // the right side, flip left or nudge vertically when names would collide.
  // `placed` starts with every node dot so labels never sit on other stations.
  const placed = stations.filter((st) => !st.deep)
    .map((st) => ({ x1: st._mx - 2.6, y1: st._my - 2.6, x2: st._mx + 2.6, y2: st._my + 2.6 }));
  const collides = (b, skip) => placed.some((o, idx) =>
    idx !== skip && b.x1 < o.x2 && b.x2 > o.x1 && b.y1 < o.y2 && b.y2 > o.y1);
  stations.forEach((st, i) => {
    if (st.deep) return;
    const c = game.offers.find((o) => o.to === i);
    st._nm = st.name.replace(_SUFFIX_RE, "");
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

  // Deep-space stations (licensed only): pinned to the chart border along their
  // true bearing from the cluster centre — signposts pointing off the map. Each
  // marker carries a label stack (name · distance · contract), so its footprint
  // dodges the core labels (already in `placed`) and earlier markers by sliding
  // along the border until it finds clear sky; the chosen box joins `placed`.
  const deeps = [];
  if (game.deepLicense) {
    const m = 10;
    stations.forEach((s, i) => { if (s.deep) deeps.push([s, i]); });
    for (const [s, i] of deeps) {
      const dx = s.pos.x - cx, dz = s.pos.z - cz;
      const len = Math.hypot(dx, dz) || 1;
      const ux = dx / len, uz = dz / len;
      const tX = ux > 1e-6 ? (W - m - W / 2) / ux : ux < -1e-6 ? (m - W / 2) / ux : Infinity;
      const tY = uz > 1e-6 ? (H - m - H / 2) / uz : uz < -1e-6 ? (m - H / 2) / uz : Infinity;
      const t = Math.min(tX, tY);
      const bx = W / 2 + ux * t, by = H / 2 + uz * t;
      const vert = tX < tY;                  // pinned to a left/right border
      // label footprint at a candidate border point — mirrors the render layout
      const c = game.offers.find((o) => o.to === i);
      const w = Math.max(3 + s.name.replace(_SUFFIX_RE, "").length * 1.9, c ? 24 : 14);
      const rows = c ? 3 : 2;
      const boxAt = (px, py) => {
        if (vert) {
          const y0 = THREE.MathUtils.clamp(py - 1, 4.5, H - 3 - rows * 3.6);
          return px > W / 2
            ? { x1: px - 4 - w, y1: y0 - 3, x2: px + 2, y2: y0 + (rows - 1) * 3.6 + 1 }
            : { x1: px - 2, y1: y0 - 3, x2: px + 4 + w, y2: y0 + (rows - 1) * 3.6 + 1 };
        }
        const lx = THREE.MathUtils.clamp(px, 20, W - 20);
        if (py < H / 2) return { x1: lx - w / 2, y1: py - 2, x2: lx + w / 2, y2: py + 5 + (rows - 1) * 3.6 + 1 };
        return { x1: lx - w / 2, y1: py - 6 - (rows - 1) * 3.6, x2: lx + w / 2, y2: py + 2 };
      };
      // slide along the border, nearest-to-bearing first, to the first clear
      // spot; on a crowded border, settle for the least-overlapping candidate
      const ovl = (b) => placed.reduce((a, o) => {
        const ow = Math.min(b.x2, o.x2) - Math.max(b.x1, o.x1);
        const oh = Math.min(b.y2, o.y2) - Math.max(b.y1, o.y1);
        return a + (ow > 0 && oh > 0 ? ow * oh : 0);
      }, 0);
      let best = null;
      for (const off of [0, 9, -9, 18, -18, 27, -27, 36, -36, 45, -45, 54, -54, 63, -63, 72, -72]) {
        const qx = vert ? bx : THREE.MathUtils.clamp(bx + off, m, W - m);
        const qy = vert ? THREE.MathUtils.clamp(by + off, m, H - m) : by;
        const a = ovl(boxAt(qx, qy));
        if (!best || a < best.a) best = { qx, qy, a };
        if (a === 0) break;
      }
      s._mx = best.qx; s._my = best.qy; s._vert = vert;
      placed.push(boxAt(best.qx, best.qy));
    }
  }

  let out = "";
  const dock = stations[game.station];
  for (const c of game.offers) {
    const b = stations[c.to];
    if (b._mx === undefined) continue;       // unlicensed deep target (shouldn't happen)
    out += `<line x1="${dock._mx}" y1="${dock._my}" x2="${b._mx}" y2="${b._my}" class="map-edge${b.deep || dock.deep ? " deep" : ""}" data-edge="${c.to}"/>`;
  }
  stations.forEach((st, i) => {
    if (st.deep) return;                     // rendered as edge markers below
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
      const ok = contractReq(c).feasible;
      out += `<text x="${tx}" y="${st._my + 4.6 + st._ldy}"${anchor} class="map-sub ${ok ? "ok" : "no"}">` +
        `${ok ? "✓" : "✗"} ₡${contractPay(c)} · ${c.gLimit}g</text>`;
    }
    out += `</g>`;
  });
  // deep edge markers: hollow ring + name, distance, and contract line
  for (const [s, i] of deeps) {
    const c = game.offers.find((o) => o.to === i);
    const cls = i === game.station ? "dock" : c ? "dest" : "node";
    const rows = [[s.name.replace(_SUFFIX_RE, ""), `map-label ${cls}`],
                  [s.pos.distanceTo(dock.pos).toFixed(0) + " ly", "map-sub dim"]];
    if (c) {
      const ok = contractReq(c).feasible;
      rows.push([`${ok ? "✓" : "✗"} ₡${contractPay(c)} · ${c.gLimit}g`, `map-sub ${ok ? "ok" : "no"}`]);
    }
    let anchor = "", tx;
    if (s._vert) {
      const right = s._mx > W / 2;
      anchor = right ? ' text-anchor="end"' : "";
      tx = right ? s._mx - 3.6 : s._mx + 3.6;
    } else {
      anchor = ' text-anchor="middle"';
      tx = THREE.MathUtils.clamp(s._mx, 20, W - 20);
    }
    let y0;                                   // first text row baseline
    if (s._vert) y0 = THREE.MathUtils.clamp(s._my - 1, 4.5, H - 3 - rows.length * 3.6);
    else if (s._my < H / 2) y0 = s._my + 5;                     // top border: stack downward
    else y0 = s._my - 3 - (rows.length - 1) * 3.6;              // bottom border: stack upward
    out += `<g class="map-hit" data-i="${i}">` +
      `<circle cx="${s._mx}" cy="${s._my}" r="7" class="hit"/>` +
      `<circle cx="${s._mx}" cy="${s._my}" r="2" class="map-node deepring ${cls}"/>`;
    rows.forEach((r, k) => {
      out += `<text x="${tx}" y="${(y0 + k * 3.6).toFixed(1)}"${anchor} class="${r[1]}">${r[0]}</text>`;
    });
    out += `</g>`;
  }
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
  const d = stations[game.station].pos.distanceTo(stations[i].pos);
  const c = game.offers.find((o) => o.to === i);

  // Speed the trip breakdown is based on: a passenger holds the aging-cap
  // minimum (that's the whole job); cargo and empty legs fly the fastest your Δv
  // affords — cargo's deadline is easy, so the real cost is the fuel you spend to
  // stay young.
  let beta, gamma, verdict = "", feasible = true;
  let html = "";
  if (c) {
    const req = contractReq(c);
    feasible = req.feasible;
    const frag = c.gLimit <= 6 ? `<span class="frag">fragile: ${c.gLimit}g rating</span>` : `rugged: ${c.gLimit}g rating`;
    html += `<div class="job">${c.long ? "LONG-HAUL " : ""}${c.type === "cargo" ? "FREIGHT" : "PASSAGE"} — ${c.what}<span class="pay">₡${contractPay(c)}</span></div>`;
    html += c.type === "cargo"
      ? `<div class="req">deadline <b>${fmtY(c.deadline)}</b> universe-time · needs ≥ <b>${fmtBeta(req.betaMin)}c</b> average</div>`
      : `<div class="req">must arrive aged ≤ <b>${c.maxAging.toFixed(1)} yr</b> · keep average γ ≥ <b>${req.gammaMin.toFixed(1)}</b></div>`;
    html += `<div class="req">${frag} · to <b>${stations[i].name}</b></div>`;
    verdict = !req.reachable ? `<span class="bad">✗ too fast for your governor — needs Redline Coils</span>`
            : !req.affordable ? `<span class="bad">✗ not enough Δv — need ${req.dv.toFixed(1)}, refuel first</span>`
            : !req.survivable ? `<span class="bad">✗ you'd age out en route — need more speed (Δv or Redline Coils)</span>`
            : `<span class="good">✓ you can make this run</span>`;
    if (c.type === "passenger") { beta = req.betaMin; gamma = req.gammaMin; }
    else { beta = planBeta(); gamma = lorentz(beta); }
  } else {
    beta = planBeta(); gamma = lorentz(beta);
    html += `<div class="name">${stations[i].name}</div><div class="dim">no contract here — trip planner</div>`;
  }

  // trip breakdown at that speed
  const dv = 2 * Math.atanh(Math.min(beta, 1 - 1e-12));
  const uni = beta > 1e-9 ? d / beta : Infinity;
  const aged = beta > 1e-9 ? d / (beta * gamma) : Infinity;
  const gTxt = gamma < 20 ? gamma.toFixed(1) : fmtGamma(gamma);
  const lead = (c && c.type === "passenger") ? "at the minimum" : "at your best affordable";
  html += `<div class="trip">` +
    `<span class="k">distance</span> ${d.toFixed(0)} ly &nbsp;·&nbsp; ${lead} <b>${fmtBeta(beta)}c</b> (γ ${gTxt})<br/>` +
    `<span class="k">Δv</span> <span class="${dv <= game.fuel + 1e-6 ? "" : "bad"}">${dv.toFixed(1)}</span> / ${game.fuel.toFixed(1)} ` +
    `&nbsp;·&nbsp; <span class="k">universe</span> ${fmtY(uni)} &nbsp;·&nbsp; <span class="k">you age</span> <b>${aged.toFixed(2)} yr</b>` +
    `</div>`;

  if (c) html += `<div class="verdict">${verdict}` +
    ` <button class="btn ${feasible ? "gold" : ""}" id="map-accept" style="margin-left:8px;padding:5px 12px">ACCEPT & UNDOCK</button></div>`;
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

// ---------------------------------------------------------------------------
// Ship card — the current ship's effective stats (base class + owned upgrades).
// Opened by tapping the ship strip at the dock.
// ---------------------------------------------------------------------------
function openShip() { buildShipStats(); el("shipcard").classList.remove("hiddenS"); }
function closeShip() { el("shipcard").classList.add("hiddenS"); }

// The current cumulative effect of an owned outfit, for the ship-stats legend.
function outfitEffect(k) {
  const u = game.upgrades;
  switch (k) {
    case "tank":      return `+${u.tank * 3} Δv capacity`;
    case "drive":     return `−${u.drive * 12}% fuel burned`;
    case "damper":    return `−${u.damper * 15}% felt load`;
    case "broker":    return `+${u.broker * 8}% contract pay`;
    case "rejuv":     return `+${u.rejuv * 6} yr before retirement`;
    case "overdrive": return `top speed ${u.overdrive} nine${u.overdrive > 1 ? "s" : ""} nearer c`;
    case "autopilot": return "auto-brakes you to a clean dock";
  }
  return "";
}

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
    row("contract pay", "×" + (payMult() * repMult()).toFixed(2),
      `${u.broker ? `broker +${u.broker * 8}%` : "no broker"} · reputation +${Math.round((repMult() - 1) * 100)}%`,
      q(payMult() * repMult(), false)) +
    row("retires at", retireAge().toFixed(0),
      u.rejuv ? `base ${RETIRE_AGE} + ${u.rejuv * 6} · rejuv` : `base ${RETIRE_AGE}`) +
    row("docking assist", owned ? "installed" : "—", owned ? "auto-brakes to a clean dock" : "");

  // Owned-outfits legend: the same symbol each upgrade wears on the flight HUD
  // and in the dock's shop, so players learn what the badges mean.
  const ownedKeys = UP_KEYS.filter((k) => k === "autopilot" ? owned : u[k] > 0);
  let outfitsHtml = '<div class="sc-outfit-hd">OUTFITS INSTALLED</div>';
  if (!ownedKeys.length) {
    outfitsHtml += `<div class="sc-outfit-empty">None yet — buy outfits at any dock's OUTFITTING.</div>`;
  } else {
    outfitsHtml += ownedKeys.map((k) => {
      const up = UPGRADES[k], lv = k === "autopilot" ? 1 : u[k], max = up.costs.length;
      let pips = "";
      if (!up.oneShot) for (let i = 0; i < max; i++) pips += `<span class="pip ${i < lv ? "on" : ""}"></span>`;
      const lvChip = up.oneShot ? "" : `<span class="sc-olv">${ROMAN[lv]}</span>`;
      return `<div class="sc-outfit"><span class="sc-oi">${up.icon}</span>` +
        `<span class="sc-om"><span class="sc-onm"><b>${up.name}</b>${lvChip}</span>` +
        `<span class="sc-oe">${outfitEffect(k)}</span></span>` +
        `<span class="pips">${pips}</span></div>`;
    }).join("");
  }
  el("shipcard-outfits").innerHTML = outfitsHtml;
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
  // no "undocked" toast — the countdown's "AIM AT <dest>" already confirms it
  // (and the two overlapped on mobile)
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
  // Deep Space License: a clean delivery after touching deep-γ proves you can
  // survive redline — long-haul brokers open their books.
  if (!game.deepLicense && ok && game.maxGamma >= DEEP_GAMMA) {
    game.deepLicense = true;
    notes.push(`◈ DEEP SPACE LICENSE earned — you delivered after touching γ ${fmtGamma(game.maxGamma)}. Long-haul stations are now on your chart.`);
    showEggToast("◈ DEEP SPACE LICENSE — long-haul brokers know your name");
  }
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
      `<b>${r.c.what}</b> → <b>${stations[r.c.to].name}</b><br/>` +
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
  // A debug career is a play-test, so it never touches the saved records.
  // Otherwise commit exactly once per career (setPhase("over") only fires on a
  // real transition, but guard anyway so a re-render can't double-count).
  const noRecord = { balance: false, earned: false, deliveries: false, gamma: false };
  const prevBest = records.bestBalance;      // to detect hull unlocks crossed this career
  const beat = (game.debug || game._recorded) ? noRecord : commitCareer();
  game._recorded = true;
  // hull unlocks earned by this retirement
  let unlockHtml = "";
  for (const [key, c] of Object.entries(CLASSES)) {
    if (c.unlock > 0 && prevBest < c.unlock && records.bestBalance >= c.unlock) {
      unlockHtml += `<div class="ship-unlock">★ ${c.name.toUpperCase()} UNLOCKED — a new hull waits on the select screen</div>`;
    }
  }
  updateTitleRecords();
  const star = (on) => on ? ` <span class="rec-new">★ record</span>` : "";
  el("go-title").textContent = forced ? "Mandatory retirement" : "Retired";
  const nxt = nextRank(game.credits);
  el("go-body").innerHTML =
    `<div class="rank">rank earned · <b class="gold-t">${rankFor(game.credits)}</b>` +
    (nxt ? `<span class="rank-next">next · ${nxt[1]} at ₡${nxt[0].toLocaleString()}</span>` : "") + `</div>` +
    `You hung up the flight suit at <b>${game.pilotAge.toFixed(1)}</b>, flying the <b>${shipCls().name}</b>.<br/>` +
    `While you flew, the universe aged <b>${fmtY(ship.coordTime)}</b> — ` +
    `you lived <b>${fmtY(ship.shipTime)}</b> of it aboard.<br/>` +
    `Deliveries <b class="good">${game.deliveries}</b>${star(beat.deliveries)} · ` +
    `botched/towed <b class="bad">${game.failures}</b> · ` +
    `peak <b>γ ${fmtGamma(game.maxGamma)}</b>${star(beat.gamma)}<br/>` +
    `Career earnings <b class="gold-t">₡${game.earned}</b>${star(beat.earned)} · ` +
    `final balance <b class="gold-t">₡${game.credits}</b>${star(beat.balance)}` +
    unlockHtml +
    (game.debug ? `<div class="alltime">◈ debug career — not recorded</div>` :
    `<div class="alltime">— all-time —&nbsp; richest retirement <b class="gold-t">₡${records.bestBalance}</b>` +
    ` · most deliveries <b>${records.mostDeliveries}</b> · top <b>γ ${fmtGamma(records.topGamma)}</b>` +
    ` · careers flown <b>${records.careers}</b></div>`);
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
    ` · <span class="k">top γ</span> <b>${fmtGamma(records.topGamma)}</b>` +
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
let apUnlocked = false;        // once bought or egg-enabled: the HUD badge shows + toggles it
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

// Hulls unlock on your best retirement: prove yourself in the Courier first.
// (Debug bypasses; test flights of locked hulls stay allowed as a teaser.)
function shipUnlocked(key) { return debugArmed || records.bestBalance >= CLASSES[key].unlock; }

// ship-class picker (shown once, at the top of a career)
function buildClassSelect() {
  const box = el("class-list");
  if (!box) return;
  const pipBar = (n) => { let s = ""; for (let i = 0; i < 5; i++) s += `<span class="pip ${i < n ? "on" : ""}"></span>`; return s; };
  const stat = (lab, n) => `<div class="cc-stat"><span class="cc-lab">${lab}</span><span class="pips">${pipBar(n)}</span></div>`;
  box.innerHTML = "";
  for (const [key, c] of Object.entries(CLASSES)) {
    const unlocked = shipUnlocked(key);
    const div = document.createElement("div");
    div.className = "classcard" + (unlocked ? "" : " locked");
    div.innerHTML =
      `<div class="cc-art" data-cls="${key}" title="Take it for a test flight">${SHIP_ART[key]}` +
      `<span class="cc-testhint">▸ test fly</span></div>` +
      `<div class="cc-head"><span class="cc-name">${c.name}</span>` +
      `<span class="cc-tag"${key === "interceptor" ? ' id="egg-badge"' : ""}>${c.tag}</span></div>` +
      stat("Δv tank", c.pips.tank) + stat("fuel economy", c.pips.fuel) +
      stat("handling", c.pips.handling) + stat("cargo care", c.pips.care) +
      `<div class="cc-stat"><span class="cc-lab">start credits</span><span class="cc-credits gold-t">₡${c.credits}</span></div>` +
      `<div class="cc-blurb">${c.blurb}</div>` +
      (unlocked
        ? `<button class="btn gold" data-cls="${key}">FLY THE ${c.name.toUpperCase()}</button>`
        : `<div class="cc-locknote">🔒 retire ranked <b>${rankFor(c.unlock)}</b> (₡${c.unlock.toLocaleString()}) to unlock` +
          `<span class="cc-locksub">test flights allowed</span></div>`);
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
      buildClassSelect();                      // debug unlocks every hull — rebuild the cards
      el("egg-badge").classList.add("armed");
      showEggToast("◈ DEBUG ARMED — pick a ship to fly it");
    }
  });
}
let debugArmed = false, eggTaps = 0, eggTapTimer = null;

function applyClass(key) {
  if (!shipUnlocked(key)) return;
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
  if (e.code === "KeyH" && game.testFlight) toggleUI();   // hide-all is a test-flight-only view
  if (e.code === "KeyR") callTow();
  if (e.code === "KeyM") { audio.toggleMute(); updateSoundIndicator(); }
  if (e.code === "KeyV" && game.testFlight) cycleSpeedPreset();   // speed presets: test-flight only
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
  apUnlocked = true;                       // learning the trick unlocks the toggle badge for good
  autopilotAssist = !autopilotAssist;
  if (!autopilotAssist) apBraking = false;
  updateAutopilotIndicator(true);
  showEggToast(autopilotAssist ? "◈ DOCKING ASSIST ON" : "docking assist off");
}
function updateAutopilotIndicator(doFlash) {
  const b = el("autoBadge");
  b.classList.toggle("shown", apUnlocked);   // visible once owned, even when toggled off
  b.classList.toggle("on", autopilotAssist);
  b.textContent = "◈ DOCKING ASSIST · " + (autopilotAssist ? "ON" : "OFF");
  if (doFlash) { b.classList.remove("flash"); void b.offsetWidth; b.classList.add("flash"); }
}
// tap the badge on the flight HUD to toggle the assist on/off
el("autoBadge").addEventListener("click", (e) => { e.stopPropagation(); toggleAutopilot(); });

// Owned outfits shown as compact HUD badges (autopilot has its own green badge).
// Two rows so the strip doesn't run long: propulsion (fuel & speed) up top,
// operations (load, pay, career) below.
const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII"];
const BADGE_GROUPS = [
  ["tank", "drive", "overdrive"],   // propulsion — Δv capacity, fuel economy, top speed
  ["damper", "broker", "rejuv"],    // operations — felt load, contract pay, career length
];
function renderBadgeGroup(id, groupKeys) {
  const b = el(id);
  const owned = groupKeys.filter((k) => game.upgrades[k] > 0);
  b.classList.toggle("on", owned.length > 0);
  if (owned.length) b.innerHTML = owned
    .map((k) => `${UPGRADES[k].icon}<span class="rl">${ROMAN[game.upgrades[k]]}</span>`)
    .join("<span class='bsep'>·</span>");
}
function updateBadges() {
  renderBadgeGroup("upgradeBadge", BADGE_GROUPS[0]);
  renderBadgeGroup("upgradeBadge2", BADGE_GROUPS[1]);
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

// The flight controls cheat-sheet. A delivery run shows only the mission
// essentials (steer, aim, throttle, tow, mute); a test flight shows the full
// key list since everything's fair game there. Q/E roll and 1–5 effects still
// work in a delivery run — they're just not advertised.
function setFlightHelp() {
  const t = el("help");
  if (game.testFlight) {
    t.innerHTML = `<div class="title">FLIGHT CONTROLS</div>` +
      `<b>Mouse</b> steer (drag) · <b>tap</b> a marker to auto-aim · <b>W/S</b> throttle ± · <b>Q/E</b> roll · <b>Shift</b> turbo · <b>X</b> warp<br/>` +
      `<b>Space</b> cut thrust · <b>V</b> speed presets · <b>B</b> (hold) look astern<br/>` +
      `<b>R</b> call tow · <b>M</b> mute · <b>H</b> hide UI · <b>1–5</b> toggle effects`;
  } else {
    const warp = game.upgrades.overdrive > 0 ? " · <b>X</b> warp" : "";
    t.innerHTML = `<div class="title">FLIGHT CONTROLS</div>` +
      `<b>Mouse</b> steer (drag) · <b>tap</b> a marker to auto-aim<br/>` +
      `<b>W/S</b> throttle ± · <b>Shift</b> turbo${warp}<br/>` +
      `<b>R</b> call tow · <b>M</b> mute`;
  }
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
  help: el("help"), effects: el("effects"),
  smDist: el("sm-dist"), smLoad: el("sm-load"),
  contract: el("contract"), summary: el("flight-summary"),
};
const _redlineEls = [hud.pct, hud.gamma];   // hoisted — no per-frame array
let lastHudFade = -1;                       // last help/effects opacity actually written
let audioTick = 0;                          // audio.update runs every 3rd frame
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
    if (stations[i].deep && !game.deepLicense) continue;   // invisible until licensed
    _proj.copy(stations[i].pos).project(camera);
    if (_proj.z > 1) continue;             // behind the camera
    const sx = (_proj.x * 0.5 + 0.5) * window.innerWidth;
    const sy = (-_proj.y * 0.5 + 0.5) * window.innerHeight;
    const d = Math.hypot(sx - px, sy - py);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}
// fmt runs several times per frame in the HUD — memoize one Intl formatter per
// precision instead of paying toLocaleString's option-parsing on every call.
const _nf = {};
function fmt(n, d = 1) {
  return (_nf[d] || (_nf[d] = new Intl.NumberFormat(undefined,
    { minimumFractionDigits: d, maximumFractionDigits: d }))).format(n);
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
  if (keys.has("Space") && game.testFlight) ship.throttle = 0;   // cut thrust: test-flight only
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
    // A tapped aim is a one-shot slew: once we're essentially there, snap exactly
    // onto the target heading and release — so it locks dead-centre, never a hair
    // short — and won't yank you back after a later overshoot. (_aimQuat is the
    // exact aim orientation aimAtPos just computed.) The autopilot keeps its lock.
    if (aimStation && !autopilotAssist) {
      _dir.copy(aimStation.pos).sub(ship.pos).normalize();
      if (_fwd.dot(_dir) > 0.9999) { ship.quat.copy(_aimQuat); aimStation = null; }
    }
  }

  // --- autopilot docking assist (easter egg): a throttle-down kicked off at the
  // precise distance that brings you to dock speed right at the 15 ly mark. It
  // brakes as hard as the cargo's g-rating allows (gentle for fragile freight,
  // late & hard for rugged), and the trigger uses the same rate to stay accurate.
  if (autopilotAssist && game.contract && game.fuel > 0 && !launching) {
    const apTgt = stations[game.contract.to];
    const apDist = apTgt.pos.distanceTo(ship.pos);
    _dir.copy(apTgt.pos).sub(ship.pos).normalize();
    const decel = apDecelRate(game.contract.gLimit);
    if (_fwd.dot(_dir) > 0.2) {
      // pre-filter before running the brake sim each frame; a full-redline brake
      // can eat well past 200 ly, so licensed pilots get a wider window
      if (!apBraking && ship.beta > DOCK_BETA && apDist < (game.deepLicense ? 600 : 200) &&
          apDist - DOCK_RADIUS <= apBrakeDistance(ship.beta, decel)) {
        apBraking = true;
      }
      if (apBraking && apDist >= DOCK_RADIUS) {
        // outside dock range, throttle-down is floored at a slow drift so the
        // ship keeps creeping in rather than stopping short of the dock
        ship.throttle = Math.max(betaToThrottle(0.15), ship.throttle - decel * dt);
      }
    }
    // inside dock range, keep easing the throttle to a full stop at that same
    // capped, g-respecting rate — a hot arrival still has to bleed off its speed
    if (apDist < DOCK_RADIUS) ship.throttle = Math.max(0, ship.throttle - decel * dt);
  }

  // --- speed easing + FUEL: burn |Δrapidity| (proper Δv of the maneuver) ---
  // A warp burn spools β harder — and more so per Redline Coils level (2×…7×).
  // Gated on warpBurn so cutting thrust (Space) and speed presets (V) stay smooth
  // rather than snapping β and spiking felt G.
  const spool = SPOOL * (warpBurn ? 1 + (game.upgrades.overdrive * 1.5) : 1);
  const targetBeta = throttleToBeta(ship.throttle);
  ship.beta += (targetBeta - ship.beta) * Math.min(1, dt * spool);
  const gamma = lorentz(ship.beta);
  if (!game.testFlight && gamma > game.maxGamma) game.maxGamma = gamma;   // career peak γ (a record)
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
    const gPace = pace(gamma);
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
  const targetYaw = (keys.has("KeyB") && game.testFlight) ? Math.PI : 0;   // look astern: test-flight only
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
  // ~20 Hz is plenty for the audio smoothing (0.1–0.3 s time constants) and cuts
  // the AudioParam automation-event churn to a third
  if (++audioTick >= 3) { audioTick = 0; audio.update(ship.beta, ship.throttle, 0, feltSurge); }

  gveilEl.style.opacity = dyn.veil.toFixed(3);
  viewmodeEl.classList.toggle("on", view.lookYaw > 0.4);
  if (flashAmt > 0) {
    flashEl.style.opacity = flashAmt.toFixed(3);
    flashAmt = Math.max(0, flashAmt - dt * 1.6);
  }
}

function updateHUD(gamma, dist, coordRate) {
  // Desktop help + effects panels fade out as you build speed — but only after
  // your first delivery (a new pilot keeps them the whole first flight). A test
  // flight leaves them alone; there the H key hides the whole HUD instead.
  const hudFade = game.testFlight ? 1
    : game.deliveries >= 1
      ? THREE.MathUtils.clamp((HUD_FADE_HI - ship.beta) / (HUD_FADE_HI - HUD_FADE_LO), 0, 1)
      : 1;
  if (hudFade !== lastHudFade) {           // pinned at 1 (or 0) most of the flight — skip the writes
    lastHudFade = hudFade;
    hud.help.style.opacity = hudFade;
    hud.effects.style.opacity = hudFade;
    hud.effects.style.pointerEvents = hudFade < 0.2 ? "none" : "";   // don't catch clicks once gone
  }

  // dead stick: surface the TOW recovery button on desktop too (mobile always shows it)
  document.body.classList.toggle("deadstick", !game.testFlight && game.fuel <= 0);

  const pctC = ship.beta * 100;
  hud.pct.textContent = (pctC >= 99.99 ? fmt(pctC, 4) : fmt(pctC, 3)) + " %c";
  hud.beta.textContent = ship.beta.toFixed(ship.beta > 0.999 ? 7 : 6);
  hud.gamma.textContent = gamma > 1000 ? gamma.toExponential(2) : fmt(gamma, 4);
  // redline payoff: past REDLINE_GAMMA the SPEED & Lorentz readouts glow red and
  // buzz, harder the deeper into the redline you push
  const redline = gamma > REDLINE_GAMMA;
  const shake = redline ? Math.min(1.15, 0.4 + 0.28 * Math.log10(gamma / REDLINE_GAMMA)).toFixed(2) : 0;
  for (const elm of _redlineEls) {
    elm.classList.toggle("redline", redline);
    if (redline) elm.style.setProperty("--shake", shake);
  }
  // SPEED box shows the raw felt G (physics reading, works in a test flight too);
  // the load-vs-rating gauge lives in the contract box, next to distance.
  const gl = game.contract && game.contract.gLimit;
  const over = gl && dyn.load > gl;
  hud.gforce.textContent = fmt(dyn.load, 1) + " g";
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
  if (!c) {
    if (hud.contract.style.display !== "none") {
      hud.contract.style.display = "none"; hud.summary.style.display = "none"; hud.countdown.style.display = "none";
    }
    return;
  }
  if (hud.contract.style.display !== "") {
    hud.contract.style.display = "";
    hud.summary.style.display = "";   // "" reverts to CSS (mobile block, desktop none)
  }
  // distance also echoes into the mobile top-center summary (prominent there too)
  const distTxt = dist.toFixed(1) + " ly";
  hud.cDist.textContent = distTxt; hud.smDist.textContent = distTxt;
  const remaining = c.deadline - (ship.coordTime - c.acceptCoord);
  hud.cDeadline.textContent = "T−" + fmtY(Math.max(0, remaining));
  hud.cDeadline.className = "v" + (remaining < c.deadline * 0.15 ? " bad" : "");
  if (c.type === "passenger") {
    const aged = ship.shipTime - c.acceptShip;
    hud.cAging.textContent = aged.toFixed(2) + " / " + c.maxAging.toFixed(1) + " yr";
    hud.cAging.className = "v" + (aged > c.maxAging * 0.8 ? " bad" : "");
  }
  // live load vs the contract's rating — the mission g-gauge, colored as it climbs;
  // mirrored into the summary so the g-limit is visible top-center on mobile
  const loadTxt = fmt(dyn.load, 1) + " / " + c.gLimit + " g";
  const loadColor = dyn.load > c.gLimit ? "var(--warn)" : (dyn.load > c.gLimit * 0.8 ? "var(--gold)" : "var(--hud)");
  hud.cRating.textContent = loadTxt; hud.cRating.style.color = loadColor;
  hud.smLoad.textContent = loadTxt; hud.smLoad.style.color = loadColor;
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
  } else if (game.fuel <= 0) {
    // dead stick trumps everything — you can't thrust, so the tow is the only move
    status = "⚠ OUT OF FUEL — call a tow to recover";
    cls = "brake";
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
  }
  hud.cStatus.textContent = status;
  hud.cStatus.className = "status " + cls;

  // pre-launch countdown overlay — the DOM only rebuilds when the digit flips,
  // not every frame (innerHTML parsing 60×/s was the HUD's biggest churn)
  if (game.preflight > 0) {
    const sec = Math.ceil(game.preflight);
    if (hud.countdown.style.display !== "block") hud.countdown.style.display = "block";
    if (cdSec !== sec) {
      cdSec = sec;
      hud.countdown.innerHTML = `<div class="cd-num">${sec}</div>` +
        `<div class="cd-hint">AIM AT ${stations[c.to].name}</div>` +
        `<div class="cd-sub">thrust when you're ready to launch</div>`;
    }
  } else if (hud.countdown.style.display !== "none") {
    hud.countdown.style.display = "none";
    cdSec = -1;                            // next launch rebuilds (new destination name)
  }
}
let cdSec = -1;

function updateLabels() {
  const labelFade = 1 - THREE.MathUtils.smoothstep(ship.beta, 0.9, 0.97);
  for (let i = 0; i < stations.length; i++) {
    const st = stations[i];
    // hidden labels skip the DOM write unless they were visible last frame
    // deep-space stations stay off the nav display until the license is earned
    if (st.deep && !game.deepLicense) { if (st._shown) { st.el.style.display = "none"; st._shown = false; } continue; }
    const isTarget = game.contract && game.contract.to === i;
    // the target label stays visible at any speed; others fade near c
    const fade = isTarget ? 1 : labelFade;
    if (fade <= 0.001) { if (st._shown) { st.el.style.display = "none"; st._shown = false; } continue; }
    const dist = st.pos.distanceTo(ship.pos);
    if (dist < 1e-3) { if (st._shown) { st.el.style.display = "none"; st._shown = false; } continue; }
    // Project the TRUE station position (not aberrated). A nav marker should read
    // as an honest bearing: it swings to the edge and off-screen as you fly past,
    // instead of aberration pinning it to the forward cone so you can't tell you
    // overshot.
    _proj.copy(st.pos).project(camera);
    // hide behind-camera and near-edge labels so no clipped text hugs the edges
    // (x is tighter because the labels are wide horizontal text)
    if (_proj.z > 1 || _proj.z < -1 ||
        _proj.x < -0.9 || _proj.x > 0.9 || _proj.y < -0.96 || _proj.y > 0.96) {
      if (st._shown) { st.el.style.display = "none"; st._shown = false; }
      continue;
    }
    const x = (_proj.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-_proj.y * 0.5 + 0.5) * window.innerHeight;
    if (!st._shown) { st.el.style.display = "block"; st._shown = true; }
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
window.__lighthaul = { game, ship, stations, dock, setPhase, update };

requestAnimationFrame(frame);
