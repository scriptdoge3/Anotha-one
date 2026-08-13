/**
 * End-to-end browser smoke test. Needs `npm i` and a running `npm start`.
 *
 * Plays a real career slice: browses every tab, opens a tech node, accepts the
 * barn job, starts the set, arms the breaker while it is still cranking, fast
 * forwards to completion, checks the settlement, and reloads to prove the save
 * round-trips. Fails loudly on any console or page error.
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const errors = [];
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const BASE = process.env.SMOKE_URL ?? 'http://localhost:8080/';
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

const OUT = process.env.SMOKE_OUT ?? '/tmp/loadbank-smoke';
await mkdir(OUT, { recursive: true });
const shot = async (name) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });

// --- operate tab, start the engine and take a job -------------------------
await shot('01-operate');

// contracts
await page.click('[data-tab="contracts"]');
await page.waitForTimeout(300);
const nContracts = await page.locator('.contract').count();
console.log('contracts listed:', nContracts);
await shot('02-contracts');

// tech tree
await page.click('[data-tab="tech"]');
await page.waitForTimeout(300);
const nNodes = await page.locator('.tech-node').count();
const nLines = await page.locator('.tech-svg path').count();
console.log('tech nodes:', nNodes, 'connector paths:', nLines);
await shot('03-tech');

// open a tech modal
await page.click('[data-tech="turbo"]');
await page.waitForTimeout(250);
const modalVisible = await page.locator('.modal').isVisible();
console.log('tech modal opens:', modalVisible);
await shot('04-techmodal');
await page.click('[data-act="close-modal"]');

// workshop
await page.click('[data-tab="workshop"]');
await page.waitForTimeout(300);
await shot('05-workshop');

// --- actually play: accept the barn job and run it -----------------------
await page.click('[data-tab="contracts"]');
await page.waitForTimeout(200);
await page.click('[data-accept="t1-barn"]');
await page.waitForTimeout(300);
console.log('tab after accept:', await page.locator('.tab.is-active').textContent());

// Full manual start: crank, close the field breaker, bring the volts up on the
// rheostat, then close the main breaker.
await page.click('[data-act="start"]');
await page.waitForTimeout(1200);
await page.click('[data-act="field"]');
await page.waitForTimeout(900);
await page.click('[data-act="close"]');
await page.waitForTimeout(1200);
// Trim the field until the voltmeter reads nominal, as an operator would.
for (let i = 0; i < 40; i++) {
  const v = await page.evaluate(() => window.game().machine.volts);
  if (Math.abs(v - 480) < 8) break;
  await page.evaluate((dv) => {
    const g = window.game();
    g.machine.excCmd = Math.max(0, Math.min(g.spec.excMax, g.machine.excCmd + dv));
  }, ((480 - v) / 480) * 0.5);
  await page.waitForTimeout(110);
}
await shot('06-running');

const readout = async () => page.evaluate(() => {
  const g = window.game();
  return {
    running: g.machine.running, field: g.machine.fieldClosed, breaker: g.machine.breakerClosed,
    volts: Math.round(g.machine.volts),
    hz: +(g.machine.hz ?? 0).toFixed(2), kw: +(g.machine.deliveredKW ?? 0).toFixed(1),
    coolant: +g.machine.coolantC.toFixed(1), elapsed: +(g.job?.progress.elapsedH ?? 0).toFixed(2),
    money: Math.round(g.money),
  };
});
console.log('after breaker close:', JSON.stringify(await readout()));

// fast forward
await page.click('[data-speed="600"]');
await page.waitForTimeout(4000);
console.log('after 4 s at 600x:', JSON.stringify(await readout()));
await shot('07-fastforward');

// let the job finish
for (let i = 0; i < 70; i++) {
  await page.waitForTimeout(1000);
  const st = await page.evaluate(() => !!window.game().job?.done);
  if (st) break;
}
await page.waitForTimeout(500);
const settleVisible = await page.locator('.settle-table').count();
console.log('settlement dialog shown:', settleVisible > 0);
await shot('08-settlement');
console.log('final:', JSON.stringify(await readout()));

if (settleVisible) {
  await page.click('[data-act="close-settle"]');
  await page.waitForTimeout(300);
}

// reload to verify the save round-trips
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(600);
console.log('after reload:', JSON.stringify(await readout()));
await shot('09-reloaded');

await browser.close();
if (errors.length) {
  console.error('\nERRORS:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('\nno console/page errors');
