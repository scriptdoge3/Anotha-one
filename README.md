# Load Bank

A career sim about operating, abusing and slowly rebuilding one 75 kW diesel
generator, presented as a 1963 generator control desk.

You start in April 1963 with a tired set, £2,400 and no reputation. You take hire contracts,
keep the frequency inside the clause you signed, burn fuel you paid for, and put
the margin back into the machine. Thirty-two upgrades across five branches take
it from a naturally aspirated mechanical-governor unit that struggles at
altitude to a compound-turbocharged, isochronous, Stage V combined-heat-and-power
machine delivering 132 kW.

```bash
npm start      # http://localhost:8080
npm test       # 45 tests over the physics and the career layer
npm run apk    # build load-bank.apk  (needs ANDROID_SDK_ROOT)
```

No build step and no runtime dependencies — plain ES modules. The server exists
only because module imports need a real origin.

## The 1963 desk

The interface is one machine. Panels are hammertone-enamelled steel bolted to a
frame at the corners; the readouts are moving-coil meters behind glass, with
printed danger sectors and needles that swing past the mark and settle back —
a real damped second-order movement, integrated every frame, not a bar that
snaps to a value. Pilot lamps are jewelled glass in chrome bezels. The log
spools out of a teleprinter, contracts arrive as carbon copies on manila, and
the tech tree is a blueprint in the drawing office.

Two typefaces are embedded in the page as base64 (SIL OFL): **Jost**, a Futura
revival, for the engraved panel lettering, and **Cutive Mono** for the
typewritten paperwork. Embedding them matters — inside the APK there is no
network, and on Android a system fallback would substitute Roboto and lose the
period entirely.

Everything is drawn with CSS gradients and inline SVG. There is not one raster
asset in the interface, so it stays sharp at any density and the whole app fits
in a 136 KB APK.

Prices are in period sterling and the date runs from 1 April 1963, but the
economy is balanced for play rather than to 1963 price levels — and the upper
tech tree (SCR aftertreatment, lithium buffers, organic Rankine cycles) runs
well past what 1963 could actually build. The desk is the period piece; the
engineering is allowed to be ahead of it.

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

## Android

`npm run apk` produces a sideloadable `load-bank.apk` (~136 KB). It needs an
Android SDK with build-tools 34 and platform 34:

```bash
export ANDROID_SDK_ROOT=~/Android/Sdk
npm run apk
adb install -r load-bank.apk
```

The build drives `aapt2`, `javac`, `d8`, `zipalign` and `apksigner` directly
rather than going through Gradle — the app is one Activity and a folder of
static files, so there is no plugin resolution to go wrong.

The shell is a WebView, but it does **not** load the game over `file://`. A
`file://` document has an opaque origin, which would block every ES module
import and make `localStorage` — the save file — unreliable. Instead
`shouldInterceptRequest` answers a synthetic `https://loadbank.localhost`
origin out of the APK's assets, so the page gets a proper secure origin while
never touching the network. The manifest requests **no permissions at all**,
including no `INTERNET`, so off-device access is impossible at the OS level.

minSdk 24, targetSdk 34. Signed with a locally generated debug-grade key — fine
for sideloading, not a Play Store upload key. The keystore is regenerated if
missing, which changes the signature, so uninstall an older build before
installing a freshly signed one.

## Layout

```
src/sim.js         physics core — pure, no DOM, deterministic
src/tech.js        the tree; each node mutates the spec sim.js reads
src/contracts.js   load profiles, clauses, settlement
src/state.js       career state and the master tick
src/ui.js          rendering; Operate is built once and patched per frame
src/main.js        frame loop and event wiring
fonts.css          embedded period typefaces (base64, OFL)
android/           manifest, resources and the WebView Activity
scripts/           APK build, browser smoke test, mobile layout check
test/              45 tests
```

Beyond the unit tests there are two browser checks (both need `npm i` and a
running `npm start`): `npm run smoke` plays a full job end to end and fails on
any console error, and `npm run mobile` renders every tab at phone and tablet
sizes and fails on horizontal overflow.

The physics core is pure and deterministic, which is why the interesting
properties are testable at all: that BSFC lands in the real range, that an
isochronous governor holds 60.00 Hz at any load, that fast-forward doesn't change
the answer, and that no legal combination of upgrades produces a degenerate
machine.
