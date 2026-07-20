# Lighthaul

*A relativistic courier game.* Haul cargo and passengers between stations at a
hair under light speed — and let special relativity be the economy. Runs
entirely in the browser (WebGL, no build step), built on the
[SpaceRelativity](../SpaceRelativity) engine.

## Run it

```bash
python3 -m http.server 8081
# then open http://localhost:8081
```

## The game

You're a courier pilot. Accept a contract, undock aimed at the destination,
burn, cruise, brake, dock. The tension is a genuine special-relativity triangle:

- **Fuel is Δv, measured in rapidity** (`φ = atanh β`) — the real proper delta-v
  of an ideal rocket. Reaching 0.99c costs φ≈2.65; 0.9999c costs φ≈4.95 — and you
  pay it **again to brake**. The tank is deliberately small, so you *can't* max
  every leg — fly only as fast as the job actually needs.
- **Cargo deadlines run on universe time** (`d/β`), so slow cruising misses them.
- **Passengers age on ship time** (`d/(βγ)`), so their aging caps force **high γ**
  — the twin paradox as a contract clause.
- **You age on ship time too**, and retire at 68 — every year aboard is a year off
  your career.
- **Inertial rating (the G-limit).** Your **inertial dampers** cancel the brutal
  *proper* acceleration of relativistic cruising, so what the load actually feels
  is the residual *maneuvering* load — how **hard you burn and brake**, not how
  fast you go. Every contract has a G-rating (fragile passengers ~3–8 g, cargo up
  to ~18 g); exceed it and you drain the shipment's **integrity**, which cuts your
  pay on arrival. So a gentle ramp to 0.9999c is safe but *slow to build* (eating
  your deadline), while a turbo slam is fast but wrecks fragile freight. Fragile +
  tight-deadline contracts pay a premium precisely because you can't have both.

Dock by arriving within **15 ly** below **0.20c** (the HUD warns you when you're
inside braking distance — cut throttle in time, and *gently* if the cargo's
fragile). Run the tank dry and you're on a **dead stick** — coasting at whatever β
you had, unable to brake — and your only option is an expensive tow (**R**) that
forfeits the contract and costs years of your life.

Between runs you refuel and pick from three procedurally generated contracts.
Pay scales with distance and how hard the job is (required speed or γ, plus a
fragility premium for low-g cargo), and your **reputation** raises every
contract's base pay as you rack up deliveries — +3% each, up to +75%, stacking
on top of the Broker License. Fuel is priced per rapidity unit, with a **bulk
discount** — the bigger the fill-up, the cheaper each unit (up to a third off).
Since Δv is rapidity, brake fuel doesn't scale with tank size, so a big tank you
let run low before topping off buys the cheapest fuel. Retire rich, not old.

**Outfitting.** Every dock stocks a fixed pair of upgrades, so the map is worth
learning — you travel to where the outfit you want is sold. Each buys up in a
few escalating tiers: a **Fuel Cell Array** (+Δv capacity, for one bigger leg), a
**Drive Efficiency** reactor (−fuel burned per Δv, stretching the whole tank),
**Inertial Dampers** (−felt maneuvering load, so you can burn and brake harder
without stressing fragile freight), a **Broker License** (+pay on every
contract), a **Rejuv Course** (+years before mandatory retirement — buy more
career), **Redline Coils** (each level pushes your top speed a nine closer to
*c* — higher γ, so you age even less at full throttle, for the extra Δv it costs
to get there), and a **Docking Assist** that auto-brakes you to a clean dock.
Levels persist across the career and show as badges on the flight HUD.

**Ship classes.** Each career opens with a choice of hull, and you fly the whole
run in it — the forgiving all-round **Courier**, the big-tank rugged-cargo
**Hauler** (turns like a moon, feels every G — keep fragile passengers off it),
or the featherweight high-skill **Interceptor** (sips fuel, turns on a spark,
flies high-γ passenger work cheap, but a tiny tank and thin hull). Each is a
different trade in Δv capacity, fuel economy, handling, and how much punishment
the load takes; upgrades stack on top, so you patch a weakness over a career.
Hulls are earned: the Hauler unlocks after retiring ranked *Journeyman Courier*,
the Interceptor after *Master Courier*. New pilots get offered **Flight
School** — a two-minute scripted training run (real physics, zero
consequences) that teaches aiming, the fuel economy, the two clocks, the
g-rating, and braking to dock.

**Deep Space License.** Complete a delivery having touched **γ ≥ 25,000**
(Redline Coils territory — the stock governor tops out at γ 1,000) and long-haul
brokers open their books: a handful of **deep-space stations 800–2,500 ly out**
appear at the edges of your chart, with contracts to match. Long-haul passage is
cryo transit — the pods may only age a human handful of years across a
thousand-ly leg, which means averaging **γ in the hundreds**. And your own aging
polices the freight runs: below redline, `d/βγ` across 1,500 ly is a career's
worth of years. Deep space is where the full build — tank, drive, coils,
docking assist — finally flies as one machine.

**Records & rank.** Retire and you earn a rank on your final balance — from
*Deadhead* through *Lightspeed Legend* and, for the deep-space eras, up to
*Redline Royalty*, *Deep Space Magnate*, and *The Ageless* — and your best
careers (richest retirement, most deliveries, highest Lorentz γ ever reached)
persist as records to beat on your next run. Retirement shows your **career
log** (every run, pay, and the universe years it cost) and a **📋 SHARE RUN**
button that copies an emoji summary for the group chat. Recent careers persist
on the title screen with their seeds — tap one to refly that exact map.

**Commendations.** Ten Guild badges — from completionist runs (dock
everywhere; visit every station *evenly*) through skill feats (ten flawless
deliveries, a career with zero tows, a 14 g delivery handed over at 100%
integrity — take the rugged high-g freight and *fly it like you mean it*) to
endgame pilgrimages (touch γ 1,000,000;
a single 1,000-universe-year delivery; make Master Courier having aged under 30
years — rich and still young, the twin paradox as a flex; survive a hardcore
career). Badges re-earn every career — the share card counts
your haul, so "how many in one run" is its own game — while first-evers get the
★ and persist. Unearned badges show dimmed on the title screen as goals; the
full criteria list lives in ⚙ settings.

**☠ Hardcore.** A toggle at career start: no recovery tows. Run the tank dry
with no way to brake and your only option is ABANDON SHIP — the career ends
where it drifts, listed in the ledger as "en route." Fuel stops being a cost
and becomes survival.

**Dock economy events.** About a third of arrivals, the local economy is doing
something: fuel rationing (×2) or a tank-farm surplus (60%), an export boom
(+30% pay) or a dock strike (−20%), an outfitter clearance (−25% upgrades).
Chase the booms; refuel at the gluts.

**Daily run.** The 📅 DAILY RUN button seeds today's shared cluster — everyone
flying it gets the same map, shops, and opening offers. Compare share cards.

**The story writes itself.** Docks remember when you last called, in universe
time: return after centuries and the delivery summary tells you what changed —
couriers are one-way time travellers, and the vignettes (plus your retirement
epilogue) come straight from the clock math. Also installable as an app
(manifest + offline-fallback service worker; 📲 chip on the title screen).

**Star chart.** The dock's contract browser *is* a top-down map of the cluster:
your three offers appear as gold routes, each labelled with its pay and g-rating
plus a live ✓/✗ for the cruise speed you've picked. Tap any station (node or
label — finger-sized targets) to see the leg's real cost — distance, Δv (vs.
your tank), universe-time, and the ship-years you'd age — and accept a run
straight from the map. Non-contract stations work as a pure trip planner.

Every cluster is procedural. Leave the **map seed** blank at ship-select for a
random one (shown at the dock so you can note a good one), or type a seed to
replay the exact same cluster — same stations, layout, and outfit shops.

## Controls

| Input | Action |
| --- | --- |
| **Mouse** (drag) | steer — pitch & yaw |
| **W / S** | throttle up / down (fine); **Shift** = turbo; **X** = warp (needs Redline Coils) |
| **Q / E** | roll |
| **Space** | cut thrust |
| **V** | cycle speed presets (0 → 0.5c → 0.9c → 0.99c → 0.9999c) |
| **B** (hold) | look astern |
| **R** | call a recovery tow (forfeits contract) |
| **M** | mute · **H** dim UI · **1–5** toggle relativistic effects |

Also touch-friendly: drag the field to steer, slide the thrust bar to set speed.

## The physics

All the visual relativity comes from the SpaceRelativity engine: per-star GLSL
**aberration**, **relativistic Doppler** blackbody color shift, **beaming**,
**length-contraction** view compression, the **CMB hotspot**, proper-acceleration
**G-forces** (`γ³·dv/dt` linear, `γ²·v·ω` centripetal — turning near *c* is
punishing, roll is free), and **pilot-frame pacing** (you cover `βγ` ly per ship
year — length contraction made real). Below a soft cap the pace is exact `βγ`;
past it a slow logarithmic ramp keeps redline speeds covering ground faster
without a leg ever finishing in a single frame — fast enough that the fastest
runs really do need the Docking Assist. Time dilation itself (aging `d/βγ`,
deadlines `d/β`) is exact at every speed and untouched by this — it's wall-clock
only.

Game-layer physics: fuel as **rapidity** is honest rocketry (velocities don't
add linearly near *c*; rapidities do), and all three clocks — deadline (universe
time), passenger aging and pilot aging (ship time) — fall out of the same
`t_ship = t_universe/γ` bookkeeping.

### What's compressed (and what isn't)

The **time-dilation itself is exact**: a leg of distance `d` flown at β ages you
`d/(βγ)` ship-years, so higher γ really does keep you (and your passengers)
younger — the twin paradox, straight. What's *not* to scale is the **world**: a
40-something-year working life is pitted against a compact ~60–350 ly cluster.
Real interstellar distances (thousands of ly) against a human lifespan would be
unplayable — one 0.9c hop would age you centuries — so the cluster is shrunk and
the career stretched (retire at 82, framed as a rejuvenation-era certification)
until a career is a satisfying *string* of deliveries rather than two doomed
voyages. The **dilation ratio is real; the absolute scale is a game dial.**

Other liberties: stations are at rest relative to each other, docking is instant,
time freezes while docked, the "tow" is pure gameplay, and the geography is
procedural fiction (see the engine README for the full honesty list).

## Layout

- `index.html` — HUD, station/results/retirement screens.
- `src/main.js` — game loop: contracts, fuel/aging economy, docking, flight.
- `src/relativity.js`, `src/textures.js`, `src/audio.js` — engine modules shared
  with SpaceRelativity.
