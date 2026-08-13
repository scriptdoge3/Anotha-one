import test from 'node:test';
import assert from 'node:assert/strict';
import { baseSpec } from '../src/sim.js';
import { TECH, TECH_BY_ID, buildSpec, canResearch, lockedBy } from '../src/tech.js';
import {
  CONTRACTS, demandAt, peakDemand, meanDemand, newProgress, accrue, settle,
  estimateValue, availableContracts, missingCaps, TIER_REP, fillerContract,
} from '../src/contracts.js';
import {
  createGame, acceptContract, advance, startEngine, setBreaker, refuel,
  buyTech, board, setFieldBreaker, setExcitation,
} from '../src/state.js';

// ------------------------------------------------------------------ tech --

test('every tech node has unique id, valid branch and resolvable prerequisites', () => {
  const ids = new Set();
  const branches = new Set(['air', 'mech', 'thermal', 'control', 'compliance']);
  for (const t of TECH) {
    assert.ok(!ids.has(t.id), `duplicate id ${t.id}`);
    ids.add(t.id);
    assert.ok(branches.has(t.branch), `${t.id} has bad branch ${t.branch}`);
    assert.ok(t.cost > 0 && t.name && t.blurb && t.detail, `${t.id} incomplete`);
    for (const r of t.requires ?? []) {
      assert.ok(TECH_BY_ID[r], `${t.id} requires missing node ${r}`);
    }
    for (const e of t.excludes ?? []) {
      assert.ok(TECH_BY_ID[e], `${t.id} excludes missing node ${e}`);
    }
  }
});

test('prerequisites never point at a node in a later row', () => {
  for (const t of TECH) {
    for (const r of t.requires ?? []) {
      assert.ok(
        TECH_BY_ID[r].row < t.row,
        `${t.id} (row ${t.row}) requires ${r} (row ${TECH_BY_ID[r].row})`,
      );
    }
  }
});

test('exclusions are symmetric', () => {
  for (const t of TECH) {
    for (const e of t.excludes ?? []) {
      assert.ok(
        (TECH_BY_ID[e].excludes ?? []).includes(t.id),
        `${t.id} excludes ${e} but not vice versa`,
      );
    }
  }
});

test('taking one side of a fork locks the other out', () => {
  const owned = ['intake', 'turbo', 'intercooler', 'vgt'];
  assert.ok(lockedBy(owned).has('compound'));
  assert.equal(canResearch(TECH_BY_ID.compound, owned, 1e9).reason, 'locked');
});

test('prerequisites are enforced regardless of money', () => {
  assert.equal(canResearch(TECH_BY_ID.intercooler, [], 1e9).reason, 'requires');
  assert.equal(canResearch(TECH_BY_ID.turbo, ['intake'], 1).reason, 'money');
  assert.ok(canResearch(TECH_BY_ID.turbo, ['intake'], 1e9).ok);
});

test('spec assembly is order independent', () => {
  const a = buildSpec(['intake', 'turbo', 'synthoil', 'radiator'], baseSpec);
  const b = buildSpec(['radiator', 'synthoil', 'turbo', 'intake'], baseSpec);
  assert.deepEqual(a, b);
});

test('buildSpec never produces degenerate physics', () => {
  // Every reachable full build, both sides of the one fork.
  for (const skip of ['vgt', 'compound']) {
    const owned = TECH.filter((t) => t.id !== skip).map((t) => t.id);
    const s = buildSpec(owned, baseSpec);
    assert.ok(s.frictionA > 0, 'friction must stay positive');
    assert.ok(s.radiatorUA > 0);
    assert.ok(s.inertia > 0);
    assert.ok(s.boostTau > 0);
    assert.ok(s.coolantHeatFrac > 0 && s.coolantHeatFrac < 1);
    assert.ok(s.indicatedEff > 0 && s.indicatedEff < 0.6, `eff ${s.indicatedEff}`);
    assert.ok(s.altRatingKW > 0);
  }
});

test('every capability a contract asks for is grantable by some node', () => {
  const grantable = new Set();
  const full = buildSpec(TECH.map((t) => t.id), baseSpec);
  for (const c of full.capabilities) grantable.add(c);
  for (const c of CONTRACTS) {
    for (const req of c.requires ?? []) {
      assert.ok(grantable.has(req), `contract ${c.id} needs ungrantable "${req}"`);
    }
  }
});

// -------------------------------------------------------------- contracts --

test('contract definitions are well formed', () => {
  const ids = new Set();
  for (const c of CONTRACTS) {
    assert.ok(!ids.has(c.id), `duplicate contract ${c.id}`);
    ids.add(c.id);
    assert.ok(c.hours > 0 && c.payPerKWh > 0 && c.mobilization > 0, `${c.id} bad economics`);
    assert.ok(c.freqTolHz > 0 && c.voltTolPct > 0, `${c.id} missing tolerances`);
    assert.ok(TIER_REP[c.tier] !== undefined, `${c.id} bad tier`);
    assert.ok(c.brief && c.client && c.title, `${c.id} missing copy`);
  }
});

test('load profiles stay positive and finite across the whole job', () => {
  for (const c of [...CONTRACTS, fillerContract(7, 40)]) {
    for (let i = 0; i <= 200; i++) {
      const v = demandAt(c.profile, (c.hours * i) / 200);
      assert.ok(Number.isFinite(v) && v >= 0, `${c.id} produced ${v}`);
    }
    assert.ok(peakDemand(c.profile, c.hours) >= meanDemand(c.profile, c.hours));
  }
});

test('every contract is physically achievable by some legal build', () => {
  // Both fork branches, so no contract depends on an impossible combination.
  for (const skip of ['vgt', 'compound']) {
    const spec = buildSpec(TECH.filter((t) => t.id !== skip).map((t) => t.id), baseSpec);
    for (const c of CONTRACTS) {
      if ((c.requires ?? []).includes('hvo') && skip === 'compound') continue;
      const peak = peakDemand(c.profile, c.hours);
      assert.ok(
        peak <= spec.altRatingKW,
        `${c.id} peaks at ${peak.toFixed(0)} kW, above the best alternator ${spec.altRatingKW}`,
      );
    }
  }
});

test('contract tiers are gated by reputation and unlock in order', () => {
  const atZero = availableContracts(0, [], 1).filter((c) => !c.filler);
  assert.ok(atZero.every((c) => c.tier === 1));
  const atMax = availableContracts(100, [], 1).filter((c) => !c.filler);
  assert.ok(atMax.some((c) => c.tier === 5));
});

test('completed contracts return as lower-reputation repeat business', () => {
  const done = ['t1-barn'];
  const list = availableContracts(100, done, 1);
  const barn = list.find((c) => c.id === 't1-barn');
  assert.ok(barn, 'completed work should stay on the board');
  assert.ok(barn.repeat);
  assert.ok(barn.repGain < CONTRACTS.find((c) => c.id === 't1-barn').repGain);
});

test('missing capabilities are reported against the fitted spec', () => {
  const bare = buildSpec([], baseSpec);
  const film = CONTRACTS.find((c) => c.id === 't2-filmset');
  assert.deepEqual(missingCaps(film, bare), ['quiet']);
  const quiet = buildSpec(['canopy'], baseSpec);
  assert.deepEqual(missingCaps(film, quiet), []);
});

// -------------------------------------------------------------- settlement --

function fakeRun(contract, { perfect = true } = {}) {
  const p = newProgress(contract);
  const m = {
    deliveredKW: 0, thermalKW: 0, fuelLPerH: 10, coolantC: 90,
    breakerClosed: true, hz: 60, volts: 480, smoke: 0,
  };
  const dt = 60;
  const steps = Math.round((contract.hours * 3600) / dt);
  for (let i = 0; i < steps; i++) {
    const demand = demandAt(contract.profile, p.elapsedH);
    m.deliveredKW = perfect ? demand : 0;
    m.hz = perfect ? 60 : 54;
    accrue(p, contract, m, demand, dt);
  }
  return p;
}

test('a perfect run pays out, earns reputation and is flagged clean', () => {
  const c = CONTRACTS.find((x) => x.id === 't1-barn');
  const r = settle(fakeRun(c), c);
  assert.ok(r.clean, 'should be a clean run');
  assert.ok(!r.failed);
  assert.ok(r.total > c.mobilization, 'should beat the advance alone');
  assert.ok(r.repDelta > 0);
});

test('a total failure loses reputation but never more money than the job is worth', () => {
  for (const c of CONTRACTS) {
    const r = settle(fakeRun(c, { perfect: false }), c);
    assert.ok(r.failed, `${c.id} should be marked failed`);
    assert.ok(r.repDelta < 0);
    const cap = estimateValue(c);
    assert.ok(
      r.total >= -cap - c.mobilization - 1,
      `${c.id} lost ${r.total.toFixed(0)}, beyond the ${cap.toFixed(0)} liability cap`,
    );
  }
});

test('abandoning early withholds the mobilisation fee', () => {
  const c = CONTRACTS.find((x) => x.id === 't2-batching');
  const p = newProgress(c);
  p.elapsedH = c.hours * 0.4;
  p.energyKWh = 100;
  p.demandedKWh = 100;
  const r = settle(p, c);
  assert.ok(r.abandoned && r.failed);
  assert.ok(r.lines.some((l) => l.amount === -c.mobilization));
});

// ---------------------------------------------------------------- career --

test('a new career starts solvent, unqualified and idle', () => {
  const g = createGame();
  assert.ok(g.money > 0);
  assert.equal(g.reputation, 0);
  assert.equal(g.job, null);
  assert.equal(g.owned.length, 0);
  assert.ok(!g.machine.running);
});

test('accepting a contract advances the mobilisation fee immediately', () => {
  const g = createGame();
  const before = g.money;
  const c = board(g).find((x) => x.id === 't1-barn');
  assert.ok(acceptContract(g, c.id).ok);
  assert.equal(g.money, before + c.mobilization);
});

test('you cannot take work your machine does not qualify for', () => {
  const g = createGame();
  g.reputation = 100;
  const r = acceptContract(g, 't2-filmset');
  assert.equal(r.ok, false);
});

test('upgrades cannot be fitted mid-job', () => {
  const g = createGame();
  g.money = 50000;
  acceptContract(g, 't1-barn');
  const r = buyTech(g, 'synthoil');
  assert.equal(r.ok, false);
  assert.ok(!g.owned.includes('synthoil'));
});

test('a competently run tier-1 job turns a profit end to end', () => {
  const g = createGame();
  const startMoney = g.money;
  assert.ok(acceptContract(g, 't1-barn').ok);

  // A competent operator: crank, close the field breaker, bring the volts up,
  // close the main breaker, then keep trimming the field as load changes --
  // there is no AVR fitted on a stock set.
  const trimField = () => {
    const err = (480 - g.machine.volts) / 480;
    if (Math.abs(err) > 0.008) setExcitation(g, g.machine.excCmd + err * 0.6);
  };

  startEngine(g);
  advance(g, 12);
  setFieldBreaker(g, true);
  for (let i = 0; i < 12; i++) { advance(g, 1); trimField(); }
  setBreaker(g, true);

  let guard = 0;
  let worstVolts = 0;
  while (g.job && !g.job.done && guard++ < 6000) {
    if (g.machine.fuelL / g.spec.tankL < 0.2) refuel(g);
    if (!g.machine.running) { startEngine(g); advance(g, 12); setFieldBreaker(g, true); advance(g, 4); }
    if (g.machine.running && !g.machine.breakerClosed) setBreaker(g, true);
    trimField();
    advance(g, 20);
    // Ignore the step at breaker close; what matters is the sustained trim.
    if (g.machine.breakerClosed && g.job && !g.job.done && g.job.progress.elapsedH > 0.05) {
      worstVolts = Math.max(worstVolts, Math.abs(g.machine.volts - 480) / 480);
    }
  }
  assert.ok(g.job?.done, 'job should have completed');
  const r = g.job.result;
  assert.ok(!r.failed, 'a well-run barn job should not fail');
  assert.ok(
    worstVolts < 0.06,
    `hand-trimmed voltage drifted ${(worstVolts * 100).toFixed(1)}% off nominal`,
  );
  assert.ok(
    g.job.progress.voltViolSec < 180,
    `spent ${(g.job.progress.voltViolSec / 60).toFixed(1)} min outside the voltage clause`,
  );
  assert.ok(g.money > startMoney, `money went ${startMoney} -> ${g.money}`);
  assert.ok(g.reputation > 0);
  assert.ok(g.machine.hours > 7, 'should have logged engine hours');
});

test('leaving the field untrimmed trips the machine off on over-voltage', () => {
  // The same job, run by someone who set the rheostat once and walked away.
  // On a stock set there is nothing to catch that but the relays.
  const g = createGame();
  assert.ok(acceptContract(g, 't1-barn').ok);
  startEngine(g);
  advance(g, 12);
  setFieldBreaker(g, true);
  setExcitation(g, 1.45);
  advance(g, 6);
  setBreaker(g, true);
  let guard = 0;
  while (g.job && !g.job.done && guard++ < 6000) advance(g, 20);
  assert.ok(g.job?.done);
  assert.ok(
    g.machine.relays.overVolt,
    'an untrimmed field should have thrown the over-voltage relay',
  );
  assert.ok(g.job.progress.outageSec > 600, 'and left the site without supply');
});

test('the balance never goes negative on settlement', () => {
  const g = createGame();
  g.money = 0;
  g.reputation = 100;
  acceptContract(g, 't4-hospital');
  // Never start the engine: a total failure on the most punitive contract.
  let guard = 0;
  while (g.job && !g.job.done && guard++ < 40000) advance(g, 120);
  assert.ok(g.money >= 0, `money was ${g.money}`);
});
