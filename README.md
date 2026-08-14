# Load Bank

A career sim about operating, abusing and slowly rebuilding one 75 kW diesel
generator, presented as a 1963 generator control desk.

You start in April 1963 with a tired set, £2,400 and no reputation. You take hire
contracts, run the machine by hand, burn fuel you paid for, and put the margin
back into it. Thirty-two upgrades across five branches take it from a naturally
aspirated, hand-excited unit with a flyweight governor to a compound-turbocharged,
isochronous, Stage V combined-heat-and-power machine delivering 132 kW.

Nothing on this machine regulates itself, and nothing ever will. There is no
automatic voltage regulator and no isochronous governor: the field is a
rheostat, the speed is whatever the governor droop and your hand on the setting
make it, and a synchronous machine left alone loses close to a third of its
terminal volts between no load and full load. You crank it, close the field
breaker, wind the volts up to 480, close the main breaker — and then keep
trimming as the load comes and goes.

What protects the plant is a bank of protective relays. Every one of them
latches its target when it operates, and nothing closes again until you have
walked the board and reset it.

```bash
npm start      # http://localhost:8080
npm test       # 66 tests over the physics, the operator controls and the career
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
in a 144 KB APK.

Prices are in period sterling and the date runs from 1 April 1963, but the
economy is balanced for play rather than to 1963 price levels — and the upper
tech tree (SCR aftertreatment, lithium buffers, organic Rankine cycles) runs
well past what 1963 could actually build. The desk is the period piece; the
engineering is allowed to be ahead of it.

## Operating it

Two controls do everything, and what they do depends entirely on whether you are
on your own or tied to a live bus.

| | Off bus (island load) | On bus (paralleled) |
| --- | --- | --- |
| **Throttle** | engine speed → **frequency** | mechanical power → load angle → **real power (kW)** |
| **Field** | excitation → **voltage** | internal EMF → **reactive power (kVAr)** |

That reversal is the central fact of synchronous machine operation, and it falls
out of the model rather than being special-cased. Tied to a bus, the frequency
and voltage are the bus's to hold; what you are accountable for is how much real
power you export and how much reactive power you push into it.

**Starting.** The set fires and runs at idle, around 800 rpm, and stays there
until you put the run switch to `RATED`. The governor then walks its speed
reference up rather than stepping to it, so the machine climbs to 1800 rpm over
five or six seconds with the rack around a third open — not a wide-open dash.
A diesel also makes nothing like its rated torque down at cranking speeds, and
the model now says so.

**Governor.** `HAND RACK` puts your hand directly on the fuel rack, and nothing
at all holds the speed — drop the load with the rack open and the engine runs
away into the overspeed trip. `GOVERNOR` is the flyweight unit: speed falls as
load rises. Changing between them is bumpless, the new mode taking over holding
the rack where it already is.

The **droop setting** is a control in its own right, because it has to be. Tight
droop holds frequency hard on an island. Wide droop is what lets a machine share
load on a bus without the rack slamming between its stops — at half a percent
droop, the entire load range of a machine tied to a stiff bus lives inside nine
rpm of the speed setting. A flyweight governor will go no tighter than 3%; the
hydraulic governor opens the range down to 0.5%.

**Field rheostat.** The only thing driving the excitation is your hand on it.
Series compounding, when fitted, feeds load current back into the exciter and
cancels most of the sag passively — it is a transformer, not a regulator, so you
still set the volts yourself, there is just far less chasing.

**Protective relays.** Under and over frequency, under and over volts,
inverse-time overcurrent, reverse power, low oil pressure, and the mechanical
overspeed. Each drops its target and stays dropped. Reverse power matters the
moment you are on a bus: let the speed setting fall and the bus starts motoring
your set, and the relay throws it off line. Low oil pressure shuts the engine
down outright.

**Instruments.** A stock board gives you frequency, volts, amps, kilowatts,
coolant, fuel, rack position and stack opacity. The full switchboard adds an
exhaust pyrometer, a proper oil pressure gauge and an integrating kWh register.
Oil pressure is not decoration: it falls as the oil thins with heat, and below
1 bar the relay shuts the engine down.

**Air/fuel ratio.** The AFR meter reads the balance the smoke limiter is already
enforcing. Full rack on a healthy naturally aspirated six lands at 17.5:1, which
is the real diesel smoke limit; light load runs 90:1 and up. Go below the limit
and you make soot instead of torque, which the contract's emissions clause
notices.

**Synchronising.** Paralleling contracts put a live bus behind the terminals and
a synchroscope on the desk. The needle sits at the phase difference and rotates
once per beat of slip: clockwise when you are fast, anticlockwise when slow. You
match volts on the field, set the machine a touch fast on the throttle so the
needle creeps clockwise, and close at the mark. Close it out of step and the
rotor is dragged bodily into step with the bus — expect real damage and to be
thrown straight back off line. Paralleling switchgear brings a check-sync relay
that simply refuses the close; without one, there is nothing between you and the
bang.

Hold too much load on a bus and the load angle walks past 90°, the machine slips
a pole and drops off line — with an overcurrent target standing to show for it.

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
- **Voltage regulation is genuinely bad by hand.** Terminal volts are the internal
  EMF minus armature reaction, so they sag with load — far enough, if you close
  onto a heavy load with the field still set for no load, to bring the
  under-voltage relay in before you can wind it out.
- **Low-speed torque is poor.** Charge motion, volumetric efficiency and
  injection are all bad at idle, so the engine makes about a third of its rated
  torque down there. It is what stops a start being instantaneous.
- **Paralleled machines swing.** The rotor is held to the bus by synchronising
  torque and damper windings, so a load change sets up a real ~1.5 Hz swing that
  settles out, and too much load pulls it out of step entirely.

Calibrated against real machines: ~22 L/h and 0.25 kg/kWh at full load, ~96 °C
coolant, ~6 min thermal time constant, 2.3 L/h at idle.

## The tech tree

Five branches, 32 nodes, one either/or fork.

| Branch | What it buys you |
| --- | --- |
| **Air & Fuel** | Turbocharging, intercooling, common rail. Raw output and cleaner combustion. |
| **Materials** | Bottom-end strength, oil pressure, ring seal, and the alternator rewind that lifts the electrical ceiling. |
| **Thermal** | Cooling headroom, then waste-heat recovery and CHP — selling the heat you were throwing away. |
| **Control** | Compound exciter, hydraulic governor, paralleling switchgear, aneroid boost compensator, hybrid battery buffer, full switchboard instruments. |
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

Twenty-one hand-written contracts across five reputation tiers, plus generated
filler work. Three of them put you on a live bus, where the clause is on power
factor rather than voltage. Each has a load profile (flat, ramping, square-wave, spiking, diurnal),
frequency and voltage clauses, site conditions, and liquidated damages.

Contracts pay a mobilisation advance on acceptance — which is what guarantees you
can always afford fuel for the job you just took — then settle on energy
delivered, minus penalties for shortfall, frequency excursions, voltage
excursions and visible smoke. Penalties are capped at the contract's value, so
one bad night is a setback rather than a dead save. Clients you do well by call
again as repeat business.

There is no wear meter and no servicing. The machine does not quietly decay in
the background — what punishes you is the shift you are actually working: volts
out of band, supply not delivered, soot over the site, and relays on the floor
because you were not watching the board.

## Controls

The speed lever spans 58 to 62 Hz and nothing else, because that is the only
range a genset lever needs to reach. Arrow up/down trims it, shift+arrows trims
the field, alt for fine steps. The raise/lower switches beside each lever repeat while held. Space
pauses; `1`–`6` set the time scale from 1× to 600×. The simulation is
timestep-independent across that whole range — there is a test for it, because a
governor loop that went unstable at 600× would quietly invent penalties.

## Android

`npm run apk` produces a sideloadable `load-bank.apk` (~144 KB). It needs an
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
test/              66 tests
```

Beyond the unit tests there are three browser checks (all need `npm i` and a
running `npm start`): `npm run smoke` plays a full job end to end and fails on
any console error, `npm run mobile` renders every tab at phone and tablet sizes
and fails on horizontal overflow, and `npm run operator` drives the control desk
by hand — manual start, hand voltage trim, then synchronising onto a live bus and
sweeping throttle against field to confirm they really do control kW and kVAr.

The physics core is pure and deterministic, which is why the interesting
properties are testable at all: that BSFC lands in the real range, that a
hydraulic governor droops four times tighter than a flyweight one, that oil
pressure falls as the oil heats, that the run-up to rated speed is paced rather
than a wide-open dash, that smoke only ever appears
below 17.5:1, that the synchroscope turns once per beat of slip, that an
out-of-phase close throws the overcurrent relay and locks the breaker out until
the board is reset, while a check-sync relay prevents it happening at all, that
throttle and field swap roles the moment you tie to a bus, that fast-forward
doesn't change the answer, and that no legal combination of upgrades produces a
degenerate machine.
