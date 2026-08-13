/**
 * Career state and the master tick.
 *
 * This is the only module that knows about both the physics and the money.
 * `advance()` is the single entry point the UI drives.
 */

import {
  baseSpec,
  newMachine,
  defaultEnv,
  step,
  closeBreaker as simCloseBreaker,
  forceCloseBreaker,
  syncCheck,
  speedSetpoint,
  throttleForSpeed,
  governorDroop,
  DROOP_MAX,
  resetRelays as simResetRelays,
  latchedRelays,
  anyRelayLatched,
  clamp,
  RATED_KW,
} from './sim.js';
import { buildSpec, TECH_BY_ID, canResearch } from './tech.js';
import {
  CONTRACTS,
  availableContracts,
  demandAt,
  newProgress,
  accrue,
  settle,
  missingCaps,
  fillerContract,
} from './contracts.js';

export const SPEEDS = [0, 1, 5, 30, 120, 600];

export const BASE_FUEL_PRICE = { diesel: 1.28, hvo: 1.66 };

export function createGame() {
  const g = {
    version: 2,
    money: 2400,
    reputation: 0,
    day: 1,
    owned: [],
    tankBonusL: 0,
    boardSeed: 1,
    completed: [],
    failedJobs: 0,
    cleanRuns: 0,
    lifetimeEarned: 0,
    lifetimeFuelL: 0,
    lifetimeEnergyKWh: 0,
    fuelPriceMult: 1,
    speed: 1,
    job: null,
    log: [],
    machine: null,
    spec: null,
  };
  g.spec = specFor(g);
  g.machine = newMachine(g.spec);
  rollFuelPrice(g);
  logLine(g, `Yard opened. One 75 kW set, ${fmtMoney(g.money)} in the bank.`, 'info');
  return g;
}

function fmtMoney(v) {
  return `£${Math.round(v).toLocaleString('en-GB')}`;
}

/** Spec including anything bought outside the tech tree. */
export function specFor(g) {
  const spec = buildSpec(g.owned, baseSpec);
  spec.tankL += g.tankBonusL;
  return spec;
}

export function fuelPrice(g) {
  const spec = g.spec ?? specFor(g);
  return BASE_FUEL_PRICE[spec.fuel] * g.fuelPriceMult;
}

export function rollFuelPrice(g) {
  const r = Math.sin(g.day * 12.9898) * 43758.5453;
  const noise = r - Math.floor(r);
  g.fuelPriceMult = 0.86 + noise * 0.34;
}

export function logLine(g, text, kind = 'info') {
  g.log.unshift({ text, kind, day: g.day, t: Date.now() });
  if (g.log.length > 120) g.log.length = 120;
}

/** Rebuild the spec after buying tech, preserving live machine state. */
export function refreshSpec(g) {
  const prev = g.spec;
  g.spec = specFor(g);
  // Fuel already in the tank stays there, but the tank may have grown.
  g.machine.fuelL = Math.min(g.machine.fuelL, g.spec.tankL);
  if (prev && prev.fuel !== g.spec.fuel) {
    logLine(g, `Fuel system converted to ${g.spec.fuel.toUpperCase()}. Tank drained and purged.`, 'info');
    g.machine.fuelL = 0;
  }
}

// ---------------------------------------------------------------- shop ----

export function buyTech(g, id) {
  const node = TECH_BY_ID[id];
  if (!node) return { ok: false, msg: 'No such upgrade.' };
  const check = canResearch(node, g.owned, g.money);
  if (!check.ok) {
    const msg =
      check.reason === 'money'
        ? `Not enough money — ${node.name} costs ${fmtMoney(node.cost)}.`
        : check.reason === 'requires'
          ? `${node.name} needs ${check.missing.map((r) => TECH_BY_ID[r].name).join(', ')} first.`
          : check.reason === 'locked'
            ? `${node.name} is locked out by a choice you already made.`
            : 'Already fitted.';
    return { ok: false, msg };
  }
  if (g.job) return { ok: false, msg: 'Cannot fit upgrades with a job in progress.' };
  g.money -= node.cost;
  g.owned.push(id);
  refreshSpec(g);
  g.day += 1;
  rollFuelPrice(g);
  logLine(g, `Fitted ${node.name} for ${fmtMoney(node.cost)}.`, 'good');
  return { ok: true };
}

export function refuel(g, litres = Infinity) {
  const cap = g.spec.tankL;
  const want = Math.min(litres, cap - g.machine.fuelL);
  if (want <= 0.01) return { ok: false, msg: 'Tank is already full.' };
  // On-site delivery during a job costs a premium.
  const premium = g.job ? 1.18 : 1;
  const unit = fuelPrice(g) * premium;
  const affordable = Math.min(want, g.money / unit);
  if (affordable <= 0.01) return { ok: false, msg: 'Not enough money for fuel.' };
  const cost = affordable * unit;
  g.money -= cost;
  g.machine.fuelL += affordable;
  g.lifetimeFuelL += affordable;
  logLine(
    g,
    `Took on ${affordable.toFixed(0)} L at £${unit.toFixed(2)}/L — ${fmtMoney(cost)}.`,
    'info',
  );
  return { ok: true };
}

export const TANK_UPGRADE = {
  name: 'Bunded 600 L Belly Tank',
  cost: 2400,
  addL: 300,
  desc: 'Triples your endurance between fills. Long jobs stop being a refuelling exercise.',
};

export function buyTank(g) {
  if (g.tankBonusL > 0) return { ok: false, msg: 'Already fitted.' };
  if (g.money < TANK_UPGRADE.cost) return { ok: false, msg: 'Not enough money.' };
  g.money -= TANK_UPGRADE.cost;
  g.tankBonusL += TANK_UPGRADE.addL;
  refreshSpec(g);
  logLine(g, `Fitted ${TANK_UPGRADE.name}. Capacity now ${g.spec.tankL} L.`, 'good');
  return { ok: true };
}

// ------------------------------------------------------------ contracts ----

export function board(g) {
  // Filler work turns over with the calendar as well as on demand, so the
  // board looks different after every job.
  return availableContracts(g.reputation, g.completed, g.day * 13 + g.boardSeed * 7);
}

export function refreshBoard(g) {
  if (g.job) return { ok: false, msg: 'Not while a job is running.' };
  g.boardSeed += 1;
  g.day += 1;
  rollFuelPrice(g);
  logLine(g, 'Rang round for new work.', 'info');
  return { ok: true };
}

export function acceptContract(g, id) {
  if (g.job) return { ok: false, msg: 'You already have a job on.' };
  const c = board(g).find((x) => x.id === id);
  if (!c) return { ok: false, msg: 'That contract is no longer available.' };
  const missing = missingCaps(c, g.spec);
  if (missing.length) return { ok: false, msg: 'Your set does not meet the requirements.' };
  // Mobilisation is advanced on acceptance, the way hire work actually pays.
  // It also guarantees you can always afford fuel for the job you just took,
  // so a thin bank balance can never softlock the career.
  g.money += c.mobilization;
  g.job = {
    contract: c,
    progress: newProgress(c),
    done: false,
    result: null,
    advance: c.mobilization,
  };
  logLine(
    g,
    `Accepted "${c.title}" for ${c.client}. Mobilisation advance ${fmtMoney(c.mobilization)} received.`,
    'good',
  );
  return { ok: true };
}

export function abandonJob(g) {
  if (!g.job) return { ok: false, msg: 'No job running.' };
  return finishJob(g, true);
}

function finishJob(g, abandoned) {
  const { contract, progress } = g.job;
  const result = settle(progress, contract);
  // The mobilisation advance is already in the bank, so settle up net of it.
  const advance = g.job.advance ?? 0;
  const net = result.total - advance;
  result.net = net;
  result.advance = advance;
  g.money += net;
  if (g.money < 0) {
    logLine(g, `Overdrawn ${fmtMoney(-g.money)}. The bank has covered it, this once.`, 'bad');
    g.money = 0;
  }
  g.lifetimeEarned += Math.max(0, result.total);
  g.lifetimeEnergyKWh += progress.energyKWh;
  g.reputation = Math.max(0, Math.min(100, g.reputation + result.repDelta));
  if (!contract.filler && !result.failed) g.completed.push(contract.id);
  if (result.failed) g.failedJobs += 1;
  if (result.clean) g.cleanRuns += 1;
  g.day += Math.max(1, Math.ceil(contract.hours / 24));
  rollFuelPrice(g);

  logLine(
    g,
    `${abandoned ? 'Abandoned' : 'Finished'} "${contract.title}": settled ${
      net >= 0 ? '+' : '-'
    }${fmtMoney(Math.abs(net))}, reputation ${result.repDelta >= 0 ? '+' : ''}${result.repDelta}.`,
    result.failed ? 'bad' : result.clean ? 'good' : 'info',
  );

  g.job = { contract, progress, done: true, result, abandoned };
  g.speed = 0;
  return { ok: true, result };
}

export function clearFinishedJob(g) {
  if (g.job?.done) g.job = null;
}

// ------------------------------------------------------------ controls ----

export function startEngine(g) {
  const m = g.machine;
  if (m.running) return { ok: false, msg: 'Already running.' };
  if (m.fuelL <= 0) return { ok: false, msg: 'No fuel.' };
  if (anyRelayLatched(m)) {
    return { ok: false, msg: 'Relay target standing — reset the board first.' };
  }
  m.cranking = 6;
  return { ok: true };
}

export function stopEngine(g) {
  const m = g.machine;
  m.running = false;
  m.breakerClosed = false;
  m.synced = false;
  m.cranking = 0;
  return { ok: true };
}

/** Walk the board and drop every standing relay target. */
export function resetRelays(g) {
  const standing = latchedRelays(g.machine);
  if (!standing.length) return { ok: false, msg: 'No targets standing.' };
  simResetRelays(g.machine);
  logLine(g, `Relay board reset (${standing.map(relayLabel).join(', ')}).`, 'info');
  return { ok: true };
}

export const RELAY_LABELS = {
  underFreq: 'Under Frequency',
  overFreq: 'Over Frequency',
  underVolt: 'Under Volts',
  overVolt: 'Over Volts',
  overCurrent: 'Over Current',
  reversePower: 'Reverse Power',
  lowOilPressure: 'Low Oil Pressure',
  overspeed: 'Overspeed',
};
export const relayLabel = (k) => RELAY_LABELS[k] ?? k;

/** Environment for the job in progress (or the yard, when idle). */
export function envFor(g) {
  const env = defaultEnv();
  const c = g.job && !g.job.done ? g.job.contract : null;
  if (c) {
    env.ambientC = c.ambientC ?? 20;
    env.altitudeM = c.altitudeM ?? 0;
    env.abrasion = c.abrasion ?? 1;
    env.bus = c.bus ?? null;
  }
  return env;
}

// ---- operator controls ----------------------------------------------------

export function setThrottle(g, v) {
  g.machine.throttle = clamp(v, 0, 1);
  return { ok: true };
}

/** Nudge the throttle, the way a raise/lower switch works. */
export function bumpThrottle(g, delta) {
  return setThrottle(g, g.machine.throttle + delta);
}

export function setGovMode(g, mode) {
  const m = g.machine;
  if (m.govMode === mode) return { ok: true };

  // Bumpless transfer. Whatever mode you select, it takes over holding the
  // rack exactly where it already is -- otherwise selecting droop while
  // carrying load throws the rack shut and, on a bus, slips a pole.
  const rack = clamp(m.fuelCmd, 0, 1);
  const droop = governorDroop(m, g.spec);
  if (m.running) {
    if (mode === 'manual') {
      m.throttle = rack;
    } else {
      const setRpm = (rack * droop * 1800 + m.rpm) / (1 + droop);
      m.throttle = throttleForSpeed(setRpm);
    }
  }
  m.govMode = mode;
  return { ok: true };
}

/**
 * Droop setting on the governor. Tight droop holds frequency hard on an island;
 * wide droop is what lets a machine share load on a bus without the rack
 * slamming between its stops.
 */
export function setDroop(g, v) {
  g.machine.droopSet = clamp(v, g.spec.droopMin, DROOP_MAX);
  return { ok: true };
}

export function bumpDroop(g, delta) {
  return setDroop(g, (g.machine.droopSet ?? g.spec.droop) + delta);
}

export function setExcitation(g, v) {
  g.machine.excCmd = clamp(v, 0, g.spec.excMax);
  return { ok: true };
}

export function bumpExcitation(g, delta) {
  return setExcitation(g, g.machine.excCmd + delta);
}

export function setFieldBreaker(g, closed) {
  const m = g.machine;
  if (!closed && m.breakerClosed) {
    return { ok: false, msg: 'Open the main breaker before killing the field.' };
  }
  m.fieldClosed = closed;
  logLine(g, closed ? 'Field breaker closed — excitation live.' : 'Field breaker opened.', 'info');
  return { ok: true };
}

/**
 * Main breaker. On a dead bus this is a health check; onto a live bus it is a
 * synchronising operation and the synchroscope has to be right.
 */
export function setBreaker(g, closed, { force = false } = {}) {
  const m = g.machine;
  const env = envFor(g);

  if (!closed) {
    m.breakerClosed = false;
    m.synced = false;
    return { ok: true };
  }

  if (!m.running && m.cranking <= 0) {
    return { ok: false, msg: 'Start the engine first.' };
  }

  const res = force
    ? forceCloseBreaker(m, g.spec, env)
    : simCloseBreaker(m, g.spec, env);

  if (res.shock) {
    logLine(
      g,
      'Closed out of step. The surge threw the overcurrent relay straight out.',
      'bad',
    );
    return { ok: true, msg: 'Out-of-phase close!' };
  }
  if (res.ok) {
    if (env.bus) logLine(g, 'Synchronised and on the bus.', 'good');
    return { ok: true };
  }
  return { ok: false, msg: res.msg };
}

/** What the synchroscope and the close button need to know. */
export function syncState(g) {
  return syncCheck(g.machine, envFor(g));
}

export function targetSpeed(g) {
  return speedSetpoint(g.machine.throttle);
}

// ----------------------------------------------------------- main tick ----

const EVENT_TEXT = {
  started: ['Engine started.', 'good'],
  stalled: ['Engine stalled under load.', 'bad'],
  'out-of-fuel': ['Ran the tank dry. Engine stopped.', 'bad'],
  'no-fuel-start': ['Cranked on an empty tank.', 'bad'],
  overheat: ['Coolant over 118 °C — the set is derating hard.', 'bad'],
  overspeed: ['OVERSPEED TRIP — fuel cut. Watch the rack when you drop load.', 'bad'],
  'pole-slip': ['Pole slip — lost synchronism with the bus and thrown off line.', 'bad'],
  'oil-shutdown': ['LOW OIL PRESSURE — engine shut down to save it.', 'bad'],
  seized: ['Catastrophic failure. The engine has seized.', 'bad'],
  trip: ['Breaker tripped on under-frequency.', 'bad'],

};

/**
 * Advance the whole game by `simSeconds` of simulated time.
 *
 * Substep size is adaptive: fine enough for the governor loop to stay stable,
 * coarse enough that 600x fast-forward does not melt the browser.
 */
export function advance(g, simSeconds) {
  if (simSeconds <= 0) return;
  if (g.job?.done) return;

  const spec = g.spec;
  const m = g.machine;
  const job = g.job;
  const contract = job?.contract;

  const env = envFor(g);

  const maxSubsteps = 4200;
  const dt = Math.min(0.02, Math.max(0.005, simSeconds / maxSubsteps));
  let remaining = simSeconds;
  const seen = new Set();

  while (remaining > 1e-9) {
    const h = Math.min(dt, remaining);

    let demand = 0;
    if (contract && !job.done) {
      const tH = job.progress.elapsedH;
      demand = demandAt(contract.profile, tH);
    }
    env.demandKW = demand;

    const events = step(m, spec, env, h);
    for (const e of events) {
      if (e.type === 'relay-trip') {
        const key = `relay:${e.relays.join(',')}`;
        if (!seen.has(key)) {
          seen.add(key);
          logLine(g, `TRIP — ${e.relays.map(relayLabel).join(' + ')}. Target standing.`, 'bad');
        }
        if (job && !job.done) job.progress.tripCount += 1;
        continue;
      }
      if (!seen.has(e.type)) {
        seen.add(e.type);
        const t = EVENT_TEXT[e.type];
        if (t) logLine(g, t[0], t[1]);
      }
      if (e.type === 'trip' && job && !job.done) job.progress.tripCount += 1;
    }

    if (contract && !job.done) {
      accrue(job.progress, contract, m, demand, h);
      if (job.progress.elapsedH >= contract.hours) {
        finishJob(g, false);
        return;
      }
    }

    remaining -= h;
  }
}

/** Everything the header and gauges need, computed once per frame. */
export function snapshot(g) {
  const m = g.machine;
  const spec = g.spec;
  const job = g.job;
  const demand =
    job && !job.done ? demandAt(job.contract.profile, job.progress.elapsedH) : 0;
  return {
    demand,
    hz: m.hz ?? 0,
    volts: m.volts ?? 0,
    deliveredKW: m.deliveredKW ?? 0,
    shedKW: m.shedKW ?? 0,
    loadPct: ((m.deliveredKW ?? 0) / spec.altRatingKW) * 100,
    ratedPct: ((m.deliveredKW ?? 0) / RATED_KW) * 100,
    fuelPct: (m.fuelL / spec.tankL) * 100,
    hoursLeft: m.fuelLPerH > 0.2 ? m.fuelL / m.fuelLPerH : Infinity,
  };
}
