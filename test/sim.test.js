import test from 'node:test';
import assert from 'node:assert/strict';
import {
  baseSpec, newMachine, defaultEnv, step, runFor, rpmToHz, hzToRpm,
  densityRatio, thermalDerate, closeBreaker, RATED_KW,
} from '../src/sim.js';
import { buildSpec } from '../src/tech.js';

/**
 * Bring a machine on line the way an operator actually would: crank it, close
 * the field breaker, wind on some excitation, then close the main breaker.
 * There is no shortcut -- without a field there are no volts to close onto.
 */
function running(owned = [], envOverrides = {}, load = 0, settleS = 900, opts = {}) {
  const spec = buildSpec(owned, baseSpec);
  const m = newMachine(spec);
  const env = { ...defaultEnv(), ...envOverrides };
  m.cranking = 6;
  // Start at idle, then bring it up to rated, the way you actually would.
  runFor(m, spec, env, 6);
  m.runMode = 'run';
  runFor(m, spec, env, 16);
  if (opts.gov) m.govMode = opts.gov;
  if (opts.throttle !== undefined) m.throttle = opts.throttle;
  m.fieldClosed = true;
  m.excCmd = opts.exc ?? 1.0;
  runFor(m, spec, env, 4);
  closeBreaker(m, spec, env);
  env.demandKW = load;
  // An operator stands there trimming the rheostat to hold nominal volts;
  // without that the machine simply trips out on over- or under-voltage.
  const slice = 0.5;
  for (let t = 0; t < settleS; t += slice) {
    runFor(m, spec, env, Math.min(slice, settleS - t));
    if (opts.exc === undefined) {
      m.excCmd = Math.max(0, Math.min(spec.excMax, m.excCmd + ((480 - m.volts) / 480) * 0.35));
    }
  }
  return { m, spec, env };
}

test('frequency maps to shaft speed on a 4-pole machine', () => {
  assert.equal(rpmToHz(1800), 60);
  assert.equal(hzToRpm(60), 1800);
  assert.equal(rpmToHz(1500), 50);
});

test('a stock set starts at idle and has to be brought up to speed', () => {
  const spec = baseSpec();
  const m = newMachine(spec);
  const env = defaultEnv();
  m.cranking = 6;
  runFor(m, spec, env, 10);
  assert.ok(m.running, 'engine should be running');
  assert.ok(m.rpm > 700 && m.rpm < 950, `should have settled at idle, got ${m.rpm.toFixed(0)}`);

  m.runMode = 'run';
  runFor(m, spec, env, 3);
  assert.ok(m.rpm < 1600, 'it should still be on its way up after three seconds');
  runFor(m, spec, env, 13);
  assert.ok(m.rpm > 1700 && m.rpm < 1900, `rpm was ${m.rpm}`);
});

test('the run-up is paced, not a wide-open dash to rated speed', () => {
  const spec = baseSpec();
  const m = newMachine(spec);
  const env = defaultEnv();
  m.cranking = 6;
  runFor(m, spec, env, 8);
  m.runMode = 'run';
  let peakRack = 0;
  let t = 0;
  while (m.rpm < 1790 && t < 40) {
    runFor(m, spec, env, 0.05);
    t += 0.05;
    peakRack = Math.max(peakRack, m.fuelCmd);
  }
  assert.ok(t > 4, `reached rated speed in only ${t.toFixed(1)} s`);
  assert.ok(peakRack < 0.75, `rack went to ${(peakRack * 100).toFixed(0)}% on the way up`);
});

test('cranking on an empty tank does not start the engine', () => {
  const spec = baseSpec();
  const m = newMachine(spec);
  m.fuelL = 0;
  m.cranking = 6;
  const events = runFor(m, spec, defaultEnv(), 10);
  assert.ok(!m.running);
  assert.ok(events.some((e) => e.type === 'no-fuel-start'));
});

test('fuel consumption at rated load is physically plausible', () => {
  const { m } = running([], {}, 75, 1800);
  // ~0.24-0.27 kg/kWh is the real range for a genset this size.
  const bsfc = (m.fuelLPerH * 0.832) / 75;
  assert.ok(bsfc > 0.2 && bsfc < 0.3, `BSFC was ${bsfc.toFixed(3)} kg/kWh`);
});

test('mechanical droop lets speed fall as load is added', () => {
  const light = running([], {}, 10, 900);
  const heavy = running([], {}, 70, 900);
  assert.ok(
    light.m.rpm > heavy.m.rpm + 20,
    `expected droop: ${light.m.rpm} vs ${heavy.m.rpm}`,
  );
  assert.ok(rpmToHz(light.m.rpm) > 60, 'unloaded set should run fast');
});

test('a hydraulic governor holds a far tighter line than a flyweight one', () => {
  const spread = (owned) => {
    const light = running(owned, {}, 10, 900);
    const heavy = running(owned, {}, 70, 900);
    return Math.abs(rpmToHz(light.m.rpm) - rpmToHz(heavy.m.rpm));
  };
  const stock = spread([]);
  const hydraulic = spread(['avr', 'govlinkage', 'isoch']);
  assert.ok(hydraulic < stock * 0.4, `droop spread ${hydraulic} vs ${stock} Hz`);
  assert.ok(hydraulic < 0.5, `hydraulic governor still drooped ${hydraulic} Hz`);
});

test('the alternator rating caps deliverable power', () => {
  const { m, spec } = running(['intake', 'turbo', 'intercooler'], {}, 200, 600);
  assert.ok(
    m.deliveredKW <= spec.altRatingKW + 0.01,
    `delivered ${m.deliveredKW} above rating ${spec.altRatingKW}`,
  );
});

test('sustained gross overload trips the breaker on under-frequency', () => {
  const spec = baseSpec();
  const m = newMachine(spec);
  const env = defaultEnv();
  m.cranking = 6;
  runFor(m, spec, env, 6);
  m.runMode = 'run';
  runFor(m, spec, env, 16);
  m.fieldClosed = true;
  m.excCmd = 1.0;
  runFor(m, spec, env, 4);
  closeBreaker(m, spec, env);
  env.demandKW = 400;
  const events = runFor(m, spec, env, 30);
  const trip = events.find((e) => e.type === 'relay-trip');
  assert.ok(trip, 'expected a protective relay to operate');
  assert.ok(!m.breakerClosed, 'the breaker should be out');
  assert.ok(
    trip.relays.some((r) => r === 'underFreq' || r === 'underVolt' || r === 'overCurrent'),
    `unexpected relays: ${trip.relays.join(',')}`,
  );
});

test('turbo lag: boost is low at light load and builds under fuelling', () => {
  const owned = ['intake', 'turbo', 'intercooler', 'synthoil', 'alloyblock', 'windings'];
  const { m, spec, env } = running(owned, {}, 20, 900);
  const boostLight = m.boost;
  assert.ok(boostLight < 0.3, `boost at light load was ${boostLight}`);

  env.demandKW = 95;
  runFor(m, spec, env, 12);
  assert.ok(m.boost > 0.8, `boost after loading was ${m.boost}`);
});

test('over-fuelling beyond available air produces smoke', () => {
  // A big step on a laggy compound turbo, before boost has arrived.
  const owned = ['intake', 'turbo', 'intercooler', 'compound', 'synthoil', 'alloyblock', 'windings', 'crank'];
  const { m, spec, env } = running(owned, {}, 15, 900);
  env.demandKW = spec.altRatingKW;
  let peakSmoke = 0;
  for (let i = 0; i < 400; i++) {
    step(m, spec, env, 0.005);
    peakSmoke = Math.max(peakSmoke, m.smoke);
  }
  assert.ok(peakSmoke > 0.02, `expected visible smoke, got ${peakSmoke}`);
});

test('variable-geometry turbo responds faster than a compound pair', () => {
  const vgt = buildSpec(['intake', 'turbo', 'intercooler', 'vgt'], baseSpec);
  const comp = buildSpec(['intake', 'turbo', 'intercooler', 'compound'], baseSpec);
  assert.ok(vgt.boostTau < comp.boostTau);
});

test('altitude and heat both derate a naturally aspirated engine', () => {
  assert.ok(densityRatio(2400, 20) < 0.8, 'thin air at altitude');
  assert.ok(densityRatio(0, 45) < densityRatio(0, 5), 'hot air is less dense');

  // Thin air means less of it per stroke, so the same load has to be made on a
  // richer mixture: the air/fuel ratio is the direct read-out of the derate.
  // 55 kW is comfortable at sea level and hard work at 2,400 m -- push it to
  // 70 and the thin air simply will not carry it at all.
  const sea = running([], {}, 55, 1200);
  const alp = running([], { altitudeM: 2400 }, 55, 1200);
  assert.ok(sea.m.breakerClosed && alp.m.breakerClosed, 'both should still be on load');
  assert.ok(
    alp.m.afr < sea.m.afr - 1,
    `altitude should richen the mixture: ${alp.m.afr.toFixed(1)} vs ${sea.m.afr.toFixed(1)}`,
  );
});

test('thermal derate pulls fuel back only when genuinely hot', () => {
  assert.equal(thermalDerate(90), 1);
  assert.ok(thermalDerate(110) < 1);
  assert.ok(thermalDerate(125) < thermalDerate(110));
});

test('a bigger radiator runs the engine cooler at the same load', () => {
  const stock = running([], {}, 70, 3600);
  const cooled = running(['radiator'], {}, 70, 3600);
  assert.ok(
    cooled.m.coolantC < stock.m.coolantC - 3,
    `${cooled.m.coolantC.toFixed(1)} vs ${stock.m.coolantC.toFixed(1)}`,
  );
});

test('running out of fuel stops the engine and opens the breaker', () => {
  const spec = baseSpec();
  const m = newMachine(spec);
  const env = { ...defaultEnv(), demandKW: 60 };
  m.cranking = 6;
  runFor(m, spec, env, 6);
  m.runMode = 'run';
  runFor(m, spec, env, 16);
  m.fieldClosed = true;
  m.excCmd = 1.0;
  runFor(m, spec, env, 4);
  closeBreaker(m, spec, env);
  m.fuelL = 0.05;
  const events = runFor(m, spec, env, 60);
  assert.ok(events.some((e) => e.type === 'out-of-fuel'));
  assert.ok(!m.running && !m.breakerClosed);
});

test('oil pressure follows engine speed and falls away as the oil heats', () => {
  const cold = running([], {}, 20, 30);
  const hot = running([], {}, 78, 5400);
  assert.ok(cold.m.oilBar > 2.5, `cold oil pressure was ${cold.m.oilBar}`);
  assert.ok(hot.m.oilBar < cold.m.oilBar, `${hot.m.oilBar} vs ${cold.m.oilBar}`);
  assert.ok(hot.m.oilBar > 1.0, 'a healthy engine should stay above the trip');
});

test('a better oil system holds the gauge up when hot', () => {
  const stock = running([], {}, 75, 5400);
  const better = running(['synthoil', 'radiator', 'oilcooler'], {}, 75, 5400);
  assert.ok(
    better.m.oilBar > stock.m.oilBar + 0.3,
    `${better.m.oilBar.toFixed(2)} vs ${stock.m.oilBar.toFixed(2)} bar`,
  );
});

test('exhaust temperature tracks load', () => {
  const light = running([], {}, 10, 900);
  const heavy = running([], {}, 75, 900);
  assert.ok(heavy.m.egtC > light.m.egtC + 150, `${light.m.egtC} -> ${heavy.m.egtC}`);
  assert.ok(heavy.m.egtC > 400 && heavy.m.egtC < 750, `EGT was ${heavy.m.egtC}`);
});

test('the kWh register integrates delivered energy', () => {
  const { m } = running([], {}, 60, 3600);
  assert.ok(Math.abs(m.kwhRegister - 60) < 6, `register read ${m.kwhRegister}`);
});

test('the battery buffer shaves peaks above the engine comfort zone', () => {
  const owned = ['avr', 'govlinkage', 'isoch', 'battery'];
  const { m } = running(owned, {}, RATED_KW * 0.95, 60);
  assert.ok(m.batteryFlowKW > 0, 'battery should be discharging into the peak');
  assert.ok(m.batterySoc < 1);
});

test('the simulation is deterministic', () => {
  const a = running(['intake', 'turbo'], {}, 55, 600);
  const b = running(['intake', 'turbo'], {}, 55, 600);
  assert.equal(a.m.rpm, b.m.rpm);
  assert.equal(a.m.fuelL, b.m.fuelL);
  assert.equal(a.m.wear, b.m.wear);
});

test('results do not depend on the fast-forward timestep', () => {
  // advance() picks dt in [0.005, 0.02] depending on speed. An isochronous
  // governor is the stiffest loop in the model, so if anything is going to go
  // unstable when the player hits 600x, it is this.
  const owned = ['intake', 'turbo', 'intercooler', 'avr', 'govlinkage',
    'synthoil', 'alloyblock', 'windings'];
  const results = [0.005, 0.01, 0.02].map((dt) => {
    const spec = buildSpec(owned, baseSpec);
    const m = newMachine(spec);
    const env = defaultEnv();
    m.cranking = 6;
    runFor(m, spec, env, 6, dt);
    m.runMode = 'run';
    runFor(m, spec, env, 16, dt);
    m.fieldClosed = true;
    m.excCmd = 1.25;
    runFor(m, spec, env, 4, dt);
    m.breakerClosed = true;
    env.demandKW = 70;
    runFor(m, spec, env, 1200, dt);
    return { hz: rpmToHz(m.rpm), fuel: m.fuelLPerH, temp: m.coolantC };
  });
  for (const r of results.slice(1)) {
    assert.ok(Math.abs(r.hz - results[0].hz) < 0.02, `frequency drifted: ${r.hz} vs ${results[0].hz}`);
    assert.ok(Math.abs(r.fuel - results[0].fuel) < 0.2, `fuel drifted: ${r.fuel} vs ${results[0].fuel}`);
    assert.ok(Math.abs(r.temp - results[0].temp) < 1.5, `temperature drifted: ${r.temp} vs ${results[0].temp}`);
  }
});
