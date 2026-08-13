/**
 * Contracts: the career layer.
 *
 * A contract is a load profile plus a set of clauses. The sim doesn't know any
 * of this exists -- it just gets handed a demand in kW every tick and reports
 * what it managed to deliver. Everything here is bookkeeping on top of that.
 *
 * Load figures are tuned against measured machine capability:
 *   stock 78 kW | +turbo 84 | +intercooler 88 | +radiator 92
 *   +windings 110 | +compound 114 | +class H 120 | fully built 132
 */

import { RATED_KW } from './sim.js';

/** Evaluate a serialisable load profile at time `h` (hours into the job). */
export function demandAt(profile, h) {
  const p = profile;
  switch (p.type) {
    case 'steady':
      return p.kw;

    case 'cycle': {
      // Square wave: the brutal one. Step loads with no warning.
      const period = p.periodMin / 60;
      const phase = (h % period) / period;
      return phase < (p.dutyPct ?? 50) / 100 ? p.high : p.low;
    }

    case 'sine': {
      const period = p.periodMin / 60;
      return p.mean + p.amp * Math.sin((2 * Math.PI * h) / period);
    }

    case 'spike': {
      const period = p.everyMin / 60;
      const into = (h % period) * 3600;
      return into < p.durSec ? p.spike : p.base;
    }

    case 'ramp': {
      const pts = p.points;
      if (h <= pts[0][0]) return pts[0][1];
      for (let i = 1; i < pts.length; i++) {
        if (h <= pts[i][0]) {
          const [h0, v0] = pts[i - 1];
          const [h1, v1] = pts[i];
          const t = (h - h0) / Math.max(h1 - h0, 1e-6);
          return v0 + (v1 - v0) * t;
        }
      }
      return pts[pts.length - 1][1];
    }

    case 'diurnal': {
      // Day/night swing, peaking early evening.
      const frac = ((h % 24) / 24 + 0.32) % 1;
      return p.min + (p.max - p.min) * (0.5 - 0.5 * Math.cos(2 * Math.PI * frac));
    }

    default:
      return 0;
  }
}

/** Peak demand over the whole job, sampled finely enough to catch spikes. */
export function peakDemand(profile, hours) {
  let peak = 0;
  const stepH = Math.min(0.005, hours / 400);
  for (let h = 0; h <= hours; h += stepH) {
    peak = Math.max(peak, demandAt(profile, h));
  }
  return peak;
}

export function meanDemand(profile, hours) {
  let sum = 0;
  const n = 600;
  for (let i = 0; i < n; i++) sum += demandAt(profile, (hours * i) / n);
  return sum / n;
}

/** Human-readable shape description for the contract card. */
export function profileLabel(p) {
  switch (p.type) {
    case 'steady': return `Flat ${p.kw} kW`;
    case 'cycle': return `Step ${p.low}/${p.high} kW every ${p.periodMin} min`;
    case 'sine': return `Swinging ${p.mean - p.amp}-${p.mean + p.amp} kW`;
    case 'spike': return `${p.base} kW base, ${p.spike} kW spikes`;
    case 'ramp': return `Ramping to ${Math.max(...p.points.map((x) => x[1]))} kW`;
    case 'diurnal': return `Diurnal ${p.min}-${p.max} kW`;
    default: return 'Unknown';
  }
}

const CAP_LABEL = {
  quiet: 'Acoustic canopy',
  tier4: 'Tier 4 Final / Stage V',
  chp: 'CHP heat offtake',
  parallel: 'Paralleling switchgear',
  hybrid: 'Hybrid battery buffer',
  hvo: 'HVO fuel conversion',
  telemetry: 'Predictive telemetry',
};
export const capLabel = (c) => CAP_LABEL[c] ?? c;

/**
 * The contract book. Tier gates on reputation; `requires` gates on fitted tech.
 */
export const CONTRACTS = [
  // ---------------- TIER 1 : you and a clapped-out set ------------------
  {
    id: 't1-barn',
    tier: 1,
    title: 'Barn Conversion Rewire',
    client: 'Hallam Farm',
    brief:
      'Temporary supply while the incoming main is replaced. Nobody is listening and nobody is measuring. A gentle start.',
    hours: 8,
    profile: { type: 'steady', kw: 32 },
    payPerKWh: 0.72,
    mobilization: 220,
    freqTolHz: 2.5,
    voltTolPct: 10,
    penaltyPerOutageMin: 4,
    repGain: 5,
    ambientC: 16,
  },
  {
    id: 't1-roadworks',
    tier: 1,
    title: 'Carriageway Lighting Array',
    client: 'Vennor Highways',
    brief:
      'Lighting towers on a night closure. Load climbs as the crew brings masts up, then sits flat until dawn.',
    hours: 11,
    profile: { type: 'ramp', points: [[0, 12], [1.5, 44], [9.5, 44], [11, 18]] },
    payPerKWh: 0.68,
    mobilization: 300,
    freqTolHz: 2.2,
    voltTolPct: 9,
    penaltyPerOutageMin: 6,
    repGain: 6,
    ambientC: 9,
  },
  {
    id: 't1-fete',
    tier: 1,
    title: 'Village Show Catering',
    client: 'Marbury Parish Council',
    brief:
      'Fryers and urns on a field. The spikes are short but they are not small, and the committee will notice if the lights dip.',
    hours: 9,
    profile: { type: 'spike', base: 24, spike: 58, everyMin: 12, durSec: 130 },
    payPerKWh: 0.8,
    mobilization: 260,
    freqTolHz: 2.0,
    voltTolPct: 9,
    penaltyPerOutageMin: 9,
    repGain: 7,
    ambientC: 21,
  },
  {
    id: 't1-sawmill',
    tier: 1,
    title: 'Sawmill Load Bank Test',
    client: 'Ockridge Timber',
    brief:
      'Prove the set against a rising load bank all the way to its plate rating. Straightforward, if your engine still makes what the badge claims.',
    hours: 6,
    profile: { type: 'ramp', points: [[0, 20], [1, 40], [2.5, 60], [4, 72], [5.5, 72], [6, 30]] },
    payPerKWh: 0.75,
    mobilization: 380,
    freqTolHz: 1.8,
    voltTolPct: 8,
    penaltyPerOutageMin: 12,
    repGain: 9,
    ambientC: 19,
  },

  // ---------------- TIER 2 : reputation 22 ------------------------------
  {
    id: 't2-hospital-drill',
    tier: 2,
    title: 'Hospital Annexe Standby Drill',
    client: 'St Ediths Trust',
    brief:
      'A scheduled black-building test. The estates manager will be standing next to the frequency meter with a clipboard for twelve hours.',
    hours: 12,
    profile: { type: 'sine', mean: 46, amp: 9, periodMin: 90 },
    payPerKWh: 0.95,
    mobilization: 900,
    freqTolHz: 1.0,
    voltTolPct: 6,
    penaltyPerOutageMin: 55,
    critical: true,
    repGain: 12,
    ambientC: 18,
  },
  {
    id: 't2-batching',
    tier: 2,
    title: 'Concrete Batching Plant',
    client: 'Ardley Aggregates',
    brief:
      'The mixer drops in and out on a four-minute cycle with nothing in between. Whatever your governor does about that, it will do it two hundred times.',
    hours: 14,
    profile: { type: 'cycle', low: 22, high: 74, periodMin: 4, dutyPct: 55 },
    payPerKWh: 0.86,
    mobilization: 700,
    freqTolHz: 1.5,
    voltTolPct: 7,
    penaltyPerOutageMin: 25,
    repGain: 11,
    ambientC: 22,
    abrasion: 1.35,
  },
  {
    id: 't2-filmset',
    tier: 2,
    title: 'Night Shoot — Unit Base',
    client: 'Gullwing Pictures',
    brief:
      'Dialogue scenes forty metres away. If they can hear you on the boom, you are off the lot and not coming back.',
    hours: 11,
    profile: { type: 'diurnal', min: 26, max: 52 },
    payPerKWh: 1.35,
    mobilization: 1500,
    freqTolHz: 1.2,
    voltTolPct: 6,
    penaltyPerOutageMin: 40,
    requires: ['quiet'],
    repGain: 14,
    ambientC: 12,
  },
  {
    id: 't2-alpine',
    tier: 2,
    title: 'Ridge Comms Relay',
    client: 'Norlink Telecom',
    brief:
      'Twenty-four hours at 2,400 metres. The air up there is thin enough that a naturally aspirated set will simply run out of oxygen.',
    hours: 24,
    profile: { type: 'steady', kw: 48 },
    payPerKWh: 1.15,
    mobilization: 1800,
    freqTolHz: 1.4,
    voltTolPct: 7,
    penaltyPerOutageMin: 45,
    altitudeM: 2400,
    ambientC: 2,
    repGain: 15,
  },
  {
    id: 't2-aerators',
    tier: 2,
    title: 'Hatchery Aerator Bank',
    client: 'Sandwater Fisheries',
    brief:
      'Twenty hours of flat, heavy load in thirty-six degree heat. Nothing clever, but the cooling system has nowhere to hide.',
    hours: 20,
    profile: { type: 'steady', kw: 62 },
    payPerKWh: 0.88,
    mobilization: 800,
    freqTolHz: 1.6,
    voltTolPct: 7,
    penaltyPerOutageMin: 50,
    critical: true,
    ambientC: 36,
    repGain: 13,
  },

  // ---------------- TIER 3 : reputation 48 ------------------------------
  {
    id: 't3-datahall',
    tier: 3,
    title: 'Data Hall UPS Cutover',
    client: 'Kestrel Colocation',
    brief:
      'Sixteen hours carrying a live floor while they re-terminate the ring main. Power quality clauses written by someone who understands them.',
    hours: 16,
    profile: { type: 'sine', mean: 78, amp: 7, periodMin: 45 },
    payPerKWh: 1.25,
    mobilization: 3200,
    freqTolHz: 0.45,
    voltTolPct: 3,
    penaltyPerOutageMin: 180,
    critical: true,
    requires: ['tier4'],
    repGain: 18,
    ambientC: 24,
  },
  {
    id: 't3-crusher',
    tier: 3,
    title: 'Primary Crusher Feed',
    client: 'Barrow Hill Quarry',
    brief:
      'A jaw crusher biting into rock, eighteen hours a day, in air you can taste. The step loads are savage and the dust gets into everything.',
    hours: 18,
    profile: { type: 'cycle', low: 30, high: 92, periodMin: 6, dutyPct: 60 },
    payPerKWh: 0.98,
    mobilization: 2400,
    freqTolHz: 1.3,
    voltTolPct: 6,
    penaltyPerOutageMin: 60,
    abrasion: 1.9,
    ambientC: 27,
    repGain: 17,
  },
  {
    id: 't3-market',
    tier: 3,
    title: 'City Centre Market',
    client: 'Alderwick BC',
    brief:
      'Flats on three sides and an air quality management area underneath you. Both the noise officer and the emissions inspector have your number.',
    hours: 13,
    profile: { type: 'diurnal', min: 30, max: 66 },
    payPerKWh: 1.45,
    mobilization: 2600,
    freqTolHz: 1.0,
    voltTolPct: 5,
    penaltyPerOutageMin: 70,
    requires: ['quiet', 'tier4'],
    repGain: 19,
    ambientC: 17,
  },
  {
    id: 't3-greenhouse',
    tier: 3,
    title: 'Glasshouse CHP Trial',
    client: 'Verdant Growers',
    brief:
      'They want the electricity, but they want the heat more. Twenty-four hours where the exhaust you have been throwing away becomes the product.',
    hours: 24,
    profile: { type: 'diurnal', min: 44, max: 70 },
    payPerKWh: 0.82,
    thermalPayPerKWh: 0.34,
    mobilization: 3000,
    freqTolHz: 1.2,
    voltTolPct: 6,
    penaltyPerOutageMin: 40,
    requires: ['chp'],
    repGain: 20,
    ambientC: 11,
  },
  {
    id: 't3-arctic',
    tier: 3,
    title: 'Survey Camp — Winter Station',
    client: 'Polar Logistics Group',
    brief:
      'Thirty-six hours at minus twenty-two. Starting is the hard part; after that the cold is the best radiator you will ever own.',
    hours: 36,
    profile: { type: 'steady', kw: 70 },
    payPerKWh: 1.3,
    mobilization: 4200,
    freqTolHz: 1.2,
    voltTolPct: 6,
    penaltyPerOutageMin: 90,
    critical: true,
    ambientC: -22,
    repGain: 21,
  },

  // ---------------- TIER 4 : reputation 72 ------------------------------
  {
    id: 't4-hospital',
    tier: 4,
    title: 'Regional Hospital — Mains Failure',
    client: 'St Ediths Trust',
    brief:
      'Not a drill. Thirty hours carrying theatres and critical care on a substation fault. Every second you are not there is a second somebody notices.',
    hours: 30,
    profile: { type: 'diurnal', min: 62, max: 96 },
    payPerKWh: 1.7,
    mobilization: 7000,
    freqTolHz: 0.5,
    voltTolPct: 3,
    penaltyPerOutageMin: 400,
    critical: true,
    requires: ['quiet', 'tier4'],
    repGain: 26,
    ambientC: 14,
  },
  {
    id: 't4-crane',
    tier: 4,
    title: 'Container Crane Support',
    client: 'Peldon Docks',
    brief:
      'Ship-to-shore cranes: enormous draws on the hoist and long idle troughs between boxes. A engine alone will spend the whole shift chasing it.',
    hours: 22,
    profile: { type: 'spike', base: 26, spike: 112, everyMin: 5, durSec: 95 },
    payPerKWh: 1.15,
    mobilization: 5200,
    freqTolHz: 0.9,
    voltTolPct: 5,
    penaltyPerOutageMin: 130,
    requires: ['hybrid'],
    repGain: 24,
    ambientC: 15,
  },
  {
    id: 't4-festival',
    tier: 4,
    title: 'Festival Main Stage',
    client: 'Ninebarrow Live',
    brief:
      'Headline weekend. You are one machine on a synchronised bus, and the front of house desk is unforgiving about frequency.',
    hours: 26,
    profile: { type: 'diurnal', min: 38, max: 104 },
    payPerKWh: 1.5,
    mobilization: 6400,
    freqTolHz: 0.6,
    voltTolPct: 4,
    penaltyPerOutageMin: 220,
    requires: ['parallel', 'quiet'],
    repGain: 25,
    ambientC: 20,
  },
  {
    id: 't4-depot',
    tier: 4,
    title: 'Municipal Depot HVO Pilot',
    client: 'Alderwick BC',
    brief:
      'Forty-eight hours proving renewable diesel in service. They are paying a premium for the fuel story, and auditing that you actually ran on it.',
    hours: 48,
    profile: { type: 'diurnal', min: 48, max: 84 },
    payPerKWh: 1.55,
    mobilization: 5800,
    freqTolHz: 1.0,
    voltTolPct: 5,
    penaltyPerOutageMin: 100,
    requires: ['hvo'],
    repGain: 23,
    ambientC: 13,
  },

  // ---------------- TIER 5 : reputation 92 ------------------------------
  {
    id: 't5-microgrid',
    tier: 5,
    title: 'Island Microgrid — Seasonal Contract',
    client: 'Skerry Sound Trust',
    brief:
      'Seventy-two hours as the only generation for four hundred people, selling heat to the harbour buildings at the same time. The whole tree, working at once.',
    hours: 72,
    profile: { type: 'diurnal', min: 52, max: 118 },
    payPerKWh: 1.62,
    thermalPayPerKWh: 0.4,
    mobilization: 16000,
    freqTolHz: 0.5,
    voltTolPct: 3,
    penaltyPerOutageMin: 300,
    critical: true,
    requires: ['parallel', 'chp', 'tier4'],
    repGain: 32,
    ambientC: 9,
  },
  {
    id: 't5-flood',
    tier: 5,
    title: 'Flood Response — Pumping Station',
    client: 'Regional Resilience Forum',
    brief:
      'Ninety-six hours flat out on emergency pumps, in the rain, with silt in the air. Nobody is going to relieve you and the water is not going to wait.',
    hours: 96,
    profile: { type: 'cycle', low: 84, high: 116, periodMin: 22, dutyPct: 70 },
    payPerKWh: 1.48,
    mobilization: 14000,
    freqTolHz: 0.9,
    voltTolPct: 5,
    penaltyPerOutageMin: 260,
    critical: true,
    abrasion: 1.6,
    ambientC: 8,
    repGain: 30,
  },
];

export const TIER_REP = { 1: 0, 2: 22, 3: 48, 4: 72, 5: 92 };

/** Filler work, so a bad run is recoverable without softlocking the career. */
export function fillerContract(seed, rep, kindIndex = null) {
  const r = mulberry(seed);
  const kinds = [
    ['Site Compound Supply', 'Trellick Construction', 'steady'],
    ['Grain Dryer Season', 'Wend Valley Agri', 'sine'],
    ['Workshop Standby Cover', 'Marlow Engineering', 'cycle'],
    ['Event Marquee Hire', 'Copperfield Events', 'diurnal'],
  ];
  // The caller picks the kind directly when listing several at once, so two
  // fillers on the board are never the same job with different numbers.
  const idx = kindIndex === null
    ? Math.floor(r() * kinds.length)
    : ((kindIndex % kinds.length) + kinds.length) % kinds.length;
  const [title, client, shape] = kinds[idx];
  const scale = 0.6 + Math.min(rep, 90) / 120;
  const base = Math.round((26 + r() * 22) * scale);
  const hours = Math.round(6 + r() * 10);
  const profile =
    shape === 'steady'
      ? { type: 'steady', kw: base }
      : shape === 'sine'
        ? { type: 'sine', mean: base, amp: Math.round(base * 0.25), periodMin: 40 }
        : shape === 'cycle'
          ? { type: 'cycle', low: Math.round(base * 0.4), high: Math.round(base * 1.3), periodMin: 8, dutyPct: 50 }
          : { type: 'diurnal', min: Math.round(base * 0.6), max: Math.round(base * 1.25) };
  return {
    id: `filler-${seed}`,
    tier: 1,
    filler: true,
    title,
    client,
    brief: 'Routine hire work. It pays for fuel and keeps the lights on between the jobs that matter.',
    hours,
    profile,
    payPerKWh: 0.7 + r() * 0.12,
    mobilization: Math.round(180 + r() * 340),
    freqTolHz: 2.2,
    voltTolPct: 9,
    penaltyPerOutageMin: 8,
    repGain: 2,
    ambientC: Math.round(8 + r() * 20),
  };
}

/** Small deterministic PRNG so a save reloads to the same contract board. */
export function mulberry(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Which listed contracts the player is allowed to see and take. */
/**
 * A client you did well by calls again. Completed contracts stay on the board
 * as repeat business at full rate but sharply reduced reputation, so the work
 * you have unlocked remains your income base instead of evaporating and
 * leaving only filler jobs to grind.
 */
export function availableContracts(rep, completedIds, boardSeed) {
  const done = new Set(completedIds);
  const listed = CONTRACTS.filter((c) => rep >= TIER_REP[c.tier]).map((c) =>
    done.has(c.id)
      ? { ...c, repeat: true, repGain: Math.max(1, Math.round(c.repGain * 0.2)) }
      : c,
  );
  const fillers = [0, 1].map((i) =>
    fillerContract(boardSeed * 31 + i, rep, boardSeed + i));
  return [...listed, ...fillers];
}

export function missingCaps(contract, spec) {
  return (contract.requires ?? []).filter((c) => !spec.capabilities.includes(c));
}

/** Fresh scorecard for a job in progress. */
export function newProgress(contract) {
  return {
    contractId: contract.id,
    elapsedH: 0,
    energyKWh: 0,
    demandedKWh: 0,
    thermalKWh: 0,
    outageSec: 0,
    freqViolSec: 0,
    voltViolSec: 0,
    smokeSec: 0,
    fuelUsedL: 0,
    tripCount: 0,
    worstHz: 60,
    peakCoolantC: 0,
  };
}

/**
 * Accumulate one tick of a running job. Kept separate from the sim so the
 * scoring rules can change without touching the physics.
 */
export function accrue(prog, contract, m, demand, dt) {
  const h = dt / 3600;
  prog.elapsedH += h;
  prog.demandedKWh += demand * h;
  prog.energyKWh += m.deliveredKW * h;
  prog.thermalKWh += (m.thermalKW ?? 0) * h;
  prog.fuelUsedL += (m.fuelLPerH ?? 0) * h;
  prog.peakCoolantC = Math.max(prog.peakCoolantC, m.coolantC);

  const shortfall = demand - m.deliveredKW;
  if (demand > 0.5 && shortfall > Math.max(0.5, demand * 0.02)) {
    prog.outageSec += dt;
  }
  if (m.breakerClosed) {
    const err = Math.abs((m.hz ?? 0) - 60);
    if (err > contract.freqTolHz) prog.freqViolSec += dt;
    if (Math.abs((m.hz ?? 60) - 60) > Math.abs(prog.worstHz - 60)) {
      prog.worstHz = m.hz;
    }
    const vErr = Math.abs((m.volts ?? 480) - 480) / 480 * 100;
    if (vErr > contract.voltTolPct) prog.voltViolSec += dt;
  }
  if ((m.smoke ?? 0) > 0.08) prog.smokeSec += dt;
}

/**
 * Final settlement. Returns a breakdown the UI can itemise, because a number
 * with no explanation teaches the player nothing.
 */
export function settle(prog, contract) {
  const lines = [];
  const energyPay = prog.energyKWh * contract.payPerKWh;
  lines.push({ label: `Energy delivered (${prog.energyKWh.toFixed(0)} kWh)`, amount: energyPay });
  lines.push({ label: 'Mobilisation fee', amount: contract.mobilization });

  let thermalPay = 0;
  if (contract.thermalPayPerKWh && prog.thermalKWh > 0) {
    thermalPay = prog.thermalKWh * contract.thermalPayPerKWh;
    lines.push({
      label: `Heat sold (${prog.thermalKWh.toFixed(0)} kWh-th)`,
      amount: thermalPay,
    });
  }

  const outageMin = prog.outageSec / 60;
  const outagePenalty = -outageMin * contract.penaltyPerOutageMin;
  if (outagePenalty < -0.5) {
    lines.push({
      label: `Supply shortfall (${outageMin.toFixed(1)} min)`,
      amount: outagePenalty,
    });
  }

  // Power quality is charged by the minute out of band, scaled by how tight
  // the clause was -- a data hall clause hurts far more than a barn.
  const qualityRate = 22 / Math.max(contract.freqTolHz, 0.3);
  const freqPenalty = -(prog.freqViolSec / 60) * qualityRate;
  if (freqPenalty < -0.5) {
    lines.push({
      label: `Frequency out of band (${(prog.freqViolSec / 60).toFixed(1)} min)`,
      amount: freqPenalty,
    });
  }
  const voltPenalty = -(prog.voltViolSec / 60) * qualityRate * 0.6;
  if (voltPenalty < -0.5) {
    lines.push({
      label: `Voltage out of band (${(prog.voltViolSec / 60).toFixed(1)} min)`,
      amount: voltPenalty,
    });
  }

  const smokePenalty = -(prog.smokeSec / 60) * 6;
  if (smokePenalty < -0.5) {
    lines.push({
      label: `Visible emissions (${(prog.smokeSec / 60).toFixed(1)} min)`,
      amount: smokePenalty,
    });
  }

  // Liability cap. Hire contracts carry liquidated-damages ceilings, and
  // without one a single bad night can generate a loss orders of magnitude
  // larger than the job was ever worth -- which is not a difficulty curve,
  // it's a dead save.
  const cap = estimateValue(contract);
  const penaltyTotal = lines.reduce((s, l) => (l.amount < 0 ? s + l.amount : s), 0);
  if (-penaltyTotal > cap) {
    const scale = cap / -penaltyTotal;
    for (const l of lines) if (l.amount < 0) l.amount *= scale;
    lines.push({
      label: 'Liability capped per contract terms',
      amount: 0,
      note: true,
    });
  }

  const completion = Math.min(1, prog.elapsedH / contract.hours);
  const supplyRatio =
    prog.demandedKWh > 0 ? prog.energyKWh / prog.demandedKWh : 1;

  // A clean run is worth real money -- this is where a well-built machine
  // separates itself from one that merely survived.
  let bonus = 0;
  const clean =
    completion >= 0.999 &&
    prog.outageSec < 30 &&
    prog.freqViolSec < 60 &&
    prog.voltViolSec < 60;
  if (clean) {
    bonus = contract.mobilization * 0.35 + energyPay * 0.1;
    lines.push({ label: 'Clean-run bonus', amount: bonus });
  }

  // Walking away means handing the mobilisation advance back.
  let abandoned = false;
  if (completion < 0.999) {
    abandoned = true;
    lines.push({
      label: 'Contract not completed — mobilisation withheld',
      amount: -contract.mobilization,
    });
  }

  const total = lines.reduce((s, l) => s + l.amount, 0);

  const failed = abandoned || supplyRatio < 0.9;
  const repDelta = failed
    ? -Math.round(6 + contract.tier * 3)
    : Math.round(contract.repGain * (clean ? 1 : 0.6));

  return {
    lines,
    total,
    clean,
    failed,
    abandoned,
    repDelta,
    completion,
    supplyRatio,
  };
}

/** Rough guide shown on the card before you commit. */
export function estimateValue(contract) {
  const mean = meanDemand(contract.profile, contract.hours);
  return contract.mobilization + mean * contract.hours * contract.payPerKWh;
}

export { RATED_KW };
