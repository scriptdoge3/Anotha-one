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
 *
 * Nothing on this machine regulates itself. There is no automatic voltage
 * regulator and no isochronous governor: the field is a rheostat and the speed
 * is whatever the governor droop and your hand on the setpoint make it. What
 * protects the plant is a bank of protective relays, and every one of them
 * latches its target and has to be reset by hand before you can close again.
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
    /** Smallest droop the governor can be set to. A flyweight unit is coarse;
     *  a hydraulic governor will hold a far tighter line if you ask it to. */
    droopMin: 0.03,
    /** Governor hunting: how much the speed wanders about the setpoint. */
    hunt: 0.0016,
    /** How fast the governor reference walks to a new speed, rpm/s. */
    speedSlew: 175,
    /** An aneroid limits the rack to the boost actually present, so the set
     *  accepts load without laying down smoke. */
    aneroid: false,

    // --- electrical -----------------------------------------------------
    altEff: 0.93,
    altRatingKW: 92,
    /** Terminal volts lost to armature reaction at full load, per unit.
     *  A synchronous machine really is this bad without regulation. */
    armatureReaction: 0.28,
    /** Series compounding: a current transformer adds to the exciter as load
     *  rises, cancelling part of the armature reaction. Passive, not a
     *  regulator -- you still set the base excitation by hand. */
    compounded: 0,
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
    /** Full switchboard instrumentation: pyrometer, oil gauge, kWh register. */
    fullInstruments: false,
    /** Oil pump capacity, bar at rated speed on hot oil. */
    oilPressureRated: 4.1,

    batteryKWh: 0,
    batteryKW: 0,

    // --- output / compliance -------------------------------------------
    chpFrac: 0,
    noiseDb: 92,
    emissionsTier: 2,
    capabilities: [],
    fuel: 'diesel',

    tankL: 300,
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
    hours: 0,
    dpfLoad: 0,
    batterySoc: 1,

    // --- operator controls ----------------------------------------------
    /** 0..1. In MANUAL it is the fuel rack directly; otherwise the speed
     *  setpoint, mapped over 1500-1900 rpm. */
    throttle: 0.5,
    /** 'manual' (hand on the rack) | 'droop' (flyweight governor) */
    govMode: 'droop',
    /** Droop setting on the governor itself. Tight droop holds frequency on an
     *  island; wide droop is what lets machines share load on a bus without
     *  fighting each other. */
    droopSet: spec.droop,
    /** 'idle' | 'run'. A set is started and warmed at idle, then brought up to
     *  rated speed deliberately. */
    runMode: 'idle',
    /** Speed the governor is actually working to, which walks towards the
     *  selected speed rather than jumping to it. */
    speedRef: IDLE_RPM,
    /** Field rheostat, per unit. There is nothing else driving the field. */
    excCmd: 1.0,
    /** The field breaker. No field, no volts, no closing onto anything. */
    fieldClosed: false,
    /** The main (generator) breaker. */
    breakerClosed: false,

    // --- internal state --------------------------------------------------
    huntPhase: 0,
    /** Actual field current, lagging the command through the exciter. */
    exc: 0,
    /** Machine terminal electrical phase, degrees. */
    phase: 0,
    /** Bus phase, degrees. */
    busPhase: 0,
    /** Rotor angle ahead of the bus while synchronised, degrees. */
    delta: 0,
    synced: false,
    fanCmd: 1,

    // --- protective relays ------------------------------------------------
    // Each one latches its target when it operates. Nothing closes again until
    // the board has been reset by hand.
    relays: {
      underFreq: false, overFreq: false,
      underVolt: false, overVolt: false,
      overCurrent: false, reversePower: false,
      lowOilPressure: false, overspeed: false,
    },
    /** Seconds each relay has been seeing a fault, for their time delays. */
    relayTimers: {},

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
    amps: 0,
    loadPct: 0,
    syncAngle: 0,
    slipHz: 0,
    /** Engine instruments. */
    oilBar: 0,
    egtC: 20,
    /** Integrating kWh register, like the mechanical one on the board. */
    kwhRegister: 0,
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

/** Last-step rack, used only to scale governor hunting with load. */
function fuelHint(m) {
  return clamp(m.fuelCmd ?? 0, 0, 1);
}

/** Idle speed the governor holds with the run switch at IDLE. */
export const IDLE_RPM = 800;

/**
 * How much of its indicated power a diesel can actually make at a given
 * fraction of rated speed. Down at cranking and idle speeds the charge motion,
 * volumetric efficiency and injection are all poor, and the engine makes
 * nothing like its rated torque. Without this the model hands you full torque
 * at 400 rpm and the set slams up to speed in two seconds.
 */
export function speedTorqueFactor(rpmNorm) {
  return clamp(0.3 + 0.7 * (rpmNorm / 0.62), 0.3, 1);
}

/** Widest droop the governor will accept. */
export const DROOP_MAX = 0.06;

/** The droop actually in force: what you set, floored by what the unit can do. */
export function governorDroop(m, spec) {
  return clamp(m.droopSet ?? spec.droop, spec.droopMin, DROOP_MAX);
}

/** Ends of the speed-setting lever's travel, rpm. */
export const SPEED_MIN = 1740;
export const SPEED_MAX = 1860;

/**
 * Speed setpoint the lever is asking for, in rpm.
 *
 * The travel covers 58 to 62 Hz and nothing else. A genset lever that swung
 * from a slow idle to well past rated would put the entire useful range -- and
 * the whole synchronising window -- inside a few millimetres of movement, which
 * is exactly the sort of control nobody would build.
 */
export function speedSetpoint(throttle) {
  return SPEED_MIN + clamp(throttle, 0, 1) * (SPEED_MAX - SPEED_MIN);
}

/** Inverse, for seeding the lever from a speed. */
export function throttleForSpeed(rpm) {
  return clamp((rpm - SPEED_MIN) / (SPEED_MAX - SPEED_MIN), 0, 1);
}

const PROT_UNDER_HZ = 57;
const PROT_OVER_HZ = 63.5;
const PROT_DELAY_S = 1.5;

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
  // The governor works to a reference that walks towards the selected speed
  // instead of stepping to it. That is what an accelerating ramp is on a real
  // governor, and it is why a set comes up to speed over several seconds
  // rather than arriving there on a wide-open rack.
  const selected = m.runMode === 'run' ? speedSetpoint(m.throttle) : IDLE_RPM;
  if (m.running) {
    const slew = spec.speedSlew * dt;
    m.speedRef += clamp(selected - m.speedRef, -slew, slew);
  } else {
    m.speedRef = IDLE_RPM;
  }

  let fuelCmd = 0;
  if (m.running) {
    const setRpm = m.speedRef;
    if (m.govMode === 'manual') {
      // Hand on the rack. Nothing holds the speed but you.
      fuelCmd = clamp(m.throttle, 0, 1);
    } else {
      // Flyweight governor: fuel is a pure proportional function of the speed
      // shortfall, so the set genuinely runs fast when unloaded. Real governors
      // also hunt a little about the setpoint, and a cheap one hunts more.
      m.huntPhase = (m.huntPhase + dt * 2.6) % (Math.PI * 2);
      const hunt = spec.hunt * Math.sin(m.huntPhase) * (0.35 + fuelHint(m));
      const droop = governorDroop(m, spec);
      const noLoadRpm = m.speedRef * (1 + droop);
      fuelCmd = clamp((noLoadRpm - m.rpm) / (droop * NOMINAL_RPM) + hunt, 0, 1);
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
  // An aneroid boost compensator physically ties the rack stop to inlet
  // manifold pressure, so the pump cannot deliver fuel the air will not burn.
  const limiterMargin = spec.aneroid ? 1.0 : spec.boostGain > 0 ? 1.06 : 1.2;
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
  const indicatedW = mdot * lhv * spec.indicatedEff * combEff * speedTorqueFactor(rpmNorm);
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
    excTarget = clamp(m.excCmd, 0, spec.excMax);
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
      m.relays.overCurrent = true;
      events.push({ type: 'pole-slip' });
    }
  } else {
    // ---- island, or breaker open --------------------------------------
    const requestedKW = Math.max(0, demand - batteryFlow);
    electricalKW = m.breakerClosed ? Math.min(requestedKW, spec.altRatingKW) : 0;
    const loadFrac = clamp(electricalKW / spec.altRatingKW, 0, 1.4);
    // Terminal volts sag with load through armature reaction. Series
    // compounding cancels part of it passively; the rest is the operator's
    // problem, to be wound out on the rheostat as load comes on.
    const netSag = Math.max(0, spec.armatureReaction - spec.compounded);
    volts = Math.max(0, NOMINAL_V * Epu - netSag * NOMINAL_V * loadFrac);
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
    m.speedRef = IDLE_RPM;
    events.push({ type: 'stalled' });
  }
  // Mechanical overspeed trip. In MANUAL this is a live hazard: drop the load
  // with the rack open and the engine will run away.
  if (m.running && m.rpm > NOMINAL_RPM * OVERSPEED_TRIP) {
    m.running = false;
    m.breakerClosed = false;
    m.synced = false;
    m.relays.overspeed = true;
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

  // ---- engine instruments ---------------------------------------------
  if (m.running) m.hours += dt / 3600;

  // Oil pressure follows pump speed, and falls away as the oil thins with
  // heat. Lose it and the engine has to be shut down.
  const oilTempC = m.coolantC + 12;
  const viscosity = clamp(1.25 - Math.max(0, oilTempC - 85) * 0.011, 0.45, 1.25)
    * (spec.oilCooled ? 1.08 : 1);
  m.oilBar = m.running
    ? clamp(spec.oilPressureRated * (0.28 + 0.72 * rpmNorm) * viscosity, 0, 7)
    : 0;

  // Exhaust gas temperature: what the pyrometer on the manifold reads. Rises
  // with load, and hard with over-fuelling.
  const loadFrac = clamp(Math.abs(electricalKW) / spec.altRatingKW, 0, 1.4);
  const egtTarget = burning
    ? (env.ambientC ?? 20) + 195 + 385 * Math.pow(loadFrac, 1.08) + smoke * 210
    : (env.ambientC ?? 20);
  // The manifold and probe have real thermal mass, so it lags.
  m.egtC += (egtTarget - m.egtC) * Math.min(1, dt / 9);

  // Line current, as the ammeter reads it.
  m.amps = volts > 50 ? (Math.hypot(electricalKW, kvar) * 1000) / (Math.sqrt(3) * volts) : 0;
  m.kwhRegister += (Math.max(0, electricalKW) * dt) / 3600;

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

  // ---- protective relays -----------------------------------------------
  // Every one of these latches its target. The board has to be reset by hand
  // before the breaker will close again, which is exactly how switchgear of
  // the period behaved -- and why an operator walks the panel after a trip.
  const T = m.relayTimers;
  const holdFor = (key, faulted, delay) => {
    T[key] = faulted ? (T[key] ?? 0) + dt : 0;
    return T[key] > delay;
  };

  const ratedAmps = (spec.altRatingKW * 1000) / (Math.sqrt(3) * NOMINAL_V * 0.8);
  const offBus = !(m.synced && bus);
  const tripped = [];

  if (m.running && m.oilBar < 1.0 && holdFor('lop', true, 2.5)) {
    m.relays.lowOilPressure = true;
    tripped.push('lowOilPressure');
  } else if (!(m.running && m.oilBar < 1.0)) T.lop = 0;

  if (m.breakerClosed) {
    if (offBus && holdFor('uf', hz < PROT_UNDER_HZ, PROT_DELAY_S)) {
      m.relays.underFreq = true; tripped.push('underFreq');
    }
    if (offBus && holdFor('of', hz > PROT_OVER_HZ, 1.0)) {
      m.relays.overFreq = true; tripped.push('overFreq');
    }
    // Real under-voltage relays run several seconds of delay, which is exactly
    // the window an operator needs to wind the field up as load comes on.
    if (holdFor('uv', volts < NOMINAL_V * 0.78, 4.0)) {
      m.relays.underVolt = true; tripped.push('underVolt');
    }
    if (holdFor('ov', volts > NOMINAL_V * 1.15, 1.0)) {
      m.relays.overVolt = true; tripped.push('overVolt');
    }
    // Inverse-time overcurrent: a small overload is tolerated for a while, a
    // large one is not.
    const iPu = ratedAmps > 0 ? m.amps / ratedAmps : 0;
    if (holdFor('oc', iPu > 1.15, iPu > 1.5 ? 1.0 : 8.0)) {
      m.relays.overCurrent = true; tripped.push('overCurrent');
    }
    // Reverse power: the bus is motoring the set. Left alone it will wreck the
    // engine, so the relay throws it off line.
    if (!offBus && holdFor('rp', electricalKW < -spec.altRatingKW * 0.05, 3.0)) {
      m.relays.reversePower = true; tripped.push('reversePower');
    }
  } else {
    for (const k of ['uf', 'of', 'uv', 'ov', 'oc', 'rp']) T[k] = 0;
  }

  if (tripped.length) {
    m.breakerClosed = false;
    m.synced = false;
    events.push({ type: 'relay-trip', relays: tripped });
    if (m.relays.lowOilPressure) {
      m.running = false;
      events.push({ type: 'oil-shutdown' });
    }
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
  if (anyRelayLatched(m)) {
    return { ok: false, msg: 'Relay target standing — reset the board first.', locked: true };
  }
  const check = syncCheck(m, env);
  if (check.ok) {
    m.breakerClosed = true;
    if (env.bus) {
      m.synced = true;
      // The rotor takes up the phase error it was closed at.
      m.delta = wrapDeg(m.phase - m.busPhase);
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
  if (env.bus) {
    m.synced = true;
    m.delta = wrapDeg(m.phase - m.busPhase);
  }
  // An out-of-phase close is a violent electrical and mechanical event: an
  // enormous current surge as the rotor is dragged into step. The overcurrent
  // relay sees it and throws the set straight back off line.
  m.rpm = Math.max(0, m.rpm * (1 - severity * 0.28));
  if (severity > 0.3) {
    m.breakerClosed = false;
    m.synced = false;
    m.relays.overCurrent = true;
    if (severity > 0.6) m.relays.underVolt = true;
  }
  return { ok: true, shock: true, severity };
}

/** Is any protective relay target standing? */
export function anyRelayLatched(m) {
  return Object.values(m.relays ?? {}).some(Boolean);
}

/** Names of the standing targets, for the panel. */
export function latchedRelays(m) {
  return Object.entries(m.relays ?? {}).filter(([, v]) => v).map(([k]) => k);
}

/**
 * Walk the board and reset every flag. An operator does this by hand, having
 * first worked out why it tripped.
 */
export function resetRelays(m) {
  for (const k of Object.keys(m.relays ?? {})) m.relays[k] = false;
  m.relayTimers = {};
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
