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
Fuel is priced per rapidity unit, with a **bulk discount** — the bigger the
fill-up, the cheaper each unit (up to a third off). Since Δv is rapidity, brake
fuel doesn't scale with tank size, so a big tank you let run low before topping
off buys the cheapest fuel. Retire rich, not old.

**Outfitting.** Every dock stocks a fixed pair of upgrades, so the map is worth
learning — you travel to where the outfit you want is sold. Each buys up in a
few escalating tiers: a **Fuel Cell Array** (+Δv capacity, for one bigger leg), a
**Drive Efficiency** reactor (−fuel burned per Δv, stretching the whole tank),
**Inertial Dampers** (−felt maneuvering load, so you can burn and brake harder
without stressing fragile freight), a **Broker License** (+pay on every
contract), a **Rejuv Course** (+years before mandatory retirement — buy more
career), and a **Docking Assist** that auto-brakes you to a clean dock. Levels
persist across the career and show as badges on the flight HUD.

**Star chart** (the ★ button at a dock) is a trip planner: a top-down map of the
cluster with your open contracts as gold routes. Pick a cruise speed and tap any
station to see that leg's real cost — distance, Δv (vs. your tank), universe-time,
and the ship-years you'd age — with a live ✓/✗ on whether that speed meets the
contract's deadline or γ requirement. Accept a run straight from the map.

## Controls

| Input | Action |
| --- | --- |
| **Mouse** (drag) | steer — pitch & yaw |
| **W / S** | throttle up / down (fine); **Shift** = turbo |
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
year — length contraction made real, soft-capped for playability).

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
