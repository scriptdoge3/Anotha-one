/**
 * The tech tree.
 *
 * Every node's `apply(spec)` pokes the same physics fields `sim.js` reads, so
 * an upgrade is never a cosmetic stat bump -- fitting a turbo really does raise
 * the air available for combustion, which really does let the rack inject more
 * fuel without sooting, which really does show up as torque on the shaft.
 *
 * Layout: `col` picks the branch, `row` the tier. The UI draws prerequisite
 * lines from these coordinates.
 */

export const BRANCHES = [
  { id: 'air', name: 'Air & Fuel', col: 0, hue: 18 },
  { id: 'mech', name: 'Materials', col: 1, hue: 42 },
  { id: 'thermal', name: 'Thermal', col: 2, hue: 190 },
  { id: 'control', name: 'Control', col: 3, hue: 262 },
  { id: 'compliance', name: 'Compliance', col: 4, hue: 140 },
];

/**
 * `excludes` marks forks you must commit to -- taking one locks the sibling out
 * permanently, so the tree branches rather than merely gating.
 */
export const TECH = [
  // ============ AIR & FUEL =============================================
  {
    id: 'intake',
    branch: 'air',
    row: 0,
    name: 'Free-Flow Intake',
    cost: 900,
    blurb: 'Cyclonic pre-cleaner and a low-restriction element.',
    detail: 'A few percent more air for very little money. Everything downstream breathes better.',
    apply: (s) => {
      s.chargeDensityBonus += 0.04;
      s.frictionA -= 1;
    },
  },
  {
    id: 'turbo',
    branch: 'air',
    row: 1,
    requires: ['intake'],
    name: 'Turbocharger',
    cost: 6400,
    blurb: 'Exhaust-driven compressor and an uprated injection pump.',
    detail:
      'The single biggest jump in output available. Costs you throttle response: until the turbo spools, the extra fuel the bigger pump delivers has no air to burn with, and you make soot instead of torque.',
    apply: (s) => {
      s.boostGain += 0.36;
      s.fuelScale *= 1.36;
      s.boostTau = 1.6;
      s.coolantHeatFrac += 0.02;
      s.noiseDb -= 2;
    },
  },
  {
    id: 'intercooler',
    branch: 'air',
    row: 2,
    requires: ['turbo'],
    name: 'Air-to-Air Intercooler',
    cost: 4200,
    blurb: 'Charge cooling between compressor and intake.',
    detail: 'Denser charge means more air per stroke: more power, less soot, lower combustion temperatures.',
    apply: (s) => {
      s.chargeDensityBonus += 0.1;
      s.coolantHeatFrac -= 0.02;
    },
  },
  {
    id: 'vgt',
    branch: 'air',
    row: 3,
    requires: ['intercooler'],
    excludes: ['compound'],
    name: 'Variable-Geometry Turbo',
    cost: 11800,
    blurb: 'Moving vanes close down at low flow to kill lag.',
    detail:
      'Trades a little peak output for a turbo that is already spooled when the load lands. The transient specialist. Locks out Compound Turbocharging.',
    apply: (s) => {
      s.boostTau = 0.45;
      s.boostGain += 0.06;
      s.backPressure += 0.03;
    },
  },
  {
    id: 'compound',
    branch: 'air',
    row: 3,
    requires: ['intercooler'],
    excludes: ['vgt'],
    name: 'Compound Turbocharging',
    cost: 13500,
    blurb: 'A large turbo feeding a small one, in series.',
    detail:
      'Enormous top-end air and the headroom to run well past the plate rating. Spools like a barge. The endurance specialist. Locks out Variable-Geometry.',
    apply: (s) => {
      s.boostGain += 0.3;
      s.fuelScale *= 1.16;
      s.boostTau = 2.6;
      s.torqueLimit += 60;
      s.coolantHeatFrac += 0.02;
    },
  },
  {
    id: 'commonrail',
    branch: 'air',
    row: 2,
    requires: ['intake'],
    name: 'Common-Rail Injection',
    cost: 7600,
    blurb: 'High-pressure rail with electronic injectors.',
    detail: 'Finer atomisation burns more of the fuel you paid for, and decouples injection timing from engine speed.',
    apply: (s) => {
      s.indicatedEff += 0.03;
      s.noiseDb -= 3;
    },
  },
  {
    id: 'piezo',
    branch: 'air',
    row: 3,
    requires: ['commonrail'],
    name: 'Piezo Multi-Pulse Injectors',
    cost: 9900,
    blurb: 'Five injection events per cycle.',
    detail: 'A pilot injection softens the pressure rise; post-injections clean up the soot the main event leaves behind.',
    apply: (s) => {
      s.indicatedEff += 0.025;
      s.noiseDb -= 5;
      s.chargeDensityBonus += 0.03;
    },
  },

  // ============ MATERIALS ==============================================
  {
    id: 'synthoil',
    branch: 'mech',
    row: 0,
    name: 'Full-Synthetic Lubricant',
    cost: 700,
    blurb: 'Group IV base oil with a proper additive pack.',
    detail:
      'Group IV base stock holds its film and its pressure when the sump is hot, so the oil gauge stays where it should on a long hard run instead of sagging towards the low-pressure trip.',
    apply: (s) => {
      s.frictionB *= 0.96;
      s.oilPressureRated += 0.55;
    },
  },
  {
    id: 'crank',
    branch: 'mech',
    row: 1,
    requires: ['synthoil'],
    name: 'Forged Steel Crankshaft',
    cost: 8200,
    blurb: 'Forged and nitrided, with wider main journals.',
    detail:
      'Raises the torque the bottom end will tolerate before something lets go, and the heavier flywheel steadies the shaft: less hunting, and a shallower dip when a big load lands.',
    apply: (s) => {
      s.torqueLimit += 140;
      s.inertia += 0.6;
      s.hunt *= 0.8;
    },
  },
  {
    id: 'alloyblock',
    branch: 'mech',
    row: 1,
    requires: ['synthoil'],
    name: 'Alloy Block & Head',
    cost: 10400,
    blurb: 'Aluminium-silicon casting with iron liners.',
    detail: 'Sheds heat into the coolant far more readily and takes mass out of the rotating assembly.',
    apply: (s) => {
      s.radiatorUA += 120;
      s.thermalMass *= 0.72;
      s.inertia -= 0.7;
      s.frictionA -= 1.5;
    },
  },
  {
    id: 'ceramic',
    branch: 'mech',
    row: 2,
    requires: ['alloyblock'],
    name: 'Thermal Barrier Coating',
    cost: 9100,
    blurb: 'Zirconia on the crowns, valves and ports.',
    detail:
      'Keeps combustion heat in the gas instead of the coolant. More of it reaches the piston, and what escapes reaches the turbine hotter and spools it harder.',
    apply: (s) => {
      s.indicatedEff += 0.028;
      s.coolantHeatFrac -= 0.05;
      s.boostTau *= 0.82;
    },
  },
  {
    id: 'liners',
    branch: 'mech',
    row: 2,
    requires: ['crank'],
    name: 'Nitrided Cylinder Liners',
    cost: 7300,
    blurb: 'Plateau-honed, surface-hardened bores.',
    detail:
      'A hard, finely honed bore seals the rings properly. Less blow-by past the pistons means more of every combustion stroke reaches the crank, and a cleaner crankcase keeps the oil pressure up.',
    apply: (s) => {
      s.indicatedEff += 0.012;
      s.oilPressureRated += 0.35;
      s.frictionB *= 0.95;
    },
  },
  {
    id: 'lowfriction',
    branch: 'mech',
    row: 3,
    requires: ['liners'],
    name: 'Low-Friction Rotating Kit',
    cost: 12600,
    blurb: 'Roller cam followers, DLC pins, low-tension rings.',
    detail: 'Every watt not spent dragging metal over metal is a watt you can sell.',
    apply: (s) => {
      s.frictionA -= 3;
      s.frictionB *= 0.72;
    },
  },

  {
    id: 'windings',
    branch: 'mech',
    row: 2,
    requires: ['alloyblock'],
    name: 'Uprated Stator Windings',
    cost: 11200,
    blurb: 'Rewound stator in heavier-gauge copper.',
    detail:
      'The engine can be made to produce far more shaft power than the stock electrical end will carry. This is what turns that shaft power into something you can actually sell.',
    apply: (s) => {
      s.altRatingKW += 22;
      s.altEff += 0.015;
    },
  },
  {
    id: 'classh',
    branch: 'mech',
    row: 3,
    requires: ['windings'],
    name: 'Class H Insulation & Air Blast',
    cost: 16800,
    blurb: '180 C insulation system with forced ventilation.',
    detail:
      'Winding temperature, not copper cross-section, is what finally limits continuous output. Fix that and the electrical end stops being the bottleneck.',
    apply: (s) => {
      s.altRatingKW += 18;
      s.altEff += 0.01;
      s.fanPowerKW += 0.4;
    },
  },

  // ============ THERMAL ================================================
  {
    id: 'radiator',
    branch: 'thermal',
    row: 0,
    name: 'High-Capacity Radiator',
    cost: 1900,
    blurb: 'Larger core, higher fin density, 50 C ambient pack.',
    detail: 'Buys you headroom on hot sites and at high load factors, where the stock core starts to derate.',
    apply: (s) => {
      s.radiatorUA += 420;
    },
  },
  {
    id: 'vsfan',
    branch: 'thermal',
    row: 1,
    requires: ['radiator'],
    name: 'Variable-Speed Fan',
    cost: 3400,
    blurb: 'Electric fan on closed-loop temperature control.',
    detail:
      'A fixed fan eats 1.6 kW whenever the engine turns. This one modulates, giving that back as saleable output and shortening warm-up.',
    apply: (s) => {
      s.fanVariable = true;
      s.fanPowerKW = 1.9;
      s.noiseDb -= 3;
    },
  },
  {
    id: 'oilcooler',
    branch: 'thermal',
    row: 1,
    requires: ['radiator'],
    name: 'Engine Oil Cooler',
    cost: 2600,
    blurb: 'Plate heat exchanger in the oil circuit.',
    detail:
      'Oil thins as it heats, and thin oil means low pressure. A plate exchanger in the oil circuit holds the gauge up where it belongs when the set has been sitting at high load for days.',
    apply: (s) => {
      s.oilCooled = true;
      s.radiatorUA += 60;
    },
  },
  {
    id: 'orc',
    branch: 'thermal',
    row: 3,
    requires: ['oilcooler', 'intercooler'],
    name: 'Organic Rankine Cycle',
    cost: 22000,
    blurb: 'A closed refrigerant turbine on the exhaust stream.',
    detail:
      'Recovers waste heat as extra shaft power for free. The exhaust was going to be hot anyway.',
    apply: (s) => {
      s.indicatedEff += 0.035;
      s.backPressure += 0.05;
      s.radiatorUA += 150;
    },
  },
  {
    id: 'chp',
    branch: 'thermal',
    row: 4,
    requires: ['orc'],
    name: 'CHP Heat Offtake',
    cost: 18500,
    blurb: 'Jacket and exhaust exchangers with a flow header.',
    detail:
      'Sells the heat you have been throwing away to the sky. Unlocks combined heat and power contracts, where the thermal side can outearn the electrical.',
    apply: (s) => {
      s.chpFrac = 0.52;
      s.capabilities.push('chp');
      s.radiatorUA += 200;
    },
  },

  // ============ CONTROL ================================================
  {
    id: 'avr',
    branch: 'control',
    row: 0,
    name: 'Compound-Wound Exciter',
    cost: 2200,
    blurb: 'Current transformer feeding the exciter field.',
    detail:
      'A synchronous machine loses close to a third of its terminal volts between no load and full load, and every one of them has to be wound back in on the rheostat by hand. Compounding feeds load current back into the exciter so most of that sag never happens. It is a transformer, not a regulator — you still set the volts yourself, there is just far less chasing.',
    apply: (s) => {
      s.compounded += 0.16;
    },
  },
  {
    id: 'govlinkage',
    branch: 'control',
    row: 1,
    requires: ['avr'],
    name: 'Precision Governor Linkage',
    cost: 1800,
    blurb: 'Ball-jointed rack linkage, rebuilt flyweights.',
    detail:
      'Rebuilt flyweights and ball-jointed linkage take the lost motion out of the governor: droop halves, and it stops wandering about the setpoint. A stopgap, but a cheap one.',
    apply: (s) => {
      s.droop = 0.015;
      s.droopMin = 0.015;
      s.hunt *= 0.5;
    },
  },
  {
    id: 'isoch',
    branch: 'control',
    row: 2,
    requires: ['govlinkage'],
    name: 'Hydraulic Governor',
    cost: 8800,
    blurb: 'Oil-servo governor with adjustable droop.',
    detail:
      'A flyweight governor working through an oil servo instead of a rod and spring. Droop comes down to half a percent, the hunting all but disappears, and it moves the rack far faster on a load change. Still a droop governor: the speed setting is yours to make.',
    apply: (s) => {
      s.droop = 0.005;
      s.droopMin = 0.005;
      s.hunt *= 0.15;
      s.speedSlew = 300;
    },
  },
  {
    id: 'anticipate',
    branch: 'control',
    row: 3,
    requires: ['isoch', 'turbo'],
    name: 'Aneroid Boost Compensator',
    cost: 10200,
    blurb: 'Rack stop tied to manifold pressure.',
    detail:
      'A bellows on the inlet manifold that physically holds the fuel rack back until the boost is actually there. The engine takes longer to pick up a big step, but it stops laying a black cloud over the site every time it does.',
    apply: (s) => {
      s.aneroid = true;
    },
  },
  {
    id: 'battery',
    branch: 'control',
    row: 3,
    requires: ['isoch'],
    name: 'Hybrid Battery Buffer',
    cost: 24000,
    blurb: '30 kWh lithium pack on a bidirectional inverter.',
    detail:
      'Absorbs peaks the engine would have to smoke its way through, and recharges in the troughs. Makes spiky loads almost pleasant.',
    apply: (s) => {
      s.batteryKWh = 30;
      s.batteryKW = 40;
      s.capabilities.push('hybrid');
    },
  },
  {
    id: 'parallel',
    branch: 'control',
    row: 3,
    requires: ['isoch'],
    name: 'Paralleling Switchgear',
    cost: 14500,
    blurb: 'Synchroscope, check-sync relay and load-sharing lines.',
    detail:
      'Lets the set be tied to a live bus. Brings a synchroscope onto the desk, and a check-sync relay that refuses a breaker close that would be violent — without it there is nothing between you and an out-of-phase close.',
    apply: (s) => {
      s.capabilities.push('parallel');
      s.checkSync = true;
    },
  },
  {
    id: 'telemetry',
    branch: 'control',
    row: 3,
    requires: ['isoch'],
    name: 'Full Switchboard Instruments',
    cost: 4300,
    blurb: 'Exhaust pyrometer, oil gauge and kWh register.',
    detail:
      'A stock set gives you a voltmeter, a frequency meter and an ammeter. This adds the instruments that tell you what the engine is actually doing: a thermocouple pyrometer on the exhaust manifold, a proper oil pressure gauge, and an integrating kilowatt-hour register on the board.',
    apply: (s) => {
      s.fullInstruments = true;
      s.capabilities.push('telemetry');
    },
  },

  // ============ COMPLIANCE =============================================
  {
    id: 'canopy',
    branch: 'compliance',
    row: 0,
    name: 'Acoustic Canopy',
    cost: 3100,
    blurb: 'Lined enclosure with a residential-grade silencer.',
    detail:
      'Drops the set to roughly 68 dB(A) at 7 m. Required for anything near people at night.',
    apply: (s) => {
      s.noiseDb -= 22;
      s.backPressure += 0.04;
      s.radiatorUA -= 90;
      s.capabilities.push('quiet');
    },
  },
  {
    id: 'doc',
    branch: 'compliance',
    row: 1,
    requires: ['canopy'],
    name: 'Oxidation Catalyst',
    cost: 2900,
    blurb: 'Flow-through precious-metal catalyst.',
    detail: 'Burns off carbon monoxide and unburnt hydrocarbons. The entry ticket to emissions-controlled sites.',
    apply: (s) => {
      s.emissionsTier = 3;
      s.backPressure += 0.03;
    },
  },
  {
    id: 'dpf',
    branch: 'compliance',
    row: 2,
    requires: ['doc'],
    name: 'Diesel Particulate Filter',
    cost: 8700,
    blurb: 'Wall-flow silicon carbide filter with active regen.',
    detail:
      'Traps soot properly, at the cost of exhaust backpressure. Load it up with smoke and it will clog: keep the fuelling clean.',
    apply: (s) => {
      s.emissionsTier = 4;
      s.backPressure += 0.09;
      s.capabilities.push('dpf');
    },
  },
  {
    id: 'scr',
    branch: 'compliance',
    row: 3,
    requires: ['dpf'],
    name: 'SCR Aftertreatment',
    cost: 15400,
    blurb: 'Urea dosing into a vanadium catalyst.',
    detail:
      'Strips the nitrogen oxides that in-cylinder tricks cannot. Completes Stage V / Tier 4 Final certification and opens hospital and municipal work.',
    apply: (s) => {
      s.emissionsTier = 5;
      s.backPressure += 0.04;
      s.capabilities.push('tier4');
    },
  },
  {
    id: 'hvo',
    branch: 'compliance',
    row: 2,
    requires: ['doc'],
    name: 'HVO Fuel Conversion',
    cost: 5200,
    blurb: 'Seals, filtration and mapping for renewable diesel.',
    detail:
      'Hydrotreated vegetable oil: burns cleaner, costs more per litre, and carries fewer joules per litre so you will use more of it. Some clients will pay handsomely for it anyway.',
    apply: (s) => {
      s.fuel = 'hvo';
      s.capabilities.push('hvo');
      s.indicatedEff += 0.005;
    },
  },
];

export const TECH_BY_ID = Object.fromEntries(TECH.map((t) => [t.id, t]));

/** Nodes locked out because you committed to the other side of a fork. */
export function lockedBy(owned) {
  const locked = new Set();
  for (const id of owned) {
    for (const other of TECH_BY_ID[id]?.excludes ?? []) locked.add(other);
  }
  return locked;
}

export function canResearch(node, owned, money) {
  const have = new Set(owned);
  if (have.has(node.id)) return { ok: false, reason: 'owned' };
  if (lockedBy(owned).has(node.id)) return { ok: false, reason: 'locked' };
  const missing = (node.requires ?? []).filter((r) => !have.has(r));
  if (missing.length) return { ok: false, reason: 'requires', missing };
  if (money < node.cost) return { ok: false, reason: 'money' };
  return { ok: true };
}

/**
 * Fold every owned node into a single spec. Order matters for multiplicative
 * terms, so we always apply in declaration order rather than purchase order --
 * two players with the same tech always get the same machine.
 */
export function buildSpec(owned, baseSpecFn) {
  const spec = baseSpecFn();
  spec.capabilities = [...spec.capabilities];
  const have = new Set(owned);
  for (const node of TECH) {
    if (have.has(node.id)) node.apply(spec);
  }
  // Guard rails: no amount of stacking should produce nonsense.
  spec.frictionA = Math.max(4, spec.frictionA);
  spec.radiatorUA = Math.max(400, spec.radiatorUA);
  spec.inertia = Math.max(2.5, spec.inertia);
  spec.coolantHeatFrac = Math.max(0.16, spec.coolantHeatFrac);
  spec.boostTau = Math.max(0.3, spec.boostTau);
  return spec;
}

/** Total spent, for the career summary. */
export function investedIn(owned) {
  return owned.reduce((sum, id) => sum + (TECH_BY_ID[id]?.cost ?? 0), 0);
}
