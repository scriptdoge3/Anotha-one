/**
 * Drives the control desk through the browser exactly as a player would:
 * crank, close the field breaker, trim the volts on the rheostat, close the
 * main breaker, then synchronise onto a live bus using the synchroscope.
 *
 * Needs `npm i` and a running `npm start`.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const OUT = process.env.SMOKE_OUT ?? '/tmp/loadbank-operator';
await mkdir(OUT, { recursive: true });
const BASE = process.env.SMOKE_URL ?? 'http://localhost:8080/';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

const read = () => page.evaluate(() => {
  const g = window.game();
  const m = g.machine;
  return {
    running: m.running, field: m.fieldClosed, brk: m.breakerClosed, synced: m.synced,
    hz: +(m.hz ?? 0).toFixed(2), v: Math.round(m.volts ?? 0), kw: +(m.deliveredKW ?? 0).toFixed(1),
    kvar: +(m.kvar ?? 0).toFixed(1), pf: +(m.pf ?? 1).toFixed(3), afr: +(m.afr ?? 0).toFixed(1),
    exc: +(m.exc ?? 0).toFixed(2), gov: m.govMode, excMode: m.excMode,
    slip: +(m.slipHz ?? 0).toFixed(3), scope: Math.round(m.syncAngle ?? 0), delta: +(m.delta ?? 0).toFixed(1),
    droop: +(m.droopSet ?? 0).toFixed(4), relays: (Object.entries(m.relays||{}).filter(([,v])=>v).map(([k])=>k).join(',') || 'none'),
  };
});
const set = (what, v) => page.evaluate(([w, val]) => {
  const g = window.game();
  if (w === 'throttle') g.machine.throttle = val; else g.machine.excCmd = val;
}, [what, v]);

// ---------------------------------------------------------------- island --
console.log('--- island job: manual start and hand voltage control ---');
await page.click('[data-tab="contracts"]');
await page.waitForTimeout(200);
await page.click('[data-accept="t1-barn"]');
await page.waitForTimeout(300);

await page.click('[data-act="start"]');
await page.waitForTimeout(1200);
console.log('cranked      ', JSON.stringify(await read()));

await page.click('[data-act="field"]');
await page.waitForTimeout(900);
console.log('field closed ', JSON.stringify(await read()));

await page.click('[data-act="close"]');
await page.waitForTimeout(1500);
console.log('on load      ', JSON.stringify(await read()));

// Trim the field by hand until the voltmeter reads nominal.
for (let i = 0; i < 40; i++) {
  const s = await read();
  if (Math.abs(s.v - 480) < 6) break;
  await set('exc', await page.evaluate(() => window.game().machine.excCmd) + (480 - s.v) / 480 * 0.5);
  await page.waitForTimeout(120);
}
console.log('field trimmed', JSON.stringify(await read()));
await page.screenshot({ path: `${OUT}/01-island.png`, fullPage: true });

// Exercise the nudge switches and the governor selector.
await page.click('[data-nudge="throttle"][data-step="0.004"]');
await page.waitForTimeout(200);
await page.click('[data-gov="manual"]');
await page.waitForTimeout(400);
const manual = await read();
console.log('manual rack  ', JSON.stringify(manual));
await page.click('[data-gov="droop"]');
await page.waitForTimeout(400);

// ------------------------------------------------------------------ bus --
console.log('\n--- bus job: synchronise on the scope ---');
// Shut down properly before moving to the next job.
await page.click('[data-act="trip"]');
await page.waitForTimeout(200);
await page.click('[data-act="field"]');
await page.waitForTimeout(200);
await page.click('[data-act="stop"]');
await page.waitForTimeout(400);

await page.evaluate(() => {
  const g = window.game();
  g.job = null;
  g.reputation = 100;
  g.money = 500000;
  for (const id of ['avr', 'govlinkage', 'isoch', 'parallel']) if (!g.owned.includes(id)) g.owned.push(id);
  window.__refresh();
});
await page.waitForTimeout(300);
await page.click('[data-tab="contracts"]');
await page.waitForTimeout(300);
await page.click('[data-accept="t3-gridexport"]');
await page.waitForTimeout(400);

const hasScope = await page.locator('.scope-svg').count();
console.log('synchroscope on the desk:', hasScope > 0);

await page.click('[data-act="start"]');
await page.waitForTimeout(1200);
await page.click('[data-act="field"]');
await page.waitForTimeout(400);
await page.click('[data-gov="droop"]');
await page.waitForTimeout(1500);

// Set the machine a touch fast so the needle creeps round to the mark.
// Set the governor droop first, then the speed, allowing for that droop.
await page.evaluate(() => {
  const g = window.game();
  g.machine.droopSet = 0.03;
  const droop = Math.min(0.06, Math.max(g.spec.droopMin, g.machine.droopSet));
  const rpm = ((60.25 / 60) * 1800) / (1 + droop);
  g.machine.throttle = Math.max(0, Math.min(1, (rpm - 1740) / 120));
});
await page.waitForTimeout(1500);
// Match the bus volts as well as its speed -- the check-sync relay wants both.
for (let i = 0; i < 40; i++) {
  const s = await read();
  if (Math.abs(s.v - 480) < 12) break;
  await set('exc', await page.evaluate(() => window.game().machine.excCmd) + (480 - s.v) / 480 * 0.5);
  await page.waitForTimeout(120);
}
console.log('matching     ', JSON.stringify(await read()));
console.log('sync message :', await page.textContent('[data-sync="msg"]'));
await page.screenshot({ path: `${OUT}/02-synchroscope.png`, fullPage: true });

// Wait for the sync lamp, then close — the way you actually would.
let closed = false;
for (let i = 0; i < 200 && !closed; i++) {
  const ready = await page.evaluate(() => {
    const b = document.querySelector('[data-act="close"]');
    return b && !b.disabled;
  });
  if (ready) { await page.click('[data-act="close"]'); closed = true; }
  else await page.waitForTimeout(100);
}
await page.waitForTimeout(800);
const onBus = await read();
console.log('closed       ', JSON.stringify(onBus));

// On the bus: throttle should move kW, field should move kVAr.
const sweep = [];
const base = await page.evaluate(() => window.game().machine.throttle);
for (const d of [0.0, 0.05, 0.10]) {
  await set('throttle', base + d);
  await page.waitForTimeout(900);
  const s = await read();
  sweep.push(`+${d.toFixed(2)} -> ${s.kw} kW @ ${s.hz} Hz`);
}
console.log('throttle sweep:', sweep.join(' | '));

// Back off the load before sweeping the field: hold 70+ kW on a 92 kW machine
// and winding the field DOWN will drag it past pull-out, which is correct but
// not what we are measuring here.
await set('throttle', await page.evaluate(() => window.game().machine.throttle) - 0.05);
await page.waitForTimeout(1200);
const qs = [];
for (const e of [1.0, 1.3, 1.6]) {
  await set('exc', e);
  await page.waitForTimeout(900);
  const s = await read();
  qs.push(`exc ${e} -> ${s.kvar} kVAr, ${s.v} V, pf ${s.pf}`);
}
console.log('field sweep:   ', qs.join(' | '));
await page.screenshot({ path: `${OUT}/03-on-bus.png`, fullPage: true });

await browser.close();
if (errors.length) {
  console.error('\nERRORS:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('\nno console/page errors');
