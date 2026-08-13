# Load Bank

A career sim about operating, abusing and slowly rebuilding one 75 kW diesel
generator.

You start with a tired set, $2,400 and no reputation. You take hire contracts,
keep the frequency inside the clause you signed, burn fuel you paid for, and put
the margin back into the machine. Thirty-two upgrades across five branches take
it from a naturally aspirated mechanical-governor unit that struggles at
altitude to a compound-turbocharged, isochronous, Stage V combined-heat-and-power
machine delivering 132 kW.

```bash
npm start      # http://localhost:8080
npm test       # 45 tests over the physics and the career layer
```

No build step and no runtime dependencies — plain ES modules. The server exists
only because module imports need a real origin.

## The machine is actually simulated

The generator is not a set of stat bars. Every tick solves a torque balance on
one shaft:

```
fuel rack → combustion (limited by available air) → indicated torque
          → minus friction → minus alternator load torque → shaft acceleration
```

Shaft speed *is* frequency (4-pole, 1800 rpm = 60 Hz), so anything that upsets
the torque balance shows up immediately on the instrument the client's power
quality clause is watching. Consequences that fall out of the model rather than
being scripted:

- **Turbo lag is real.** A turbo comes with a bigger injection pump. Under light
  load there is almost no exhaust energy, so almost no boost. When a big load
  lands, the rack opens, the smoke limiter clamps fuel to the air actually
  available, and the engine *cannot* make the torque until the turbo spools ~3 s
  later. You watch the frequency sag and the stack go black.
- **Droop vs isochronous.** The stock flyweight governor is proportional: fuel is
  a function of the speed shortfall, so the set genuinely runs at 61.8 Hz
  unloaded and 60.0 Hz at full load. Nothing with a tight clause is winnable
  until you fit an electronic governor with integral action.
- **Altitude and heat derate you.** Air density is computed from the standard
  atmosphere. The 2,400 m relay job costs a naturally aspirated set 16 kW; the
  36 °C hatchery job costs it 14 kW. Both are recoverable with the right tech.
- **The alternator is a separate ceiling.** You can build an engine that makes far
  more shaft power than the windings will pass. Until you rewind it, that power
  is unsellable.

Calibrated against real machines: ~22 L/h and 0.25 kg/kWh at full load, ~96 °C
coolant, ~6 min thermal time constant, 2.3 L/h at idle.

## The tech tree

Five branches, 32 nodes, one either/or fork.

| Branch | What it buys you |
| --- | --- |
| **Air & Fuel** | Turbocharging, intercooling, common rail. Raw output and cleaner combustion. |
| **Materials** | Durability, bottom-end strength, and the alternator rewind that lifts the electrical ceiling. |
| **Thermal** | Cooling headroom, then waste-heat recovery and CHP — selling the heat you were throwing away. |
| **Control** | AVR, isochronous governing, load anticipation, hybrid battery buffer, paralleling. |
| **Compliance** | Acoustic canopy, DPF, SCR, HVO. Unlocks urban, hospital and municipal work. |

**Variable-Geometry Turbo** and **Compound Turbocharging** lock each other out
permanently. VGT spools in 0.45 s and shrugs off step loads; compound makes far
more top-end air but spools like a barge. Transient specialist or endurance
specialist — pick one.

Every node's `apply()` writes to the same physics fields the simulation reads, so
no upgrade is cosmetic. The detail dialog shows a real before/after of the spec.

Measured output along the upgrade path:

```
stock 78 kW → intake 80 → turbo 84 → intercooler 88 → radiator 92
  → windings 110 → compound 114 → class H 120 → fully built 132
```

## The career

Twenty hand-written contracts across five reputation tiers, plus generated filler
work. Each has a load profile (flat, ramping, square-wave, spiking, diurnal),
frequency and voltage clauses, site conditions, and liquidated damages.

Contracts pay a mobilisation advance on acceptance — which is what guarantees you
can always afford fuel for the job you just took — then settle on energy
delivered, minus penalties for shortfall, frequency excursions, voltage
excursions and visible smoke. Penalties are capped at the contract's value, so
one bad night is a setback rather than a dead save. Clients you do well by call
again as repeat business.

Wear accumulates with load, heat, soot and abrasive sites, divided by whatever
durability you have bought. A stock engine reaches overhaul somewhere around 500
to 900 running hours.

## Controls

Space pauses; `1`–`6` set the time scale from 1× to 600×. The simulation is
timestep-independent across that whole range — there is a test for it, because a
governor loop that went unstable at 600× would quietly invent penalties.

## Layout

```
src/sim.js         physics core — pure, no DOM, deterministic
src/tech.js        the tree; each node mutates the spec sim.js reads
src/contracts.js   load profiles, clauses, settlement
src/state.js       career state and the master tick
src/ui.js          rendering; Operate is built once and patched per frame
src/main.js        frame loop and event wiring
test/              45 tests
```

The physics core is pure and deterministic, which is why the interesting
properties are testable at all: that BSFC lands in the real range, that an
isochronous governor holds 60.00 Hz at any load, that fast-forward doesn't change
the answer, and that no legal combination of upgrades produces a degenerate
machine.
