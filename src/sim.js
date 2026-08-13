/**
 * Genset physics core.
 *
 * Everything in here is pure: `step()` takes a machine state, a spec (the
 * aggregated result of your tech tree), an environment, and a timestep, and
 * mutates the machine state. No DOM, no globals, no randomness except what is
 * handed in. That keeps it testable and keeps the UI honest -- the gauges show
 * what the model actually computed, not a scripted animation.
 *
 * The model is a single-shaft diesel genset:
 *
 *   fuel rack -> combustion (air limited) -> indicated torque
 *      -> minus friction -> minus alternator load torque -> shaft acceleration
 *
 * Shaft speed sets frequency directly (4-pole, 1800 rpm = 60 Hz), so every
 * transient you can feel in the torque balance shows up as a frequency dip the
 * contract's power-quality clause will notice.
 */

export const NOMINAL_RPM = 1800;
export const POLES = 4;

/** Lower heating value of diesel, J/kg. */
export const LHV_DIESEL = 42.7e6;
/** Diesel density, kg/L, at 15 C. */
export const DIESEL_DENSITY = 0.832;

/** HVO / renewable diesel: slightly more energy per kg, less per litre. */
export const LHV_HVO = 44.0e6;
export const HVO_DENSITY = 0.78;

export const RATED_KW = 75;

export function rpmToHz(rpm) {
  return (rpm * POLES) / 120;
}

export function hzToRpm(hz) {
  return (hz * 120) / POLES;
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Base machine, before any tech is fitted. A stock mechanical-injection,
 * naturally aspirated 6.0 L industrial six with a flyweight governor.
 */
export function baseSpec() {
  return {
    // --- fuelling -------------------------------------------------------
    /** Full-rack fuel flow at nominal rpm, kg/s. Sized so a stock unit makes
     *  ~82 kWe at full rack: a 75 kW prime rating with standby headroom. */
    mdotFullScale: 5.56e-3,
    /** Multiplier on full-rack fuel. Turbos come with a bigger pump. */
    fuelScale: 1.0,
    /** Indicated (in-cylinder) thermal efficiency. */
    indicatedEff: 0.4,

    // --- air ------------------------------------------------------------
    /** Extra air fraction at full boost. 0 = naturally aspirated. */
    boostGain: 0.0,
    /** Boost build time constant, seconds. This is turbo lag. */
    boostTau: 1.6,
    /** Charge density bonus from intercooling, as a fraction of air mass. */
    chargeDensityBonus: 0.0,
    /** Exhaust restriction from aftertreatment; scales pumping losses. */
    backPressure: 0.0,

    // --- mechanical -----------------------------------------------------
    /** Friction torque = frictionA + frictionB * rpm, N*m. */
    frictionA: 12,
    frictionB: 0.0135,
    /** Rotating inertia of crank + flywheel + alternator rotor, kg*m^2. */
    inertia: 5.5,
    /** Divides wear accumulation. Higher = tougher engine. */
    durability: 1.0,
    /** Peak indicated torque the bottom end will survive, N*m. */
    torqueLimit: 720,

    // --- thermal --------------------------------------------------------
    /** Fraction of fuel energy rejected to coolant. */
    coolantHeatFrac: 0.3,
    /** Radiator conductance, W/K, at full fan. */
    radiatorUA: 950,
    /** Coolant + block thermal capacity, J/K. */
    thermalMass: 347000,
    /** Fan parasitic draw at full speed, kW. */
    fanPowerKW: 1.6,
    /** Variable-speed fan modulates to hold target temp instead of running flat out. */
    fanVariable: false,
    /** Oil cooler reduces the wear penalty from sustained high load. */
    oilCooled: false,

    // --- electrical -----------------------------------------------------
    /** Alternator efficiency at rated load. */
    altEff: 0.93,
    /** What the electrical end can actually pass, kW. The engine can be made to
     *  produce far more shaft power than the stock windings will carry, so this
     *  is the real ceiling on what you can sell. */
    altRatingKW: 92,
    /** Terminal voltage sag at full load, as a fraction. */
    voltSag: 0.06,
    /** Governor droop: fractional speed drop from no load to full load. */
    droop: 0.03,
    /** Isochronous governors hold speed exactly, using integral action. */
    isochronous: false,
    /** Feed-forward gain on load rate-of-change; cancels turbo lag dips. */
    loadAnticipation: 0,
    /** Battery buffer, kWh and kW. */
    batteryKWh: 0,
    batteryKW: 0,

    // --- output / compliance -------------------------------------------
    /** Fraction of waste heat recoverable and saleable. */
    chpFrac: 0,
    /** Sound pressure at 7 m, dB(A). */
    noiseDb: 92,
    /** Emissions stage the set is certified to. */
    emissionsTier: 2,
    /** Tags the contract board checks against. */
    capabilities: [],

    fuel: 'diesel',

    // --- consumables ----------------------------------------------------
    tankL: 300,
    /** Base wear in %/hour at the reference duty point. Tuned so a stock,
     *  well-serviced engine reaches overhaul at roughly 500-900 running hours
     *  depending on how hard you lean on it. */
    wearBase: 0.15,
  };
}

/** A fresh, zero-hours machine sitting cold in the yard. */
export function newMachine(spec = baseSpec()) {
  return {
    running: false,
    cranking: 0,
    rpm: 0,
    boost: 0,
    coolantC: 15,
    fuelL: spec.tankL,
    wear: 0,
    hours: 0,
    hoursSinceService: 0,
    dpfLoad: 0,
    govInteg: 0,
    batterySoc: 1,
    breakerClosed: false,
    /** Operator has asked for the breaker to close as soon as it is legal to. */
    pendingClose: false,
    /** Seconds the set has been outside its protection band. */
    protTimer: 0,
    /** Seconds until the breaker will attempt to reclose. */
    recloseTimer: 0,
    fanCmd: 1,
    // --- last-step telemetry (read-only for the UI) ---------------------
    fuelCmd: 0,
    smoke: 0,
    deliveredKW: 0,
    shedKW: 0,
    thermalKW: 0,
    fuelLPerH: 0,
    indicatedKW: 0,
    batteryFlowKW: 0,
    hz: 0,
    volts: 0,
    loadPct: 0,
  };
}

export function defaultEnv() {
  return {
    ambientC: 20,
    altitudeM: 0,
    /** Multiplier on wear from site conditions (dust, salt). */
    abrasion: 1,
    demandKW: 0,
    /** Rate of change of demand, kW/s -- drives load anticipation. */
    demandRateKW: 0,
  };
}

/** Air density ratio vs sea level, standard atmosphere. */
export function densityRatio(altitudeM, ambientC) {
  const p = Math.pow(1 - 2.25577e-5 * altitudeM, 5.25588);
  const t = (15 + 273.15) / (ambientC + 273.15);
  return p * t;
}

function fuelProps(spec) {
  return spec.fuel === 'hvo'
    ? { lhv: LHV_HVO, density: HVO_DENSITY }
    : { lhv: LHV_DIESEL, density: DIESEL_DENSITY };
}

/** Thermal derate: the set pulls fuel back once coolant runs away. */
export function thermalDerate(coolantC) {
  if (coolantC <= 103) return 1;
  if (coolantC >= 118) return 0.55;
  return 1 - ((coolantC - 103) / 15) * 0.45;
}

const PROT_UNDER_HZ = 57;
const PROT_OVER_HZ = 63.5;
const PROT_DELAY_S = 1.5;
const RECLOSE_S = 8;
const NOMINAL_V = 480;

/**
 * Advance the machine by `dt` seconds.
 *
 * Returns an events array describing anything the career layer needs to react
 * to (breaker trips, overheats, fuel exhaustion) so the sim never has to know
 * what a contract is.
 */
export function step(m, spec, env, dt) {
  const events = [];
  const { lhv, density } = fuelProps(spec);
  const omega = Math.max((m.rpm * Math.PI) / 30, 1e-3);
  const rpmNorm = clamp(m.rpm / NOMINAL_RPM, 0, 1.25);
  const rho = densityRatio(env.altitudeM ?? 0, env.ambientC ?? 20);

  // ---- starter ---------------------------------------------------------
  // The starter is a torque source on the same shaft as everything else, so a
  // cold, thick-oiled engine genuinely cranks slower rather than being teleported
  // to idle.
  let starterTorque = 0;
  if (m.cranking > 0) {
    m.cranking = Math.max(0, m.cranking - dt);
    if (m.fuelL <= 0) {
      m.cranking = 0;
      events.push({ type: 'no-fuel-start' });
    } else {
      starterTorque = m.rpm < 650 ? 230 * (1 - m.rpm / 650) : 0;
    }
  }
  /** Speed at which the engine catches and runs under its own power. */
  const fireRpm = m.coolantC < -10 ? 520 : 380;

  // ---- governor --------------------------------------------------------
  let fuelCmd = 0;
  if (m.running) {
    const noLoadRpm = NOMINAL_RPM * (1 + (spec.isochronous ? 0 : spec.droop));
    if (spec.isochronous) {
      // PI on speed. govInteg is held directly in fuel units so the integral
      // can be anti-windup clamped to the physical rack range.
      const err = NOMINAL_RPM - m.rpm;
      m.govInteg = clamp(m.govInteg + 0.25 * err * dt, 0, 1);
      fuelCmd = clamp(0.055 * err + m.govInteg, 0, 1);
    } else {
      // Flyweight governor: fuel is a pure proportional function of the speed
      // shortfall, so the set genuinely runs fast when unloaded.
      fuelCmd = clamp(
        (noLoadRpm - m.rpm) / (spec.droop * NOMINAL_RPM),
        0,
        1,
      );
    }
    // Load anticipation feeds the rack ahead of a known load step so boost is
    // already building when the load actually lands.
    if (spec.loadAnticipation > 0) {
      fuelCmd = clamp(
        fuelCmd + (spec.loadAnticipation * (env.demandRateKW ?? 0)) / RATED_KW,
        0,
        1,
      );
    }
    fuelCmd *= thermalDerate(m.coolantC);
  } else if (m.cranking > 0) {
    fuelCmd = 0.35;
  }

  // ---- combustion ------------------------------------------------------
  // Absolute fuel, normalised so 1.0 is a stock full rack at nominal speed.
  const fuelAbs = fuelCmd * spec.fuelScale * clamp(rpmNorm, 0.15, 1.2);
  // Absolute air, likewise. Boost, intercooling and altitude all land here.
  const airAbs =
    (1 + spec.boostGain * m.boost) *
    (1 + spec.chargeDensityBonus) *
    rho *
    clamp(rpmNorm, 0.15, 1.2);

  // The smoke limiter caps the rack at the air actually available. This is the
  // mechanism behind turbo lag: the pump is willing, the air is not, and until
  // the turbo spools the engine simply cannot make the torque no matter what
  // the governor asks for. Mechanical pumps police this loosely and smoke;
  // boost-compensated ones hold a much tighter line.
  const limiterMargin = spec.boostGain > 0 ? 1.06 : 1.2;
  const fuelActual = Math.min(fuelAbs, airAbs * limiterMargin);

  let combEff = 1;
  let smoke = 0;
  if (fuelActual > airAbs && fuelActual > 1e-6) {
    const ratio = airAbs / fuelActual;
    combEff = 0.45 + 0.55 * ratio;
    smoke = clamp((fuelActual - airAbs) / Math.max(airAbs, 0.1), 0, 1);
  }

  const mdot = m.running || m.cranking > 0
    ? fuelActual * spec.mdotFullScale
    : 0;
  const indicatedW = mdot * lhv * spec.indicatedEff * combEff;
  let Ti = m.rpm > 20 ? indicatedW / omega : 0;
  Ti = Math.min(Ti, spec.torqueLimit);

  // ---- losses ----------------------------------------------------------
  const Tfric =
    (m.running || m.cranking > 0
      ? spec.frictionA + spec.frictionB * m.rpm
      : spec.frictionA * 0.5 + spec.frictionB * m.rpm) *
    (1 + spec.backPressure) *
    // Cold oil is thick.
    (m.coolantC < 40 ? 1 + (40 - m.coolantC) * 0.006 : 1);

  // ---- electrical load -------------------------------------------------
  const fanKW = spec.fanVariable
    ? spec.fanPowerKW * clamp(m.fanCmd, 0.15, 1)
    : spec.fanPowerKW * (m.running ? 1 : 0);

  let demand = Math.max(0, env.demandKW ?? 0);
  let batteryFlow = 0;
  if (spec.batteryKWh > 0 && m.running) {
    // The buffer shaves anything above the engine's comfortable continuous
    // output, and recharges when there is headroom.
    const comfortable = RATED_KW * 0.82;
    if (demand > comfortable && m.batterySoc > 0.05) {
      batteryFlow = Math.min(spec.batteryKW, demand - comfortable);
      const drawn = (batteryFlow * dt) / 3600;
      m.batterySoc = clamp(m.batterySoc - drawn / spec.batteryKWh, 0, 1);
    } else if (demand < comfortable * 0.8 && m.batterySoc < 0.98) {
      batteryFlow = -Math.min(spec.batteryKW * 0.5, comfortable * 0.8 - demand);
      const stored = (-batteryFlow * dt * 0.92) / 3600;
      m.batterySoc = clamp(m.batterySoc + stored / spec.batteryKWh, 0, 1);
    }
  }

  // The windings are a hard ceiling: anything the alternator cannot pass is
  // load the site does not get, no matter how much shaft power is available.
  const requestedKW = Math.max(0, demand - batteryFlow);
  const electricalKW = m.breakerClosed
    ? Math.min(requestedKW, spec.altRatingKW)
    : 0;
  const shaftLoadKW = electricalKW / spec.altEff + fanKW;
  const Tload = m.rpm > 20 ? (shaftLoadKW * 1000) / omega : 0;

  // ---- shaft -----------------------------------------------------------
  const Tnet = Ti + starterTorque - Tfric - Tload;
  let newOmega = omega + (Tnet / spec.inertia) * dt;
  if (newOmega < 0) newOmega = 0;
  m.rpm = (newOmega * 30) / Math.PI;

  if (!m.running && m.cranking > 0 && m.rpm > fireRpm) {
    m.running = true;
    m.cranking = 0;
    events.push({ type: 'started' });
  }

  if (m.running && m.rpm < 250) {
    m.running = false;
    m.breakerClosed = false;
    m.rpm = 0;
    events.push({ type: 'stalled' });
  }

  // ---- boost -----------------------------------------------------------
  if (spec.boostGain > 0) {
    // Exhaust energy rises steeply with fuelling, so a lightly loaded set makes
    // essentially no boost -- which is precisely why the first big load step of
    // the day hurts. A hot exhaust (ceramic coating) spools harder.
    const fuelFrac = clamp(fuelActual / Math.max(spec.fuelScale, 0.01), 0, 1.2);
    const target = clamp((Math.pow(fuelFrac * rpmNorm, 1.8) - 0.05) / 0.62, 0, 1);
    const tau = Math.max(spec.boostTau, 0.05);
    m.boost += ((target - m.boost) * dt) / tau;
    m.boost = clamp(m.boost, 0, 1);
  } else {
    m.boost = 0;
  }

  // ---- fuel tank -------------------------------------------------------
  const litresPerSec = mdot / density;
  m.fuelL = Math.max(0, m.fuelL - litresPerSec * dt);
  if (m.fuelL <= 0 && m.running) {
    m.running = false;
    m.breakerClosed = false;
    events.push({ type: 'out-of-fuel' });
  }

  // ---- thermal ---------------------------------------------------------
  const heatW = mdot * lhv * spec.coolantHeatFrac + Tfric * omega;
  if (spec.fanVariable) {
    // Simple proportional fan controller targeting 88 C.
    m.fanCmd = clamp(0.15 + (m.coolantC - 78) / 18, 0.15, 1);
  } else {
    m.fanCmd = 1;
  }
  const fanFactor = spec.fanVariable ? clamp(m.fanCmd, 0.15, 1) : 1;
  const rejectW =
    spec.radiatorUA * (0.35 + 0.65 * fanFactor) * (m.coolantC - (env.ambientC ?? 20));
  m.coolantC += ((heatW - rejectW) / spec.thermalMass) * dt;

  if (m.coolantC > 118 && m.running) {
    events.push({ type: 'overheat' });
  }

  // ---- wear ------------------------------------------------------------
  if (m.running) {
    const loadFactor = clamp(electricalKW / RATED_KW, 0, 1.4);
    const heatPenalty = m.coolantC > 100 ? 1 + (m.coolantC - 100) * 0.12 : 1;
    const smokePenalty = 1 + smoke * 1.8;
    const servicePenalty = m.hoursSinceService > 250 ? 1.6 : 1;
    const oilRelief = spec.oilCooled && loadFactor > 0.7 ? 0.7 : 1;
    const rate =
      (spec.wearBase *
        (0.4 + Math.pow(loadFactor, 1.6)) *
        heatPenalty *
        smokePenalty *
        servicePenalty *
        oilRelief *
        (env.abrasion ?? 1)) /
      spec.durability;
    m.wear = clamp(m.wear + (rate * dt) / 3600, 0, 100);
    m.hours += dt / 3600;
    m.hoursSinceService += dt / 3600;
    if (m.wear >= 100) {
      m.running = false;
      m.breakerClosed = false;
      events.push({ type: 'seized' });
    }
  }

  // ---- soot loading ----------------------------------------------------
  if (spec.capabilities.includes('dpf')) {
    m.dpfLoad = clamp(m.dpfLoad + smoke * dt * 0.004 - dt * 0.00015, 0, 1);
  }

  // ---- protection ------------------------------------------------------
  const hz = rpmToHz(m.rpm);
  const volts = m.running
    ? NOMINAL_V *
      (m.rpm / NOMINAL_RPM) *
      (1 - spec.voltSag * clamp(electricalKW / RATED_KW, 0, 1.3))
    : 0;

  if (m.breakerClosed) {
    const bad = hz < PROT_UNDER_HZ || hz > PROT_OVER_HZ || !m.running;
    m.protTimer = bad ? m.protTimer + dt : 0;
    if (m.protTimer > PROT_DELAY_S || !m.running) {
      m.breakerClosed = false;
      m.protTimer = 0;
      m.recloseTimer = RECLOSE_S;
      events.push({ type: 'trip', hz });
    }
  } else if (m.recloseTimer > 0) {
    m.recloseTimer = Math.max(0, m.recloseTimer - dt);
    if (m.recloseTimer === 0 && m.running && hz > 58.5 && hz < 62) {
      m.breakerClosed = true;
      events.push({ type: 'reclose' });
    }
  } else if (m.pendingClose && m.running && hz > 58.5 && hz < 62) {
    // The operator asked for load while the set was still coming up to speed;
    // a real controller waits for the machine to be healthy, then closes.
    m.breakerClosed = true;
    m.pendingClose = false;
    events.push({ type: 'closed-on-load' });
  }

  // ---- telemetry -------------------------------------------------------
  m.fuelCmd = fuelCmd;
  m.smoke = smoke;
  m.deliveredKW = electricalKW + Math.max(0, batteryFlow);
  m.shedKW = Math.max(0, demand - m.deliveredKW);
  m.fuelLPerH = litresPerSec * 3600;
  m.indicatedKW = indicatedW / 1000;
  m.batteryFlowKW = batteryFlow;
  m.thermalKW = spec.chpFrac > 0 ? ((heatW * spec.chpFrac) / 1000) : 0;
  m.hz = hz;
  m.volts = volts;
  m.loadPct = (m.deliveredKW / RATED_KW) * 100;

  return events;
}

/** Convenience for tests and for the "settle" the game does before a job. */
export function runFor(m, spec, env, seconds, dt = 0.005) {
  const events = [];
  let t = 0;
  while (t < seconds) {
    const h = Math.min(dt, seconds - t);
    events.push(...step(m, spec, env, h));
    t += h;
  }
  return events;
}
