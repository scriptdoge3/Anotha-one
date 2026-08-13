import test from 'node:test';
import assert from 'node:assert/strict';
import {
  baseSpec, newMachine, defaultEnv, step, runFor, rpmToHz, wrapDeg,
  closeBreaker, forceCloseBreaker, syncCheck, speedSetpoint, throttleForSpeed,
  latchedRelays, anyRelayLatched, resetRelays as simResetRelays,
  AFR_SMOKE_LIMIT, OVERSPEED_TRIP, NOMINAL_RPM,
} from '../src/sim.js';
import { buildSpec } from '../src/tech.js';
import { createGame, setGovMode, envFor, resetRelays } from '../src/state.js';

const BUS = { hz: 60, volts: 480 };

/** Lever position that gives `hz` off load, allowing for governor droop. */
function leverFor(hz, spec) {
  return throttleForSpeed(((hz / 60) * 1800) / (1 + spec.droop));
}

/** Trim the rheostat towards nominal volts, the way an operator does. */
function holdVolts(m, spec, env, seconds, target = 480) {
  for (let t = 0; t < seconds; t += 0.5) {
    runFor(m, spec, env, 0.5);
    m.excCmd = Math.max(0, Math.min(spec.excMax, m.excCmd + ((target - m.volts) / 480) * 0.35));
  }
}

function boot(owned = [], envOverrides = {}) {
  const spec = buildSpec(owned, baseSpec);
  const m = newMachine(spec);
  const env = { ...defaultEnv(), ...envOverrides };
  m.cranking = 6;
  runFor(m, spec, env, 12);
  return { m, spec, env };
}

/** Bring a machine to the point of being ready to close, on a dead bus. */
function excited(owned = [], envOverrides = {}, exc = 1.0) {
  const r = boot(owned, envOverrides);
  r.m.fieldClosed = true;
  r.m.excCmd = exc;
  runFor(r.m, r.spec, r.env, 4);
  return r;
}

// ------------------------------------------------------------ excitation --

test('no field means no volts, and nothing to close onto', () => {
  const { m, spec, env } = boot();
  assert.ok(m.running);
  assert.ok(m.volts < 30, `residual only, got ${m.volts} V`);
  const chk = syncCheck(m, env);
  assert.equal(chk.ok, false);
  assert.match(chk.reason, /excitation/i);
  assert.equal(closeBreaker(m, spec, env).ok, false);
});

test('closing the field breaker builds voltage, and it takes a moment', () => {
  const { m, spec, env } = boot();
  m.fieldClosed = true;
  m.excCmd = 1.0;
  runFor(m, spec, env, 0.1);
  const early = m.volts;
  runFor(m, spec, env, 4);
  assert.ok(m.volts > 400, `settled at ${m.volts} V`);
  assert.ok(early < m.volts, 'the exciter should not be instantaneous');
});

test('excitation sets terminal voltage on an island', () => {
  const seen = [];
  for (const exc of [0.6, 0.9, 1.2]) {
    const { m } = excited([], {}, exc);
    seen.push(m.volts);
  }
  assert.ok(seen[0] < seen[1] && seen[1] < seen[2], `volts ${seen}`);
});

test('an unregulated machine loses volts under load and must be trimmed by hand', () => {
  const { m, spec, env } = excited();
  closeBreaker(m, spec, env);
  const noLoad = m.volts;
  env.demandKW = 70;
  runFor(m, spec, env, 30);
  const loaded = m.volts;
  assert.ok(
    loaded < noLoad * 0.85,
    `expected a big sag: ${noLoad.toFixed(0)} -> ${loaded.toFixed(0)} V`,
  );
  // Wind the field on and it comes back.
  m.excCmd = 1.35;
  runFor(m, spec, env, 8);
  assert.ok(m.volts > loaded + 60, `hand trim should recover volts, got ${m.volts}`);
});

// -------------------------------------------------------------- governing --

test('the lever sets the governor speed, and the governor droops from it', () => {
  assert.equal(speedSetpoint(0.5), 1800);
  assert.ok(speedSetpoint(0) < speedSetpoint(1));
  for (const t of [0.35, 0.5, 0.65]) {
    const { m, spec, env } = excited(['avr', 'govlinkage', 'isoch']);
    m.govMode = 'droop';
    m.throttle = t;
    runFor(m, spec, env, 30);
    // Off load a droop governor sits above its setpoint, by definition.
    const expected = speedSetpoint(t) * (1 + spec.droop);
    assert.ok(
      Math.abs(m.rpm - expected) < 8,
      `lever ${t} wanted about ${expected.toFixed(0)} rpm, held ${m.rpm.toFixed(0)}`,
    );
  }
});

test('in MANUAL the rack is the throttle, and nothing holds the speed', () => {
  const { m, spec, env } = excited();
  closeBreaker(m, spec, env);
  env.demandKW = 40;
  runFor(m, spec, env, 20);
  // Hand over at the rack the governor was holding, then take load away.
  m.throttle = m.fuelCmd;
  m.govMode = 'manual';
  runFor(m, spec, env, 5);
  const withLoad = m.rpm;
  m.breakerClosed = false;
  env.demandKW = 0;
  runFor(m, spec, env, 6);
  assert.ok(
    m.rpm > withLoad + 40 || !m.running,
    `dropping load with the rack open should run away: ${withLoad.toFixed(0)} -> ${m.rpm.toFixed(0)}`,
  );
});

test('runaway hits the overspeed trip and shuts the engine down', () => {
  const { m, spec, env } = excited();
  m.govMode = 'manual';
  m.throttle = 1;
  const events = runFor(m, spec, env, 30);
  assert.ok(events.some((e) => e.type === 'overspeed'), 'expected an overspeed trip');
  assert.ok(!m.running);
  assert.ok(m.rpm <= NOMINAL_RPM * OVERSPEED_TRIP + 60);
});

test('switching governor mode is bumpless', () => {
  const g = createGame();
  const m = g.machine;
  m.cranking = 6;
  advanceYard(g, 12);
  m.fieldClosed = true;
  advanceYard(g, 4);
  const before = m.fuelCmd;
  assert.ok(setGovMode(g, 'manual').ok);
  advanceYard(g, 0.5);
  assert.ok(
    Math.abs(m.fuelCmd - before) < 0.05,
    `rack jumped ${before.toFixed(3)} -> ${m.fuelCmd.toFixed(3)} on handover`,
  );
});

/** Step the machine without needing a contract. */
function advanceYard(g, seconds) {
  runFor(g.machine, g.spec, envFor(g), seconds);
}

// -------------------------------------------------------------------- AFR --

test('AFR runs lean at light load and reaches the smoke limit at full rack', () => {
  const { m, spec, env } = excited();
  closeBreaker(m, spec, env);
  env.demandKW = 8;
  holdVolts(m, spec, env, 60);
  const light = m.afr;
  env.demandKW = 78;
  holdVolts(m, spec, env, 90);
  const heavy = m.afr;
  assert.ok(light > 60, `light load should be very lean, got ${light.toFixed(1)}`);
  assert.ok(heavy > 15 && heavy < 22, `full load should sit near the limit, got ${heavy.toFixed(1)}`);
  assert.ok(heavy < light);
});

test('sooting only happens below the smoke limit', () => {
  const owned = ['intake', 'turbo', 'intercooler', 'compound', 'synthoil', 'alloyblock', 'windings', 'crank'];
  const { m, spec, env } = excited(owned);
  closeBreaker(m, spec, env);
  env.demandKW = 15;
  holdVolts(m, spec, env, 120);
  env.demandKW = spec.altRatingKW;
  let sawSmoke = false;
  let afrAtSmoke = 99;
  for (let i = 0; i < 500; i++) {
    step(m, spec, env, 0.005);
    if (m.smoke > 0.02) { sawSmoke = true; afrAtSmoke = Math.min(afrAtSmoke, m.afr); }
  }
  assert.ok(sawSmoke, 'a hard step on a laggy turbo should make smoke');
  assert.ok(
    afrAtSmoke <= AFR_SMOKE_LIMIT + 0.5,
    `smoke appeared at AFR ${afrAtSmoke.toFixed(1)}, above the limit`,
  );
});

// ----------------------------------------------------------- synchronising --

test('the synchroscope needle turns once per beat of slip', () => {
  const { m, spec, env } = excited(['avr', 'govlinkage', 'isoch', 'parallel'], { bus: BUS });
  m.govMode = 'droop';
  m.throttle = leverFor(60.5, spec);
  runFor(m, spec, env, 20);
  assert.ok(Math.abs(m.slipHz - 0.5) < 0.05, `slip was ${m.slipHz}`);

  // Over one full revolution's worth of time the needle should come back round.
  const start = m.syncAngle;
  runFor(m, spec, env, 1 / Math.abs(m.slipHz));
  assert.ok(
    Math.abs(wrapDeg(m.syncAngle - start)) < 15,
    `needle should return to the mark, ended ${wrapDeg(m.syncAngle - start).toFixed(0)} off`,
  );
});

test('a matched machine may close; an unmatched one may not', () => {
  const { m, spec, env } = excited(['avr', 'govlinkage', 'isoch', 'parallel'], { bus: BUS });
  m.govMode = 'droop';

  // Far too fast: refused on slip.
  m.throttle = leverFor(63, spec);
  runFor(m, spec, env, 20);
  assert.equal(syncCheck(m, env).ok, false);

  // Creep it in and wait for the mark.
  m.throttle = leverFor(60.2, spec);
  runFor(m, spec, env, 15);
  let waited = 0;
  let closed = false;
  while (waited < 60 && !closed) {
    runFor(m, spec, env, 0.02);
    waited += 0.02;
    if (syncCheck(m, env).ok) closed = closeBreaker(m, spec, env).ok;
  }
  assert.ok(closed, 'should have found the mark within one revolution');
  assert.ok(m.synced);
  assert.ok(Math.abs(m.delta) < 20, `closed at ${m.delta.toFixed(0)} degrees`);
});

test('voltage must match the bus too, not just speed and phase', () => {
  const { m, spec, env } = excited(['avr', 'govlinkage', 'isoch', 'parallel'], { bus: BUS }, 1.45);
  m.govMode = 'droop';
  m.throttle = leverFor(60.2, spec);
  runFor(m, spec, env, 15);
  assert.ok(m.volts > 560, `field left high, ${m.volts.toFixed(0)} V`);

  // Wait until the needle is actually on the mark, so phase is not the thing
  // being complained about, and confirm the volts mismatch still blocks it.
  let checked = false;
  for (let i = 0; i < 40000 && !checked; i++) {
    step(m, spec, env, 0.005);
    if (Math.abs(wrapDeg(m.phase - m.busPhase)) < 5) {
      const chk = syncCheck(m, env);
      assert.equal(chk.ok, false);
      assert.match(chk.reason, /volts/i);
      checked = true;
    }
  }
  assert.ok(checked, 'never reached the phase window');
});

test('closing out of phase is violent and throws the set off line', () => {
  const { m, spec, env } = excited(['avr', 'govlinkage', 'isoch'], { bus: BUS });
  runFor(m, spec, env, 4);
  // Walk round to roughly antiphase.
  let guard = 0;
  while (Math.abs(wrapDeg(m.phase - m.busPhase)) < 168 && guard++ < 400000) {
    step(m, spec, env, 0.002);
  }
  const res = forceCloseBreaker(m, spec, env);
  assert.ok(res.shock, 'should report a shock');
  assert.ok(res.severity > 0.8, `severity ${res.severity}`);
  assert.ok(!m.breakerClosed, 'a bad close should throw the breaker straight back out');
  assert.ok(
    latchedRelays(m).includes('overCurrent'),
    `expected an overcurrent target, got ${latchedRelays(m).join(',') || 'none'}`,
  );
  // And it stays locked out until the board is walked.
  assert.equal(closeBreaker(m, spec, env).ok, false);
  simResetRelays(m);
  assert.ok(!anyRelayLatched(m));
});

test('the check-sync relay refuses the close instead of letting you break things', () => {
  const { m, spec, env } = excited(['avr', 'govlinkage', 'isoch', 'parallel'], { bus: BUS });
  m.govMode = 'droop';
  m.throttle = leverFor(62.5, spec);
  runFor(m, spec, env, 20);
  const res = closeBreaker(m, spec, env);
  assert.equal(res.ok, false);
  assert.ok(res.blocked, 'the relay should say it blocked it');
  assert.equal(m.breakerClosed, false);
  assert.ok(!anyRelayLatched(m), 'nothing should have operated');
});

// --------------------------------------------------------------- on a bus --

/** Synchronise and return the machine tied to the bus. */
function onBus(owned, { exc = 1.0, gov = 'droop' } = {}) {
  const { m, spec, env } = excited(owned, { bus: BUS }, exc);
  m.govMode = gov;
  m.throttle = leverFor(60.2, spec);
  runFor(m, spec, env, 15);
  let waited = 0;
  while (waited < 90 && !m.synced) {
    runFor(m, spec, env, 0.02);
    waited += 0.02;
    if (syncCheck(m, env).ok) closeBreaker(m, spec, env);
  }
  return { m, spec, env };
}

test('on a bus the frequency is the bus, whatever the throttle does', () => {
  const { m, spec, env } = onBus(['avr', 'govlinkage', 'isoch', 'parallel', 'synthoil', 'alloyblock', 'windings']);
  assert.ok(m.synced, 'should be synchronised');
  const base = leverFor(60, spec);
  for (const d of [0.02, 0.06, 0.10]) {
    m.throttle = base + d;
    runFor(m, spec, env, 20);
    assert.ok(m.synced, `fell off the bus at lever +${d}`);
    assert.ok(Math.abs(m.hz - BUS.hz) < 0.02, `lever +${d} moved frequency to ${m.hz}`);
  }
});

test('on a bus the throttle sets real power', () => {
  const { m, spec, env } = onBus(['avr', 'govlinkage', 'isoch', 'parallel', 'synthoil', 'alloyblock', 'windings']);
  const base = leverFor(60, spec);
  const seen = [];
  for (const d of [0.02, 0.06, 0.10]) {
    m.throttle = base + d;
    runFor(m, spec, env, 25);
    seen.push(m.deliveredKW);
  }
  assert.ok(m.synced, 'should still be on the bus');
  assert.ok(seen[0] < seen[1] && seen[1] < seen[2], `kW did not follow the throttle: ${seen.map((v) => v.toFixed(1))}`);
  assert.ok(seen[2] > 30, `expected real export, got ${seen[2].toFixed(1)} kW`);
});

test('on a bus the excitation sets reactive power, not voltage', () => {
  const { m, spec, env } = onBus(['avr', 'govlinkage', 'isoch', 'parallel', 'synthoil', 'alloyblock', 'windings']);
  m.throttle = leverFor(60, spec) + 0.06;
  runFor(m, spec, env, 25);
  const readings = [];
  for (const exc of [0.95, 1.25, 1.55]) {
    m.excCmd = exc;
    runFor(m, spec, env, 25);
    readings.push({ q: m.kvar, v: m.volts, p: m.deliveredKW });
  }
  assert.ok(
    readings[0].q < readings[1].q && readings[1].q < readings[2].q,
    `kVAr did not follow the field: ${readings.map((r) => r.q.toFixed(1))}`,
  );
  for (const r of readings) {
    assert.ok(Math.abs(r.v - BUS.volts) < 1, `volts moved to ${r.v} — the bus should hold them`);
  }
  const spread = Math.abs(readings[2].p - readings[0].p);
  assert.ok(spread < 12, `field should barely touch real power, moved ${spread.toFixed(1)} kW`);
});

test('overloading past pull-out slips a pole and trips off the bus', () => {
  const { m, spec, env } = onBus(['avr', 'govlinkage', 'isoch', 'parallel'], { gov: 'droop' });
  assert.ok(m.synced);
  // Wind the speed setting right up and the droop governor takes the rack to
  // its stop, driving the load angle past 90 degrees.
  m.throttle = 1;
  const events = runFor(m, spec, env, 40);
  assert.ok(events.some((e) => e.type === 'pole-slip'), 'expected a pole slip');
  assert.ok(!m.synced && !m.breakerClosed);
});
