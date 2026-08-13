/**
 * Renders every tab at phone and tablet sizes and reports any horizontal
 * overflow of the page body. The APK is the primary target, so the layout has
 * to hold up at 360 px before it ships.
 */
import { chromium, devices } from 'playwright';
import { mkdir } from 'node:fs/promises';

const OUT = process.env.SMOKE_OUT ?? '/tmp/loadbank-mobile';
await mkdir(OUT, { recursive: true });

const sizes = [
  ['phone-portrait', 360, 740],
  ['phone-landscape', 740, 360],
  ['tablet', 800, 1180],
];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
let problems = 0;

for (const [name, width, height] of sizes) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(process.env.SMOKE_URL ?? 'http://localhost:8080/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  // Get a job running so the docket and meters have live content.
  await page.click('[data-tab="contracts"]');
  await page.waitForTimeout(200);
  await page.click('[data-accept="t1-barn"]');
  await page.waitForTimeout(200);
  await page.click('[data-act="start"]');
  await page.click('[data-act="breaker"]');
  await page.waitForTimeout(1800);

  for (const tab of ['operate', 'contracts', 'tech', 'workshop']) {
    await page.click(`[data-tab="${tab}"]`);
    await page.waitForTimeout(350);
    const m = await page.evaluate(() => ({
      docW: document.documentElement.scrollWidth,
      winW: window.innerWidth,
      // The tech tree is meant to scroll sideways inside its own frame;
      // the page body itself must never scroll horizontally.
      bodyOverflow: document.body.scrollWidth - window.innerWidth,
    }));
    const bad = m.bodyOverflow > 2;
    if (bad) problems++;
    console.log(
      `${name.padEnd(16)} ${tab.padEnd(10)} body ${String(m.bodyOverflow).padStart(5)}px ${bad ? 'OVERFLOW' : 'ok'}`,
    );
    await page.screenshot({ path: `${OUT}/${name}-${tab}.png`, fullPage: false });
  }
  if (errs.length) { console.log(`  page errors: ${errs.join(' | ')}`); problems++; }
  await ctx.close();
}

await browser.close();
console.log(problems ? `\n${problems} layout problem(s)` : '\nno layout problems');
process.exit(problems ? 1 : 0);
