import test from 'node:test';
import assert from 'node:assert/strict';
import {
  baseSpec, newMachine, defaultEnv, step, runFor, rpmToHz, hzToRpm,
  densityRatio, thermalDerate, RATED_KW,
} from '../src/sim.js';
import { buildSpec } from '../src/tech.js';

/** Start a machine and settle it at a given load. */
function running(owned = [], envOverrides = {}, load = 0, settleS = 900) {
  const spec = buildSpec(owned, baseSpec);
  const m = newMachine(spec);
  const env = { ...defaultEnv(), ...envOverrides };
  m.cranking = 6;
  runFor(m, spec, env, 10);
  m.breakerClosed = true;
  env.demandKW = load;
  runFor(m, spec, env, settleS);
  return { m, spec, env };
}

test('frequency maps to shaft speed on a 4-pole machine', () => {
  assert.equal(rpmToHz(1800), 60);
  assert.equal(hzToRpm(60), 1800);
  assert.equal(rpmToHz(1500), 50);
});

test('a stock set starts and reaches nominal speed', () => {
  const { m } = running([], {}, 0, 20);
  assert.ok(m.running, 'engine should be running');
  assert.ok(m.rpm > 1700 && m.rpm < 1900, `rpm was ${m.rpm}`);
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

test('an isochronous governor holds 60.0 Hz at any load', () => {
  for (const load of [10, 45, 75]) {
    const { m } = running(['avr', 'govlinkage', 'isoch'], {}, load, 900);
    assert.ok(
      Math.abs(rpmToHz(m.rpm) - 60) < 0.1,
      `load ${load} kW settled at ${rpmToHz(m.rpm).toFixed(2)} Hz`,
    );
  }
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
  runFor(m, spec, env, 10);
  m.breakerClosed = true;
  env.demandKW = 400;
  const events = runFor(m, spec, env, 30);
  assert.ok(events.some((e) => e.type === 'trip'), 'expected an under-frequency trip');
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

  const sea = running([], {}, 70, 1200);
  const alp = running([], { altitudeM: 2400 }, 70, 1200);
  assert.ok(
    alp.m.smoke > sea.m.smoke || alp.m.rpm < sea.m.rpm,
    'the same load should be harder at altitude',
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
  runFor(m, spec, env, 10);
  m.breakerClosed = true;
  m.fuelL = 0.05;
  const events = runFor(m, spec, env, 60);
  assert.ok(events.some((e) => e.type === 'out-of-fuel'));
  assert.ok(!m.running && !m.breakerClosed);
});

test('wear accumulates faster under heavy load than light', () => {
  const light = running([], {}, 15, 3600);
  const heavy = running([], {}, 78, 3600);
  assert.ok(heavy.m.wear > light.m.wear, `${heavy.m.wear} vs ${light.m.wear}`);
});

test('durability upgrades measurably slow wear', () => {
  const stock = running([], {}, 70, 7200);
  const tough = running(['synthoil', 'crank', 'liners'], {}, 70, 7200);
  assert.ok(tough.m.wear < stock.m.wear * 0.75, `${tough.m.wear} vs ${stock.m.wear}`);
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
  const owned = ['intake', 'turbo', 'intercooler', 'avr', 'govlinkage', 'isoch',
    'synthoil', 'alloyblock', 'windings'];
  const results = [0.005, 0.01, 0.02].map((dt) => {
    const spec = buildSpec(owned, baseSpec);
    const m = newMachine(spec);
    const env = defaultEnv();
    m.cranking = 6;
    runFor(m, spec, env, 10, dt);
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
