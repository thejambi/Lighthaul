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
  of an ideal rocket. Reaching 0.99c costs φ≈2.65; 0.9999c costs φ≈4.95 — and
  you pay it **again to brake**. Fuel costs diverge as you push toward *c*.
- **Cargo deadlines run on universe time** (`d/β` to cover distance `d`), so slow
  cruising misses them. Any decent speed beats the clock — speed is about *time*,
  not γ.
- **Passengers age on ship time** (`d/(βγ)`), so their aging caps force **high γ**
  — the twin paradox as a contract clause.
- **You age on ship time too**, and retire at 68. A cheap, slow 100 ly haul at
  0.6c costs you ~14 years of life; the same run at 0.9999c costs ~1.4 years but
  ~10 rapidity units of fuel. Fly cheap and die old, or fly hot and pay for it.

Dock by arriving within **15 ly** below **0.20c** (the HUD warns you when you're
inside braking distance — cut throttle in time!). Run the tank dry and you're on
a **dead stick** — coasting at whatever β you had, unable to brake — and your
only option is an expensive tow (**R**) that forfeits the contract and costs
years of your life.

Between runs you refuel (credits per rapidity unit) and pick from three
procedurally generated contracts. Retire rich, not old.

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

Liberties: stations are magically at rest with respect to each other, docking is
instant, time freezes while docked, the "tow" is pure gameplay, and the starfield
geography is compressed fiction (see the engine README for the full honesty
list).

## Layout

- `index.html` — HUD, station/results/retirement screens.
- `src/main.js` — game loop: contracts, fuel/aging economy, docking, flight.
- `src/relativity.js`, `src/textures.js`, `src/audio.js` — engine modules shared
  with SpaceRelativity.
