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
      s.durability *= 1.08;
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
    detail: 'Cheapest durability in the game, and it shears less when the sump gets hot.',
    apply: (s) => {
      s.durability *= 1.25;
      s.frictionB *= 0.96;
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
    detail: 'Raises the torque the bottom end will tolerate before something lets go. A prerequisite for running real boost.',
    apply: (s) => {
      s.torqueLimit += 140;
      s.durability *= 1.2;
      s.inertia += 0.6;
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
    detail: 'The single largest reduction in bore wear available, and it holds its crosshatch under abrasive site conditions.',
    apply: (s) => {
      s.durability *= 1.55;
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
      s.durability *= 1.1;
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
    detail: 'Oil film strength collapses with temperature. Holding the sump cool is what lets you sit at high load for days.',
    apply: (s) => {
      s.oilCooled = true;
      s.durability *= 1.12;
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
    name: 'Digital AVR',
    cost: 2200,
    blurb: 'Microprocessor excitation control.',
    detail: 'Holds terminal voltage almost flat against load. Without it, voltage sags with every kilowatt you add.',
    apply: (s) => {
      s.voltSag = 0.008;
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
    detail: 'Halves the droop of the mechanical governor. A stopgap, but a cheap one.',
    apply: (s) => {
      s.droop = 0.015;
    },
  },
  {
    id: 'isoch',
    branch: 'control',
    row: 2,
    requires: ['govlinkage'],
    name: 'Isochronous Electronic Governor',
    cost: 8800,
    blurb: 'Closed-loop speed control with integral action.',
    detail:
      'Holds exactly 60.0 Hz at any load instead of drooping across the range. Everything with a tight frequency clause needs this.',
    apply: (s) => {
      s.isochronous = true;
      s.droop = 0;
    },
  },
  {
    id: 'anticipate',
    branch: 'control',
    row: 3,
    requires: ['isoch', 'turbo'],
    name: 'Load-Anticipating Control',
    cost: 10200,
    blurb: 'Feed-forward from the site breaker signals.',
    detail:
      'Starts fuelling before the load actually lands, so boost is already there. The answer to turbo lag on step loads.',
    apply: (s) => {
      s.loadAnticipation = 0.55;
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
    row: 4,
    requires: ['battery'],
    name: 'Paralleling Switchgear',
    cost: 19500,
    blurb: 'Synchroniser, check relay and load-sharing lines.',
    detail:
      'Lets the set share a bus with others. Opens up the large multi-machine jobs where the real money is.',
    apply: (s) => {
      s.capabilities.push('parallel');
    },
  },
  {
    id: 'telemetry',
    branch: 'control',
    row: 3,
    requires: ['isoch'],
    name: 'Predictive Maintenance Telemetry',
    cost: 6300,
    blurb: 'Oil debris sensing, vibration spectra, cloud logging.',
    detail:
      'Shows true component condition instead of an idiot light, and lets you service on evidence. Cuts service cost sharply.',
    apply: (s) => {
      s.capabilities.push('telemetry');
      s.durability *= 1.1;
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
