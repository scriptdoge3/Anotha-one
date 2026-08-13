/**
 * Genset physics core.
 *
 * Everything in here is pure: `step()` takes a machine state, a spec (the
 * aggregated result of your tech tree), an environment, and a timestep, and
 * mutates the machine state. No DOM, no globals, no randomness except what is
 * handed in. That keeps it testable and keeps the panel honest -- the meters
 * show what the model actually computed, not a scripted animation.
 *
 * The machine is operated by hand. Two controls do everything, and what they
 * do depends entirely on whether you are on your own or tied to a live bus:
 *
 *   OFF BUS   throttle -> engine speed -> FREQUENCY
 *             field    -> excitation   -> VOLTAGE
 *
 *   ON BUS    throttle -> mechanical power -> load angle -> REAL POWER (kW)
 *             field    -> internal EMF     ->              REACTIVE POWER (kVAr)
 *
 * That reversal is the central fact of synchronous machine operation, and it
 * falls out of the model rather than being special-cased for flavour.
 */

export const NOMINAL_RPM = 1800;
export const POLES = 4;
export const NOMINAL_V = 480;

/** Lower heating value of diesel, J/kg. */
export const LHV_DIESEL = 42.7e6;
/** Diesel density, kg/L, at 15 C. */
export const DIESEL_DENSITY = 0.832;
/** HVO / renewable diesel: more energy per kg, less per litre. */
export const LHV_HVO = 44.0e6;
export const HVO_DENSITY = 0.78;

export const RATED_KW = 75;

/**
 * Air/fuel ratio at full rack on a healthy naturally aspirated 6 litre six at
 * 1800 rpm. This is not a tuning constant: it falls out of the displacement,
 * volumetric efficiency and rack size already in the model, and it happens to
 * land on the real diesel smoke limit. Below this you make soot, not torque.
 */
export const AFR_SMOKE_LIMIT = 17.5;

/** Overspeed trip, as a fraction of rated. Real sets trip around 115%. */
export const OVERSPEED_TRIP = 1.15;

export function rpmToHz(rpm) {
  return (rpm * POLES) / 120;
}
export function hzToRpm(hz) {
  return (hz * 120) / POLES;
}
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
/** Wrap an angle to (-180, 180]. */
export function wrapDeg(a) {
  let x = ((a + 180) % 360 + 360) % 360 - 180;
  if (x === -180) x = 180;
  return x;
}

/**
 * Base machine, before any tech is fitted. A stock mechanical-injection,
 * naturally aspirated 6.0 L industrial six with a flyweight governor, a hand
 * field rheostat and no automatic anything.
 */
export function baseSpec() {
  return {
    // --- fuelling -------------------------------------------------------
    mdotFullScale: 5.56e-3,
    fuelScale: 1.0,
    indicatedEff: 0.4,

    // --- air ------------------------------------------------------------
    boostGain: 0.0,
    boostTau: 1.6,
    chargeDensityBonus: 0.0,
    backPressure: 0.0,

    // --- mechanical -----------------------------------------------------
    frictionA: 12,
    frictionB: 0.0135,
    inertia: 5.5,
    durability: 1.0,
    torqueLimit: 720,

    // --- thermal --------------------------------------------------------
    coolantHeatFrac: 0.3,
    radiatorUA: 950,
    thermalMass: 347000,
    fanPowerKW: 1.6,
    fanVariable: false,
    oilCooled: false,

    // --- governing ------------------------------------------------------
    /** Fractional speed drop from no load to full load on the mechanical governor. */
    droop: 0.03,
    /** An isochronous electronic governor becomes selectable. */
    isochAvailable: false,
    loadAnticipation: 0,

    // --- electrical -----------------------------------------------------
    altEff: 0.93,
    altRatingKW: 92,
    /** Terminal volts lost to armature reaction at full load, per unit.
     *  A synchronous machine really is this bad without regulation. */
    armatureReaction: 0.28,
    /** An automatic voltage regulator becomes selectable. */
    avrFitted: false,
    /** Exciter time constant, seconds. Field current does not move instantly. */
    excTau: 0.35,
    /** Ceiling on field current, per unit. */
    excMax: 1.85,
    /** Synchronous reactance, per unit. Sets pull-out power and swing rate. */
    syncReactance: 1.2,
    /** Damper winding torque coefficient, N*m per rad/s of slip. */
    damping: 17,
    /** Check-sync relay: blocks a breaker close that would be violent. */
    checkSync: false,

    batteryKWh: 0,
    batteryKW: 0,

    // --- output / compliance -------------------------------------------
    chpFrac: 0,
    noiseDb: 92,
    emissionsTier: 2,
    capabilities: [],
    fuel: 'diesel',

    tankL: 300,
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
    batterySoc: 1,

    // --- operator controls ----------------------------------------------
    /** 0..1. In MANUAL it is the fuel rack directly; otherwise the speed
     *  setpoint, mapped over 1500-1900 rpm. */
    throttle: 0.75,
    /** 'manual' | 'droop' | 'isoch' */
    govMode: 'droop',
    /** Field rheostat, per unit. */
    excCmd: 1.0,
    /** 'manual' | 'avr' */
    excMode: 'manual',
    /** The field breaker. No field, no volts, no closing onto anything. */
    fieldClosed: false,
    /** The main (generator) breaker. */
    breakerClosed: false,
    pendingClose: false,

    // --- internal state --------------------------------------------------
    govInteg: 0,
    avrInteg: 0,
    /** Actual field current, lagging the command through the exciter. */
    exc: 0,
    /** Machine terminal electrical phase, degrees. */
    phase: 0,
    /** Bus phase, degrees. */
    busPhase: 0,
    /** Rotor angle ahead of the bus while synchronised, degrees. */
    delta: 0,
    synced: false,
    protTimer: 0,
    recloseTimer: 0,
    fanCmd: 1,

    // --- last-step telemetry (read-only for the panel) -------------------
    fuelCmd: 0,
    smoke: 0,
    afr: 0,
    deliveredKW: 0,
    kvar: 0,
    pf: 1,
    shedKW: 0,
    thermalKW: 0,
    fuelLPerH: 0,
    indicatedKW: 0,
    batteryFlowKW: 0,
    hz: 0,
    volts: 0,
    loadPct: 0,
    syncAngle: 0,
    slipHz: 0,
  };
}

export function defaultEnv() {
  return {
    ambientC: 20,
    altitudeM: 0,
    abrasion: 1,
    demandKW: 0,
    demandRateKW: 0,
    /** null for an island load, or { hz, volts } for a live bus to parallel with. */
    bus: null,
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

/** Speed setpoint the throttle lever is asking for, in rpm. */
export function speedSetpoint(throttle) {
  return 1500 + clamp(throttle, 0, 1) * 400;
}

const PROT_UNDER_HZ = 57;
const PROT_OVER_HZ = 63.5;
const PROT_DELAY_S = 1.5;
const RECLOSE_S = 8;

/** How closely you must match a live bus before the breaker may be closed. */
export const SYNC_LIMITS = {
  /** Hz. Incoming should be a touch fast so it takes load rather than motoring. */
  slipMax: 0.35,
  slipMin: -0.1,
  /** Degrees of phase error either side of dead ahead. */
  angleMax: 12,
  /** Fractional volts mismatch. */
  voltMax: 0.06,
};

/**
 * Is it safe to close the main breaker right now?
 * Returns { ok, reason, severity } where severity 0..1 scales the shock if you
 * force it anyway.
 */
export function syncCheck(m, env) {
  if (!m.running) return { ok: false, reason: 'Engine not running', severity: 1 };
  if (!m.fieldClosed || m.volts < NOMINAL_V * 0.5) {
    return { ok: false, reason: 'No excitation — close the field breaker', severity: 1 };
  }
  const bus = env.bus;
  if (!bus) {
    // Dead bus: just needs to be a healthy machine.
    const hz = m.hz;
    if (hz < 58 || hz > 62) return { ok: false, reason: 'Frequency out of range', severity: 0.6 };
    return { ok: true };
  }
  const slip = m.hz - bus.hz;
  const angle = wrapDeg(m.phase - m.busPhase);
  const dv = Math.abs(m.volts - bus.volts) / bus.volts;

  // Severity is the worst of the three mismatches, not the first one noticed.
  // Phase angle dominates: it is what actually delivers the bang, since the
  // rotor is dragged bodily into step with the bus.
  const severity = clamp(
    Math.max(
      Math.abs(angle) / 180,
      Math.abs(slip) / 2.5,
      dv * 3,
    ),
    0.1,
    1,
  );

  if (slip > SYNC_LIMITS.slipMax || slip < SYNC_LIMITS.slipMin) {
    return {
      ok: false,
      reason: `Slip ${slip >= 0 ? '+' : ''}${slip.toFixed(2)} Hz — trim the throttle`,
      severity,
    };
  }
  if (Math.abs(angle) > SYNC_LIMITS.angleMax) {
    return { ok: false, reason: `Phase ${angle.toFixed(0)}° out — wait for the mark`, severity };
  }
  if (dv > SYNC_LIMITS.voltMax) {
    return {
      ok: false,
      reason: `Volts ${(dv * 100).toFixed(0)}% out — trim excitation`,
      severity,
    };
  }
  return { ok: true };
}

/**
 * Advance the machine by `dt` seconds.
 *
 * Returns an events array describing anything the career layer needs to react
 * to, so the sim never has to know what a contract is.
 */
export function step(m, spec, env, dt) {
  const events = [];
  const { lhv, density } = fuelProps(spec);
  const bus = env.bus ?? null;
  const omega = Math.max((m.rpm * Math.PI) / 30, 1e-3);
  const rpmNorm = clamp(m.rpm / NOMINAL_RPM, 0, 1.25);
  const rho = densityRatio(env.altitudeM ?? 0, env.ambientC ?? 20);

  // ---- starter ---------------------------------------------------------
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
  const fireRpm = m.coolantC < -10 ? 520 : 380;

  // ---- governor --------------------------------------------------------
  let fuelCmd = 0;
  if (m.running) {
    const setRpm = speedSetpoint(m.throttle);
    if (m.govMode === 'manual') {
      // Hand on the rack. Nothing holds the speed but you.
      fuelCmd = clamp(m.throttle, 0, 1);
    } else if (m.govMode === 'isoch' && spec.isochAvailable) {
      const err = setRpm - m.rpm;
      m.govInteg = clamp(m.govInteg + 0.25 * err * dt, 0, 1);
      fuelCmd = clamp(0.055 * err + m.govInteg, 0, 1);
    } else {
      // Flyweight governor: fuel is a pure proportional function of the speed
      // shortfall, so the set genuinely runs fast when unloaded.
      const noLoadRpm = setRpm * (1 + spec.droop);
      fuelCmd = clamp((noLoadRpm - m.rpm) / (spec.droop * NOMINAL_RPM), 0, 1);
    }
    if (spec.loadAnticipation > 0 && m.govMode !== 'manual') {
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
  const fuelAbs = fuelCmd * spec.fuelScale * clamp(rpmNorm, 0.15, 1.2);
  const airAbs =
    (1 + spec.boostGain * m.boost) *
    (1 + spec.chargeDensityBonus) *
    rho *
    clamp(rpmNorm, 0.15, 1.2);

  // The smoke limiter caps the rack at the air actually available. This is the
  // mechanism behind turbo lag: the pump is willing, the air is not.
  const limiterMargin = spec.boostGain > 0 ? 1.06 : 1.2;
  const fuelActual = Math.min(fuelAbs, airAbs * limiterMargin);

  let combEff = 1;
  let smoke = 0;
  if (fuelActual > airAbs && fuelActual > 1e-6) {
    const ratio = airAbs / fuelActual;
    combEff = 0.45 + 0.55 * ratio;
    smoke = clamp((fuelActual - airAbs) / Math.max(airAbs, 0.1), 0, 1);
  }
  // Air/fuel ratio, in the units a stack gauge would read.
  m.afr = fuelActual > 1e-4 ? clamp((AFR_SMOKE_LIMIT * airAbs) / fuelActual, 0, 200) : 200;

  const burning = m.running || m.cranking > 0;
  const mdot = burning ? fuelActual * spec.mdotFullScale : 0;
  const indicatedW = mdot * lhv * spec.indicatedEff * combEff;
  let Ti = m.rpm > 20 ? indicatedW / omega : 0;
  Ti = Math.min(Ti, spec.torqueLimit);

  const Tfric =
    (burning ? spec.frictionA + spec.frictionB * m.rpm
             : spec.frictionA * 0.5 + spec.frictionB * m.rpm) *
    (1 + spec.backPressure) *
    (m.coolantC < 40 ? 1 + (40 - m.coolantC) * 0.006 : 1);

  // ---- excitation ------------------------------------------------------
  // The exciter has a time constant, so field current lags the rheostat.
  let excTarget = 0;
  if (m.fieldClosed && m.running) {
    if (m.excMode === 'avr' && spec.avrFitted) {
      // On an island the AVR holds terminal volts; tied to a bus, volts are
      // fixed by the bus, so it regulates power factor instead.
      if (bus && m.synced) {
        // Regulate REACTIVE power, not power factor directly: raising the
        // field raises kVAr, which pushes power factor the other way, so a
        // naive loop on pf runs the field straight to its ceiling.
        const qTarget = Math.max(m.deliveredKW, 0) * 0.329;   // 0.95 lagging
        const qErr = qTarget - (m.kvar ?? 0);
        m.avrInteg = clamp(m.avrInteg + qErr * dt * 0.004, -0.9, 0.9);
        excTarget = clamp(1.0 + m.avrInteg, 0.3, spec.excMax);
      } else {
        const vErr = (NOMINAL_V - m.volts) / NOMINAL_V;
        m.avrInteg = clamp(m.avrInteg + vErr * dt * 3.2, -1, 1);
        excTarget = clamp(1.0 + vErr * 1.6 + m.avrInteg, 0.1, spec.excMax);
      }
    } else {
      excTarget = clamp(m.excCmd, 0, spec.excMax);
    }
  }
  m.exc += ((excTarget - m.exc) * dt) / Math.max(spec.excTau, 0.02);
  m.exc = clamp(m.exc, 0, spec.excMax);

  // ---- electrical ------------------------------------------------------
  const fanKW = spec.fanVariable
    ? spec.fanPowerKW * clamp(m.fanCmd, 0.15, 1)
    : spec.fanPowerKW * (m.running ? 1 : 0);

  let demand = Math.max(0, env.demandKW ?? 0);
  let batteryFlow = 0;
  if (spec.batteryKWh > 0 && m.running) {
    const comfortable = RATED_KW * 0.82;
    if (demand > comfortable && m.batterySoc > 0.05) {
      batteryFlow = Math.min(spec.batteryKW, demand - comfortable);
      m.batterySoc = clamp(m.batterySoc - ((batteryFlow * dt) / 3600) / spec.batteryKWh, 0, 1);
    } else if (demand < comfortable * 0.8 && m.batterySoc < 0.98) {
      batteryFlow = -Math.min(spec.batteryKW * 0.5, comfortable * 0.8 - demand);
      m.batterySoc = clamp(m.batterySoc + ((-batteryFlow * dt * 0.92) / 3600) / spec.batteryKWh, 0, 1);
    }
  }

  // Internal EMF behind synchronous reactance, per unit.
  const Epu = m.exc * (m.running ? clamp(m.rpm / NOMINAL_RPM, 0, 1.3) : 0)
    + (m.running ? 0.02 : 0); // residual magnetism

  let electricalKW = 0;
  let volts = 0;
  let Tload = 0;
  let kvar = 0;

  if (m.synced && bus && m.breakerClosed) {
    // ---- tied to a live bus -------------------------------------------
    // The bus fixes frequency and volts. Real power is set by the load angle,
    // which the throttle drives; reactive power is set by excitation.
    const Vpu = bus.volts / NOMINAL_V;
    volts = bus.volts;
    const Pmax = (Epu * Vpu / spec.syncReactance) * spec.altRatingKW;
    const dRad = (m.delta * Math.PI) / 180;
    electricalKW = Pmax * Math.sin(dRad);
    kvar = ((Epu * Vpu * Math.cos(dRad) - Vpu * Vpu) / spec.syncReactance) * spec.altRatingKW;

    Tload = (Math.max(electricalKW, 0) / spec.altEff + fanKW) * 1000 / omega;

    // Damper windings resist slip against the bus.
    const omegaSync = (hzToRpm(bus.hz) * Math.PI) / 30;
    Tload += spec.damping * (omega - omegaSync);

    // Load angle integrates the speed difference.
    m.delta += 360 * (rpmToHz(m.rpm) - bus.hz) * dt;

    if (Math.abs(m.delta) > 90) {
      // Pull-out: the rotor has slipped a pole. Nothing good follows.
      m.synced = false;
      m.breakerClosed = false;
      m.recloseTimer = RECLOSE_S;
      m.wear = clamp(m.wear + 1.5, 0, 100);
      events.push({ type: 'pole-slip' });
    }
  } else {
    // ---- island, or breaker open --------------------------------------
    const requestedKW = Math.max(0, demand - batteryFlow);
    electricalKW = m.breakerClosed ? Math.min(requestedKW, spec.altRatingKW) : 0;
    const loadFrac = clamp(electricalKW / spec.altRatingKW, 0, 1.4);
    // Terminal volts sag with load through armature reaction. Without an AVR
    // this is the operator's problem: wind the field up as load comes on.
    volts = Math.max(0, NOMINAL_V * Epu - spec.armatureReaction * NOMINAL_V * loadFrac);
    // Site loads are inductive; assume a typical 0.85 lagging power factor.
    kvar = electricalKW * 0.62;
    Tload = (electricalKW / spec.altEff + fanKW) * 1000 / omega;
  }

  const kva = Math.hypot(electricalKW, kvar);
  m.pf = kva > 0.5 ? clamp(Math.abs(electricalKW) / kva, 0, 1) : 1;
  m.kvar = kvar;

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
    m.synced = false;
    m.rpm = 0;
    events.push({ type: 'stalled' });
  }
  // Mechanical overspeed trip. In MANUAL this is a live hazard: drop the load
  // with the rack open and the engine will run away.
  if (m.running && m.rpm > NOMINAL_RPM * OVERSPEED_TRIP) {
    m.running = false;
    m.breakerClosed = false;
    m.synced = false;
    m.wear = clamp(m.wear + 4, 0, 100);
    events.push({ type: 'overspeed' });
  }

  // ---- boost -----------------------------------------------------------
  if (spec.boostGain > 0) {
    const fuelFrac = clamp(fuelActual / Math.max(spec.fuelScale, 0.01), 0, 1.2);
    const target = clamp((Math.pow(fuelFrac * rpmNorm, 1.8) - 0.05) / 0.62, 0, 1);
    m.boost += ((target - m.boost) * dt) / Math.max(spec.boostTau, 0.05);
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
    m.synced = false;
    events.push({ type: 'out-of-fuel' });
  }

  // ---- thermal ---------------------------------------------------------
  const heatW = mdot * lhv * spec.coolantHeatFrac + Tfric * omega;
  m.fanCmd = spec.fanVariable ? clamp(0.15 + (m.coolantC - 78) / 18, 0.15, 1) : 1;
  const fanFactor = spec.fanVariable ? clamp(m.fanCmd, 0.15, 1) : 1;
  const rejectW =
    spec.radiatorUA * (0.35 + 0.65 * fanFactor) * (m.coolantC - (env.ambientC ?? 20));
  m.coolantC += ((heatW - rejectW) / spec.thermalMass) * dt;
  if (m.coolantC > 118 && m.running) events.push({ type: 'overheat' });

  // ---- wear ------------------------------------------------------------
  if (m.running) {
    const loadFactor = clamp(Math.abs(electricalKW) / RATED_KW, 0, 1.4);
    const heatPenalty = m.coolantC > 100 ? 1 + (m.coolantC - 100) * 0.12 : 1;
    const smokePenalty = 1 + smoke * 1.8;
    const servicePenalty = m.hoursSinceService > 250 ? 1.6 : 1;
    const oilRelief = spec.oilCooled && loadFactor > 0.7 ? 0.7 : 1;
    // Running the field hard cooks the rotor.
    const fieldPenalty = m.exc > 1.55 ? 1 + (m.exc - 1.55) * 2.2 : 1;
    const rate =
      (spec.wearBase *
        (0.4 + Math.pow(loadFactor, 1.6)) *
        heatPenalty * smokePenalty * servicePenalty * oilRelief * fieldPenalty *
        (env.abrasion ?? 1)) / spec.durability;
    m.wear = clamp(m.wear + (rate * dt) / 3600, 0, 100);
    m.hours += dt / 3600;
    m.hoursSinceService += dt / 3600;
    if (m.wear >= 100) {
      m.running = false;
      m.breakerClosed = false;
      m.synced = false;
      events.push({ type: 'seized' });
    }
  }

  if (spec.capabilities.includes('dpf')) {
    m.dpfLoad = clamp(m.dpfLoad + smoke * dt * 0.004 - dt * 0.00015, 0, 1);
  }

  // ---- phase tracking --------------------------------------------------
  const hz = rpmToHz(m.rpm);
  m.phase = (m.phase + hz * 360 * dt) % 360;
  if (bus) {
    m.busPhase = (m.busPhase + bus.hz * 360 * dt) % 360;
    m.slipHz = hz - bus.hz;
    // While synchronised the synchroscope reads the load angle itself.
    m.syncAngle = m.synced ? m.delta : wrapDeg(m.phase - m.busPhase);
  } else {
    m.busPhase = 0;
    m.slipHz = 0;
    m.syncAngle = 0;
  }

  // ---- protection ------------------------------------------------------
  if (m.breakerClosed) {
    const offBus = !(m.synced && bus);
    const badHz = offBus && (hz < PROT_UNDER_HZ || hz > PROT_OVER_HZ);
    const badV = volts < NOMINAL_V * 0.55;
    const bad = badHz || badV || !m.running;
    m.protTimer = bad ? m.protTimer + dt : 0;
    if (m.protTimer > PROT_DELAY_S || !m.running) {
      m.breakerClosed = false;
      m.synced = false;
      m.protTimer = 0;
      m.recloseTimer = RECLOSE_S;
      events.push({ type: 'trip', hz });
    }
  } else if (m.recloseTimer > 0) {
    m.recloseTimer = Math.max(0, m.recloseTimer - dt);
    // Auto-reclose only ever applies to a dead bus; you never get an automatic
    // close onto a live one.
    if (m.recloseTimer === 0 && !bus && m.running && hz > 58.5 && hz < 62
        && volts > NOMINAL_V * 0.85) {
      m.breakerClosed = true;
      events.push({ type: 'reclose' });
    }
  } else if (m.pendingClose && !bus && m.running && hz > 58.5 && hz < 62
             && volts > NOMINAL_V * 0.85) {
    m.breakerClosed = true;
    m.pendingClose = false;
    events.push({ type: 'closed-on-load' });
  }

  // ---- telemetry -------------------------------------------------------
  m.fuelCmd = fuelCmd;
  m.smoke = smoke;
  m.deliveredKW = Math.max(0, electricalKW) + Math.max(0, batteryFlow);
  m.shedKW = Math.max(0, demand - m.deliveredKW);
  m.fuelLPerH = litresPerSec * 3600;
  m.indicatedKW = indicatedW / 1000;
  m.batteryFlowKW = batteryFlow;
  m.thermalKW = spec.chpFrac > 0 ? (heatW * spec.chpFrac) / 1000 : 0;
  m.hz = m.synced && bus ? bus.hz : hz;
  m.volts = volts;
  m.loadPct = (m.deliveredKW / RATED_KW) * 100;

  return events;
}

/**
 * Close the main breaker. On a dead bus this is just a healthy-machine check;
 * onto a live bus it is a synchronising operation, and forcing it out of step
 * shocks the whole driveline.
 */
export function closeBreaker(m, spec, env) {
  const check = syncCheck(m, env);
  if (check.ok) {
    m.breakerClosed = true;
    m.pendingClose = false;
    m.protTimer = 0;
    if (env.bus) {
      m.synced = true;
      // The rotor takes up the phase error it was closed at.
      m.delta = wrapDeg(m.phase - m.busPhase);
      m.avrInteg = 0;
    }
    return { ok: true };
  }
  if (spec.checkSync) {
    // The check-sync relay simply refuses.
    return { ok: false, msg: `Check-sync relay blocked the close: ${check.reason}`, blocked: true };
  }
  return { ok: false, msg: check.reason, severity: check.severity };
}

/**
 * Force the breaker shut regardless. Only reachable without a check-sync relay.
 * Returns the damage done so the career layer can log it.
 */
export function forceCloseBreaker(m, spec, env) {
  const check = syncCheck(m, env);
  if (check.ok) return closeBreaker(m, spec, env);

  const severity = check.severity ?? 0.5;
  m.breakerClosed = true;
  m.pendingClose = false;
  if (env.bus) {
    m.synced = true;
    m.delta = wrapDeg(m.phase - m.busPhase);
  }
  // An out-of-phase close is a violent mechanical event: the rotor is dragged
  // into step against the bus and everything in the driveline feels it.
  const wear = 3 + severity * 22;
  m.wear = clamp(m.wear + wear, 0, 100);
  m.rpm = Math.max(0, m.rpm * (1 - severity * 0.28));
  if (severity > 0.55) {
    m.breakerClosed = false;
    m.synced = false;
    m.recloseTimer = RECLOSE_S;
  }
  return { ok: true, shock: true, severity, wear };
}

/** Convenience for tests and for settling the machine before a job. */
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
