/**
 * Rendering. Every panel is a pure function of game state -> HTML string,
 * with delegated click handling keyed off data attributes, so there is never
 * a stale listener bound to a node that has been replaced.
 */

import { money, num, duration, escapeHtml, dayStamp, dateStamp } from './format.js';
import { RATED_KW, rpmToHz, densityRatio, baseSpec, AFR_SMOKE_LIMIT, NOMINAL_V, speedSetpoint, SYNC_LIMITS, latchedRelays, anyRelayLatched, governorDroop } from './sim.js';
import { TECH, BRANCHES, TECH_BY_ID, canResearch, lockedBy, buildSpec } from './tech.js';
import {
  demandAt, peakDemand, meanDemand, profileLabel, capLabel,
  missingCaps, estimateValue, TIER_REP,
} from './contracts.js';
import { SPEEDS, TANK_UPGRADE, fuelPrice, board, specFor, syncState, envFor, RELAY_LABELS, relayLabel } from './state.js';

// ------------------------------------------------------------------ topbar

export function renderTop(g) {
  const m = g.machine;
  const repTier = [5, 4, 3, 2, 1].find((t) => g.reputation >= TIER_REP[t]) ?? 1;
  const cell = (label, value, cls = '') =>
    `<div class="stat"><span class="stat-label">${label}</span><span class="stat-value ${cls}">${value}</span></div>`;
  return [
    cell('Account', money(g.money), g.money < 500 ? 'warn' : 'good'),
    cell('Standing', `${g.reputation} <span style="font-size:9px;opacity:.65">T${repTier}</span>`),
    cell('Date', dateStamp(g.day)),
    cell('Run Hrs', num(m.hours, 0)),
    cell('kWh', num(m.kwhRegister ?? 0, 0)),
    cell('Fuel', `£${fuelPrice(g).toFixed(2)}`),
  ].join('');
}

/**
 * The Operate panel is the only view that changes every frame, so it is built
 * once and then patched in place. Re-rendering its innerHTML each tick would
 * detach the buttons mid-click and destroy the trace canvas 60 times a second.
 *
 * `meterSpecs` and `lampSpecs` are the single source of truth for both the
 * initial build and the per-frame update, so the two can never drift apart.
 */

// ---- moving-coil meter geometry -------------------------------------------
// A panel meter of the period sweeps about 110 degrees, pivoting below the
// dial. Everything below is in the SVG's own 168x112 coordinate space.

const M_W = 168, M_H = 104;
const PIVOT_X = 84, PIVOT_Y = 92;
const R_SCALE = 68;          // radius of the graduation arc
const R_NEEDLE = 61;
const SWEEP = 55;            // degrees either side of vertical

/** Point on the dial at `deg` from vertical (clockwise positive). */
function dialPt(r, deg) {
  const a = (deg * Math.PI) / 180;
  return [PIVOT_X + r * Math.sin(a), PIVOT_Y - r * Math.cos(a)];
}

const fracToDeg = (f) => -SWEEP + 2 * SWEEP * clamp01(f);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Arc path along the dial between two fractions of full scale. */
function dialArc(f0, f1, r) {
  const [x0, y0] = dialPt(r, fracToDeg(f0));
  const [x1, y1] = dialPt(r, fracToDeg(f1));
  return `M${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 0 1 ${x1.toFixed(2)},${y1.toFixed(2)}`;
}

/**
 * Build one meter. `bands` paints coloured sectors on the scale (the red
 * danger zone, the green tolerance band), exactly as a real dial is printed.
 */
function meterSvg(s) {
  const ticks = [];
  const majors = s.majors ?? 5;
  const minors = majors * 4;
  for (let i = 0; i <= minors; i++) {
    const f = i / minors;
    const major = i % 4 === 0;
    const [xa, ya] = dialPt(R_SCALE, fracToDeg(f));
    const [xb, yb] = dialPt(R_SCALE - (major ? 9 : 5), fracToDeg(f));
    ticks.push(
      `<line x1="${xa.toFixed(2)}" y1="${ya.toFixed(2)}" x2="${xb.toFixed(2)}" y2="${yb.toFixed(2)}"
        stroke="#2a241c" stroke-width="${major ? 1.5 : 0.7}" />`,
    );
    if (major) {
      const [xt, yt] = dialPt(R_SCALE - 19, fracToDeg(f));
      const edge = xt < 16 ? 'start' : xt > M_W - 16 ? 'end' : 'middle';
      const val = s.min + (s.max - s.min) * f;
      ticks.push(
        `<text x="${xt.toFixed(2)}" y="${(yt + 3.4).toFixed(2)}" text-anchor="${edge}"
          font-family="Jost, sans-serif" font-size="9.5" fill="#2a241c">${
            Math.abs(val) >= 100 ? val.toFixed(0) : val.toFixed(s.tickDp ?? 0)
          }</text>`,
      );
    }
  }

  const bands = (s.bands ?? [])
    .map((b) => `<path d="${dialArc(b.from, b.to, R_SCALE + 3.5)}" stroke="${b.color}"
      stroke-width="4.5" fill="none" stroke-linecap="butt" />`)
    .join('');

  return `<svg viewBox="0 0 ${M_W} ${M_H}" role="img" aria-label="${s.label}">
    <defs>
      <linearGradient id="face-${s.key}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#f6f0dd"/><stop offset="1" stop-color="#ded5bb"/>
      </linearGradient>
      <radialGradient id="glass-${s.key}" cx="0.3" cy="0.12" r="0.9">
        <stop offset="0" stop-color="#ffffff" stop-opacity="0.4"/>
        <stop offset="0.45" stop-color="#ffffff" stop-opacity="0.05"/>
        <stop offset="1" stop-color="#000000" stop-opacity="0.12"/>
      </radialGradient>
    </defs>
    <rect x="1" y="1" width="${M_W - 2}" height="${M_H - 2}" rx="3" fill="url(#face-${s.key})" stroke="#8d8878"/>
    ${bands}
    ${ticks.join('')}
    <text x="${PIVOT_X}" y="80" text-anchor="middle" font-family="Jost, sans-serif"
      font-size="9" letter-spacing="1.6" fill="#7a7160">${s.unit ?? ''}</text>
    <g data-needle transform="rotate(${fracToDeg(0)} ${PIVOT_X} ${PIVOT_Y})">
      <line x1="${PIVOT_X}" y1="${PIVOT_Y}" x2="${PIVOT_X}" y2="${PIVOT_Y - R_NEEDLE}"
        stroke="#1d1812" stroke-width="1.9" stroke-linecap="round"/>
      <line x1="${PIVOT_X}" y1="${PIVOT_Y}" x2="${PIVOT_X}" y2="${PIVOT_Y + 7}"
        stroke="#1d1812" stroke-width="3.4" stroke-linecap="round"/>
    </g>
    <circle cx="${PIVOT_X}" cy="${PIVOT_Y}" r="5.5" fill="#2b241c"/>
    <circle cx="${PIVOT_X}" cy="${PIVOT_Y}" r="2.2" fill="#8d8878"/>
    <rect x="1" y="1" width="${M_W - 2}" height="${M_H - 2}" rx="3" fill="url(#glass-${s.key})"/>
  </svg>`;
}

const RED = '#8e2a1c';
const GREEN = '#4a7a3a';
const AMBER = '#b3831a';

function meterSpecs(g) {
  const m = g.machine;
  const spec = g.spec;
  const job = g.job;
  const hz = m.hz ?? 0;
  const demand = job && !job.done ? demandAt(job.contract.profile, job.progress.elapsedH) : 0;
  const tol = job && !job.done ? job.contract.freqTolHz : 2;
  const hzErr = Math.abs(hz - 60);
  const fuelPct = (m.fuelL / spec.tankL) * 100;
  const endurance = m.fuelLPerH > 0.2 ? m.fuelL / m.fuelLPerH : Infinity;
  const voltTol = job && !job.done ? job.contract.voltTolPct : 10;
  const kwMax = Math.ceil(spec.altRatingKW / 20) * 20;

  const out = [
    {
      key: 'hz', label: 'Frequency', unit: 'HERTZ',
      min: 55, max: 65, majors: 5, value: hz,
      display: `${num(hz, 2)} Hz`,
      sub: `${num(m.rpm, 0)} rpm · tol ±${num(tol, 2)}`,
      bands: [
        { from: 0, to: 0.2, color: RED },
        { from: (60 - tol - 55) / 10, to: (60 + tol - 55) / 10, color: GREEN },
        { from: 0.85, to: 1, color: RED },
      ],
      state: !m.running ? '' : hzErr > tol ? 'alarm' : hzErr > tol * 0.6 ? 'warn' : '',
    },
    {
      key: 'kw', label: 'Output', unit: 'KILOWATT',
      min: 0, max: kwMax, majors: 5, value: m.deliveredKW,
      display: `${num(m.deliveredKW, 1)} kW`,
      sub: `demand ${num(demand, 1)}${m.shedKW > 0.5 ? ` · SHED ${num(m.shedKW, 1)}` : ''}`,
      bands: [{ from: RATED_KW / kwMax, to: 1, color: AMBER }],
      state: m.shedKW > 0.5 ? 'alarm' : m.deliveredKW > RATED_KW ? 'warn' : '',
    },
    {
      key: 'v', label: 'Voltage', unit: 'VOLTS',
      min: 400, max: 560, majors: 4, value: m.volts,
      display: `${num(m.volts, 0)} V`,
      sub: `nominal 480 · ${num(((m.volts - 480) / 480) * 100, 1)}%`,
      bands: [{ from: (480 * (1 - voltTol / 100) - 400) / 160, to: (480 * (1 + voltTol / 100) - 400) / 160, color: GREEN }],
      state: m.running && Math.abs(m.volts - 480) / 480 > voltTol / 100 ? 'alarm' : '',
    },
    {
      key: 'temp', label: 'Coolant', unit: 'DEG C',
      min: 0, max: 130, majors: 5, value: m.coolantC,
      display: `${num(m.coolantC, 1)} °C`,
      sub: m.coolantC > 103 ? 'DERATING' : `fan ${num((m.fanCmd ?? 1) * 100, 0)}%`,
      bands: [{ from: 105 / 130, to: 1, color: RED }],
      state: m.coolantC > 110 ? 'alarm' : m.coolantC > 100 ? 'warn' : '',
    },
    {
      key: 'fuel', label: 'Fuel', unit: 'LITRES',
      min: 0, max: spec.tankL, majors: 4, value: m.fuelL,
      display: `${num(m.fuelL, 0)} L`,
      sub: `${num(m.fuelLPerH, 1)} L/h · ${duration(endurance)}`,
      bands: [{ from: 0, to: 0.12, color: RED }],
      state: fuelPct < 8 ? 'alarm' : fuelPct < 20 ? 'warn' : '',
    },
    spec.boostGain > 0
      ? {
          key: 'boost', label: 'Boost', unit: 'PER CENT',
          min: 0, max: 100, majors: 4, value: m.boost * 100,
          display: `${num(m.boost * 100, 0)}%`,
          sub: `rack ${num(m.fuelCmd * 100, 0)}% · τ ${num(spec.boostTau, 2)}s`,
          state: '',
        }
      : {
          key: 'boost', label: 'Fuel Rack', unit: 'PER CENT',
          min: 0, max: 100, majors: 4, value: m.fuelCmd * 100,
          display: `${num(m.fuelCmd * 100, 0)}%`,
          sub: 'naturally aspirated',
          state: '',
        },
    {
      key: 'afr', label: 'Air / Fuel', unit: 'RATIO : 1',
      min: 10, max: 90, majors: 4, value: clamp01((m.afr - 10) / 80) * 80 + 10,
      display: `${m.afr >= 89 ? '90+' : num(m.afr, 1)}:1`,
      sub: m.afr < AFR_SMOKE_LIMIT ? 'RICH — sooting' : m.afr < 22 ? 'near smoke limit' : 'lean',
      bands: [{ from: 0, to: (AFR_SMOKE_LIMIT - 10) / 80, color: RED }],
      state: m.afr < AFR_SMOKE_LIMIT ? 'alarm' : m.afr < 20 ? 'warn' : '',
    },
    {
      key: 'smoke', label: 'Opacity', unit: 'PER CENT',
      min: 0, max: 100, majors: 4, value: m.smoke * 100,
      display: `${num(m.smoke * 100, 0)}%`,
      sub: m.smoke > 0.08 ? 'over-fuelling' : 'clean',
      bands: [{ from: 0.4, to: 1, color: RED }],
      state: m.smoke > 0.3 ? 'alarm' : m.smoke > 0.08 ? 'warn' : '',
    },
    {
      key: 'amps', label: 'Line Current', unit: 'AMPERES',
      min: 0, max: Math.ceil(((spec.altRatingKW * 1000) / (Math.sqrt(3) * NOMINAL_V * 0.8)) / 50) * 50 + 50,
      majors: 4, value: m.amps ?? 0,
      display: `${num(m.amps ?? 0, 0)} A`,
      sub: `pf ${num(m.pf ?? 1, 2)}`,
      state: '',
    },
    {
      key: 'oil', label: 'Oil Pressure', unit: 'BAR',
      min: 0, max: 6, majors: 6, value: m.oilBar ?? 0, tickDp: 0,
      display: `${num(m.oilBar ?? 0, 1)} bar`,
      sub: !m.running ? 'engine stopped' : (m.oilBar ?? 0) < 1.4 ? 'LOW — trip at 1.0' : 'normal',
      bands: [{ from: 0, to: 1 / 6, color: RED }],
      state: m.running && (m.oilBar ?? 0) < 1.0 ? 'alarm' : m.running && (m.oilBar ?? 0) < 1.6 ? 'warn' : '',
    },
  ];

  if (spec.fullInstruments) {
    out.push({
      key: 'egt', label: 'Exhaust Temp', unit: 'DEG C',
      min: 0, max: 800, majors: 4, value: m.egtC ?? 20,
      display: `${num(m.egtC ?? 20, 0)} °C`,
      sub: (m.egtC ?? 0) > 620 ? 'HOT — ease the load' : 'normal',
      bands: [{ from: 620 / 800, to: 1, color: RED }],
      state: (m.egtC ?? 0) > 680 ? 'alarm' : (m.egtC ?? 0) > 620 ? 'warn' : '',
    });
  }
  if (spec.batteryKWh > 0) {
    out.push({
      key: 'batt', label: 'Battery', unit: 'PER CENT',
      min: 0, max: 100, majors: 4, value: m.batterySoc * 100,
      display: `${num(m.batterySoc * 100, 0)}%`,
      sub: `${m.batteryFlowKW > 0 ? 'disch ' : m.batteryFlowKW < 0 ? 'chg ' : 'idle '}${num(Math.abs(m.batteryFlowKW), 1)} kW`,
      bands: [{ from: 0, to: 0.15, color: RED }],
      state: '',
    });
  }
  if (job && !job.done && job.contract.bus) {
    const q = m.kvar ?? 0;
    const pfMin = job.contract.pfMin ?? 0.85;
    out.push({
      key: 'kvar', label: 'Reactive', unit: 'KILOVAR',
      min: -60, max: 60, majors: 4, value: q,
      display: `${num(q, 0)} kVAr`,
      sub: `pf ${num(m.pf ?? 1, 3)}${(m.pf ?? 1) < pfMin ? ' — LOW' : ''}`,
      bands: [{ from: 0, to: 0.16, color: RED }, { from: 0.84, to: 1, color: RED }],
      state: m.synced && (m.pf ?? 1) < pfMin ? 'alarm' : '',
    });
  }
  for (const s of out) s.frac = clamp01((s.value - s.min) / (s.max - s.min));
  return out;
}

/**
 * Needle dynamics. A moving-coil movement is a damped second-order system: it
 * swings past the mark and settles back. Simulating that rather than snapping
 * the needle is most of what makes the panel feel like hardware.
 */
const needles = new Map();
const NEEDLE_W = 21;     // natural frequency, rad/s
const NEEDLE_ZETA = 0.62; // under-damped, so it overshoots a little

function needleAngle(key, targetDeg, dt) {
  let s = needles.get(key);
  if (!s) { s = { v: targetDeg, dv: 0 }; needles.set(key, s); }
  // Sub-step so a long frame cannot make the movement explode.
  let t = Math.min(dt, 0.1);
  while (t > 0) {
    const h = Math.min(t, 1 / 120);
    s.dv += (NEEDLE_W * NEEDLE_W * (targetDeg - s.v) - 2 * NEEDLE_ZETA * NEEDLE_W * s.dv) * h;
    s.v += s.dv * h;
    t -= h;
  }
  return s.v;
}

function lampSpecs(g) {
  const m = g.machine;
  const spec = g.spec;
  const fuelPct = (m.fuelL / spec.tankL) * 100;
  const lamps = [
    { key: 'run', label: 'Running', on: m.running, color: 'green' },
    { key: 'load', label: 'On Load', on: m.breakerClosed, color: 'green' },
    { key: 'crank', label: 'Cranking', on: m.cranking > 0, color: 'amber' },
    { key: 'temp', label: 'Over Temp', on: m.coolantC > 105, color: 'red' },
    { key: 'over', label: 'Load Shed', on: m.shedKW > 0.5, color: 'red' },
    { key: 'lowfuel', label: 'Low Fuel', on: fuelPct < 20, color: 'amber' },
    { key: 'oilamp', label: 'Oil Press', on: m.running && (m.oilBar ?? 0) < 1.6, color: 'red' },
    { key: 'relay', label: 'Relay Target', on: anyRelayLatched(m), color: 'red' },
  ];
  if (spec.capabilities.includes('dpf')) {
    lamps.push({ key: 'dpf', label: `Filter ${num(m.dpfLoad * 100, 0)}%`, on: m.dpfLoad > 0.7, color: 'amber' });
  }
  return lamps;
}

/**
 * Structural signature. When this changes the panel is rebuilt; otherwise it is
 * only patched. It covers everything that changes the *shape* of the panel or
 * the printed scale of a meter, rather than the value on it.
 */
export function operateSignature(g) {
  const spec = g.spec;
  return [
    g.job ? g.job.contract.id : 'none',
    g.job?.done ? 'done' : 'live',
    spec.batteryKWh > 0,
    spec.boostGain > 0,
    spec.capabilities.includes('dpf'),
    !!g.job?.contract.thermalPayPerKWh,
    spec.altRatingKW,      // redraws the kW scale
    spec.tankL,            // redraws the fuel scale
    spec.fullInstruments,  // adds the pyrometer and oil gauge
    !!g.job?.contract.bus, // brings out the synchroscope and the kVAr meter
  ].join('|');
}


/**
 * The synchroscope. The needle sits at the phase difference between your
 * machine and the bus, so it rotates once per beat of slip: clockwise when you
 * are running fast, anticlockwise when slow. You close at the mark, with the
 * needle creeping slowly clockwise -- that way the machine picks up load as it
 * comes into step instead of being motored by the bus.
 */
function synchroscopeSvg() {
  const R = 62, CX = 76, CY = 76;
  const ticks = [];
  for (let d = 0; d < 360; d += 10) {
    const major = d % 30 === 0;
    const a = (d * Math.PI) / 180;
    const r0 = R, r1 = R - (major ? 9 : 5);
    ticks.push(`<line x1="${(CX + r0 * Math.sin(a)).toFixed(1)}" y1="${(CY - r0 * Math.cos(a)).toFixed(1)}"
      x2="${(CX + r1 * Math.sin(a)).toFixed(1)}" y2="${(CY - r1 * Math.cos(a)).toFixed(1)}"
      stroke="#2a241c" stroke-width="${major ? 1.4 : 0.7}"/>`);
  }
  // The window in which the check-sync relay will let you close.
  const w = SYNC_LIMITS.angleMax;
  const aw = (w * Math.PI) / 180;
  const arc = `M${(CX + (R + 4) * Math.sin(-aw)).toFixed(1)},${(CY - (R + 4) * Math.cos(-aw)).toFixed(1)}
    A${R + 4},${R + 4} 0 0 1 ${(CX + (R + 4) * Math.sin(aw)).toFixed(1)},${(CY - (R + 4) * Math.cos(aw)).toFixed(1)}`;
  return `<svg viewBox="0 0 152 152" class="scope-svg" role="img" aria-label="Synchroscope">
    <defs>
      <radialGradient id="scopeglass" cx="0.32" cy="0.14" r="0.9">
        <stop offset="0" stop-color="#fff" stop-opacity="0.36"/>
        <stop offset="0.5" stop-color="#fff" stop-opacity="0.04"/>
        <stop offset="1" stop-color="#000" stop-opacity="0.16"/>
      </radialGradient>
    </defs>
    <circle cx="${CX}" cy="${CY}" r="${R + 12}" fill="#201b16" stroke="#6d6960"/>
    <circle cx="${CX}" cy="${CY}" r="${R + 6}" fill="#f4eeda" stroke="#8d8878"/>
    <path d="${arc}" fill="none" stroke="#4a7a3a" stroke-width="5"/>
    ${ticks.join('')}
    <text x="${CX}" y="26" text-anchor="middle" font-family="Jost, sans-serif" font-size="9"
      letter-spacing="1.2" fill="#2f6b28">SYNC</text>
    <text x="20" y="80" text-anchor="middle" font-family="Jost, sans-serif" font-size="8.5"
      letter-spacing="1" fill="#6b6252">SLOW</text>
    <text x="132" y="80" text-anchor="middle" font-family="Jost, sans-serif" font-size="8.5"
      letter-spacing="1" fill="#6b6252">FAST</text>
    <g data-scope-needle transform="rotate(0 ${CX} ${CY})">
      <line x1="${CX}" y1="${CY}" x2="${CX}" y2="${CY - R + 4}" stroke="#8e2a1c" stroke-width="2.4" stroke-linecap="round"/>
      <line x1="${CX}" y1="${CY}" x2="${CX}" y2="${CY + 16}" stroke="#2b241c" stroke-width="3" stroke-linecap="round"/>
    </g>
    <circle cx="${CX}" cy="${CY}" r="5.5" fill="#2b241c"/>
    <circle cx="${CX}" cy="${CY}" r="${R + 6}" fill="url(#scopeglass)"/>
  </svg>`;
}

function renderSyncPanel(g) {
  return `<div class="card">
    <div class="card-head"><span class="card-title">Synchroscope</span>
      <span class="faint mono" style="font-size:9.5px" data-sync="slip"></span></div>
    <div class="card-body">
      <div class="scope-wrap">
        ${synchroscopeSvg()}
        <div class="scope-side">
          <div class="scope-row"><span class="scope-k">Incoming</span><span class="scope-v" data-sync="mhz"></span></div>
          <div class="scope-row"><span class="scope-k">Bus</span><span class="scope-v" data-sync="bhz"></span></div>
          <div class="scope-row"><span class="scope-k">Volts</span><span class="scope-v" data-sync="mv"></span></div>
          <div class="scope-row"><span class="scope-k">Bus volts</span><span class="scope-v" data-sync="bv"></span></div>
          <div class="lamp" data-lamp="sync" style="width:auto;flex-direction:row;gap:7px;margin-top:8px">
            <span class="lamp-dot"></span><span class="lamp-label" data-f="label">Sync</span>
          </div>
        </div>
      </div>
      <div class="sync-msg" data-sync="msg"></div>
    </div>
  </div>`;
}

export function renderOperate(g) {
  const meters = meterSpecs(g)
    .map((s) => `<div class="meter" data-meter="${s.key}">
        ${meterSvg(s)}
        <div class="meter-plate">${s.label}<span class="meter-read" data-f="read">${s.display}</span></div>
        <div class="meter-sub" data-f="sub">${s.sub ?? ''}</div>
      </div>`)
    .join('');

  const lamps = lampSpecs(g)
    .map((l) => `<div class="lamp ${l.on ? `on ${l.color}` : ''}" data-lamp="${l.key}">
        <span class="lamp-dot"></span><span class="lamp-label" data-f="label">${l.label}</span>
      </div>`)
    .join('');

  const speedBtns = SPEEDS.map(
    (s) => `<button class="speed-btn" data-speed="${s}">${s === 0 ? 'HOLD' : `${s}×`}</button>`,
  ).join('');

  return `
  <div class="operate-grid">
    <div class="stack">
      <div class="card">
        <div class="card-head">
          <span class="card-title">Control Desk</span>
          <div class="speed-group" data-speeds>${speedBtns}</div>
        </div>
        <div class="card-body stack">
          <div class="desk">

            <div class="ctl-group">
              <div class="ctl-legend">Engine</div>
              <div class="ctl-row">
                <button class="btn btn-sm" data-act="start">Start</button>
                <button class="btn btn-sm" data-act="stop">Stop</button>
              </div>
              <div class="mode-switch" data-modes="run">
                <button data-run="idle">Idle</button>
                <button data-run="run">Rated</button>
              </div>
              <div class="ctl-row"><button class="btn btn-sm" data-act="refuel">Refuel</button></div>
              <div class="ctl-read" data-f="engineRead">—</div>
            </div>

            <div class="ctl-group">
              <div class="ctl-legend">Governor</div>
              <div class="mode-switch" data-modes="gov">
                <button data-gov="manual">Hand Rack</button>
                <button data-gov="droop">Governor</button>
              </div>
              <div class="lever-row">
                <button class="nudge" data-nudge="throttle" data-step="-0.004">▼</button>
                <input class="lever" type="range" min="0" max="1" step="0.001" data-lever="throttle"
                  value="${g.machine.throttle}" aria-label="Speed setting" />
                <button class="nudge" data-nudge="throttle" data-step="0.004">▲</button>
              </div>
              <div class="droop-row">
                <span class="droop-label">Droop</span>
                <button class="nudge" data-nudge="droop" data-step="-0.0025">−</button>
                <span class="droop-val" data-f="droopRead">—</span>
                <button class="nudge" data-nudge="droop" data-step="0.0025">+</button>
              </div>
              <div class="ctl-read" data-f="govRead">—</div>
            </div>

            <div class="ctl-group">
              <div class="ctl-legend">Field Rheostat</div>
              <div class="ctl-row">
                <button class="btn btn-sm" data-act="field">Field</button>
              </div>
              <div class="lever-row">
                <button class="nudge" data-nudge="exc" data-step="-0.01">▼</button>
                <input class="lever" type="range" min="0" max="${g.spec.excMax}" step="0.005" data-lever="exc"
                  value="${g.machine.excCmd}" aria-label="Field rheostat" />
                <button class="nudge" data-nudge="exc" data-step="0.01">▲</button>
              </div>
              <div class="ctl-read" data-f="excRead">—</div>
            </div>

            <div class="ctl-group">
              <div class="ctl-legend">Breaker Control</div>
              <div class="ctl-row">
                <button class="btn btn-sm btn-danger" data-act="trip">Trip</button>
                <button class="btn btn-sm" data-act="close">Close</button>
              </div>
              <div class="ctl-row" data-f="forcerow">
                <button class="btn btn-sm btn-danger" data-act="force-close">Force Close</button>
              </div>
              <div class="ctl-read" data-f="brkRead">—</div>
            </div>

          </div>
          <div class="lamp-row">${lamps}</div>
          <div class="relay-board">
            <div class="relay-legend">Protective Relays</div>
            <div class="relay-flags">
              ${Object.keys(RELAY_LABELS)
                .map((k) => `<span class="relay-flag" data-relay="${k}">${RELAY_LABELS[k]}</span>`)
                .join('')}
            </div>
            <button class="btn btn-sm" data-act="reset-relays">Reset Board</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><span class="card-title">Instrument Bank</span></div>
        <div class="card-body"><div class="meter-grid">${meters}</div></div>
      </div>

      <div class="card">
        <div class="card-head">
          <span class="card-title">Chart Recorder</span>
          <span class="faint mono" style="font-size:9.5px">60 SEC</span>
        </div>
        <div class="card-body"><div class="trace-window"><canvas class="trace" id="trace"></canvas></div></div>
      </div>
    </div>

    <div class="stack">
      ${g.job && !g.job.done && g.job.contract.bus ? renderSyncPanel(g) : ''}
      ${renderJobCard(g)}
      <div class="card">
        <div class="card-head"><span class="card-title">Day Log</span></div>
        <div class="card-body"><div class="log" data-log></div></div>
      </div>
    </div>
  </div>`;
}

/** Per-frame patch. Touches only attributes and text, never structure. */
export function updateOperate(g, root, dt = 1 / 60) {
  if (!root) return;
  const m = g.machine;

  for (const s of meterSpecs(g)) {
    const node = root.querySelector(`[data-meter="${s.key}"]`);
    if (!node) continue;
    const needle = node.querySelector('[data-needle]');
    if (needle) {
      const a = needleAngle(s.key, fracToDeg(s.frac), dt);
      needle.setAttribute('transform', `rotate(${a.toFixed(2)} ${PIVOT_X} ${PIVOT_Y})`);
    }
    const read = node.querySelector('[data-f="read"]');
    if (read && read.textContent !== s.display) read.textContent = s.display;
    const sub = node.querySelector('[data-f="sub"]');
    if (sub && sub.textContent !== (s.sub ?? '')) sub.textContent = s.sub ?? '';
    node.classList.toggle('is-alarm', s.state === 'alarm');
    node.classList.toggle('is-warn', s.state === 'warn');
  }

  for (const l of lampSpecs(g)) {
    const node = root.querySelector(`[data-lamp="${l.key}"]`);
    if (!node) continue;
    const cls = `lamp ${l.on ? `on ${l.color}` : ''}`;
    if (node.className !== cls) node.className = cls;
    const label = node.querySelector('[data-f="label"]');
    if (label && label.textContent !== l.label) label.textContent = l.label;
  }

  // Buttons: toggling `disabled` and text keeps the element itself alive, so a
  // click already in flight still lands.
  const setBtn = (sel, { disabled, text, cls }) => {
    const b = root.querySelector(sel);
    if (!b) return;
    if (b.disabled !== disabled) b.disabled = disabled;
    if (text !== undefined && b.textContent !== text) b.textContent = text;
    if (cls !== undefined && b.className !== cls) b.className = cls;
  };
  setBtn('[data-act="start"]', {
    disabled: m.running || m.cranking > 0,
    cls: `btn ${m.running || m.cranking > 0 ? '' : 'btn-primary'}`,
  });
  setBtn('[data-act="stop"]', { disabled: !m.running });
  setBtn('[data-act="breaker"]', {
    disabled: !m.running && m.cranking <= 0,
    text: m.breakerClosed ? 'Open Breaker' : 'Close Breaker',
    cls: `btn ${m.breakerClosed ? 'btn-danger' : ''}`,
  });

  for (const b of root.querySelectorAll('[data-speeds] .speed-btn')) {
    b.classList.toggle('is-active', Number(b.dataset.speed) === g.speed);
  }

  // ---- control desk ----------------------------------------------------
  const spec = g.spec;
  const env = envFor(g);
  const bus = env.bus;
  const setText = (sel, text) => {
    const n = root.querySelector(sel);
    if (n && n.textContent !== text) n.textContent = text;
  };

  for (const b of root.querySelectorAll('[data-modes="gov"] button')) {
    b.classList.toggle('is-on', b.dataset.gov === m.govMode);
  }
  for (const b of root.querySelectorAll('[data-modes="run"] button')) {
    b.classList.toggle('is-on', b.dataset.run === m.runMode);
  }

  // Levers are the operator's hand: only write back when they are not holding
  // it, otherwise the value fights the drag.
  const lever = (sel, value) => {
    const el = root.querySelector(sel);
    if (!el || el.dataset.dragging === '1') return;
    const v = String(value);
    if (el.value !== v && document.activeElement !== el) el.value = v;
  };
  lever('[data-lever="throttle"]', m.throttle.toFixed(3));
  lever('[data-lever="exc"]', m.excCmd.toFixed(3));

  setText('[data-f="engineRead"]',
    m.running
      ? `${num(m.rpm, 0)} rpm${Math.abs(m.rpm - m.speedRef) > 25 ? ' · coming up' : ''}`
      : m.cranking > 0 ? 'cranking' : 'stopped');

  const rackPct = `${num(m.fuelCmd * 100, 0)}% rack`;
  setText('[data-f="govRead"]',
    m.govMode === 'manual'
      ? `${num(m.throttle * 100, 1)}% lever · ${rackPct}`
      : `set ${num(speedSetpoint(m.throttle), 0)} rpm · ${rackPct}`);

  setText('[data-f="droopRead"]', `${num(governorDroop(m, spec) * 100, 2)}%`);

  setText('[data-f="excRead"]',
    !m.fieldClosed ? 'field open' : `${num(m.excCmd, 2)} pu set · ${num(m.exc, 2)} actual`);

  const sync = syncState(g);
  const locked = anyRelayLatched(m);
  setText('[data-f="brkRead"]',
    m.breakerClosed
      ? (m.synced ? `on bus · ${num(m.delta, 0)}°` : 'closed on load')
      : locked ? 'relay target standing'
      : sync.ok ? 'ready to close' : (sync.reason ?? 'not ready'));

  setBtn('[data-act="field"]', {
    disabled: !m.running && m.cranking <= 0,
    text: m.fieldClosed ? 'Field Off' : 'Field On',
    cls: `btn btn-sm ${m.fieldClosed ? 'btn-danger' : ''}`,
  });
  setBtn('[data-act="trip"]', { disabled: !m.breakerClosed });
  setBtn('[data-act="close"]', {
    disabled: m.breakerClosed || locked || !sync.ok,
    cls: `btn btn-sm ${!m.breakerClosed && sync.ok && !locked ? 'btn-primary' : ''}`,
  });
  const forceRow = root.querySelector('[data-f="forcerow"]');
  if (forceRow) {
    const show = !!bus && !m.breakerClosed && !sync.ok && !locked && !spec.checkSync && m.running;
    forceRow.style.display = show ? '' : 'none';
  }

  // Relay targets: latched flags that have to be reset by hand.
  const standing = new Set(latchedRelays(m));
  for (const el of root.querySelectorAll('[data-relay]')) {
    el.classList.toggle('is-out', standing.has(el.dataset.relay));
  }
  setBtn('[data-act="reset-relays"]', {
    disabled: standing.size === 0,
    cls: `btn btn-sm ${standing.size ? 'btn-primary' : ''}`,
  });

  // ---- synchroscope ----------------------------------------------------
  if (bus) {
    const needle = root.querySelector('[data-scope-needle]');
    if (needle) {
      // No damping here: a synchroscope needle follows the phase difference
      // exactly, and it must be able to spin right round.
      needle.setAttribute('transform', `rotate(${(m.syncAngle ?? 0).toFixed(1)} 76 76)`);
    }
    const slip = m.slipHz ?? 0;
    setText('[data-sync="slip"]',
      `${slip >= 0 ? '+' : ''}${slip.toFixed(2)} Hz${Math.abs(slip) > 0.004 ? ` · ${(1 / Math.abs(slip)).toFixed(0)}s/rev` : ' · stopped'}`);
    setText('[data-sync="mhz"]', `${num(m.synced ? bus.hz : rpmToHz(m.rpm), 2)} Hz`);
    setText('[data-sync="bhz"]', `${num(bus.hz, 2)} Hz`);
    setText('[data-sync="mv"]', `${num(m.volts, 0)} V`);
    setText('[data-sync="bv"]', `${num(bus.volts, 0)} V`);
    setText('[data-sync="msg"]',
      m.synced ? `Tied to the bus at ${num(m.delta, 0)}° load angle.` : (sync.ok ? 'Matched — close now.' : sync.reason));
    const lampEl = root.querySelector('[data-lamp="sync"]');
    if (lampEl) {
      const on = m.synced || sync.ok;
      const cls = `lamp ${on ? 'on green' : ''}`;
      if (lampEl.className !== cls) lampEl.className = cls;
      const lbl = lampEl.querySelector('[data-f="label"]');
      const txt = m.synced ? 'On Bus' : sync.ok ? 'Sync' : 'Not Matched';
      if (lbl && lbl.textContent !== txt) lbl.textContent = txt;
    }
  }

  const job = g.job;
  if (job && !job.done) {
    const { contract: c, progress: p } = job;
    const pctDone = Math.min(100, (p.elapsedH / c.hours) * 100);
    // Early in a job the ratio is dominated by the seconds before you closed
    // the breaker, so hold it back until there is enough energy to mean anything.
    const supplySettled = p.demandedKWh > 2;
    const supply = supplySettled ? (p.energyKWh / p.demandedKWh) * 100 : 0;
    const set = (key, text, cls) => {
      const n = root.querySelector(`[data-job="${key}"]`);
      if (!n) return;
      if (n.textContent !== text) n.textContent = text;
      if (cls !== undefined) n.className = `kv-value ${cls}`;
    };
    const fill = root.querySelector('[data-job="fill"]');
    if (fill) fill.style.width = `${pctDone}%`;
    set('elapsed', `${duration(p.elapsedH)} / ${duration(c.hours)}`);
    set('pctdone', `${num(pctDone, 0)}%`);
    set('energy', `${num(p.energyKWh, 0)} kWh`);
    set('supply', supplySettled ? `${num(supply, 1)}%` : '—',
      !supplySettled ? '' : supply < 98 ? 'bad' : 'good');
    set('outage', `${num(p.outageSec / 60, 1)} min`, p.outageSec > 30 ? 'bad' : '');
    set('freq', `${num(p.freqViolSec / 60, 1)} min`, p.freqViolSec > 60 ? 'bad' : '');
    set('volt', `${num(p.voltViolSec / 60, 1)} min`, p.voltViolSec > 60 ? 'bad' : '');
    set('trips', String(p.tripCount), p.tripCount ? 'bad' : '');
    set('fuelused', `${num(p.fuelUsedL, 0)} L`);
    set('thermal', `${num(p.thermalKWh, 0)} kWh`);
  }

  const logEl = root.querySelector('[data-log]');
  if (logEl && Number(logEl.dataset.len || -1) !== g.log.length) {
    logEl.dataset.len = String(g.log.length);
    logEl.innerHTML =
      g.log
        .map((l) => `<div class="log-line ${l.kind}"><span class="log-day">${escapeHtml(dayStamp(l.day))}</span><span class="log-text">${escapeHtml(l.text)}</span></div>`)
        .join('') || '<div class="faint">Nothing yet.</div>';
  }
}

function renderJobCard(g) {
  const job = g.job;
  if (!job) {
    return `<div class="card"><div class="card-head"><span class="card-title">Job Docket</span></div>
      <div class="card-body"><div class="empty-note">No job on the books.<br />Take one from the contracts board.</div></div></div>`;
  }
  const { contract: c } = job;
  const kv = (key, label) =>
    `<div><div class="kv-label">${label}</div><div class="kv-value" data-job="${key}">—</div></div>`;

  return `<div class="card">
    <div class="card-head"><span class="card-title">Job Docket</span>
      <button class="btn btn-sm btn-danger" data-act="abandon">Abandon</button></div>
    <div class="card-body stack">
      <div>
        <div class="job-title">${escapeHtml(c.title)}</div>
        <div class="job-client">${escapeHtml(c.client)}</div>
        <div class="progress-track"><div class="progress-fill" data-job="fill" style="width:0%"></div></div>
        <div class="row" style="justify-content:space-between">
          <span class="faint mono" style="font-size:10.5px" data-job="elapsed"></span>
          <span class="faint mono" style="font-size:10.5px" data-job="pctdone"></span>
        </div>
      </div>
      <div class="kv-grid">
        ${kv('energy', 'Delivered')}
        ${kv('supply', 'Supply Met')}
        ${kv('outage', 'Shortfall')}
        ${kv('freq', 'Freq Faults')}
        ${kv('volt', 'Volt Faults')}
        ${kv('trips', 'Trips')}
        ${kv('fuelused', 'Fuel Used')}
        ${c.thermalPayPerKWh ? kv('thermal', 'Heat Sold') : ''}
      </div>
      <div class="chip-row">
        <span class="chip">±${num(c.freqTolHz, 2)} Hz</span>
        <span class="chip">±${c.voltTolPct}% V</span>
        <span class="chip">${c.ambientC ?? 20} °C</span>
        ${c.altitudeM ? `<span class="chip warn">${c.altitudeM} m</span>` : ''}
        ${c.abrasion > 1 ? `<span class="chip warn">abrasive ×${c.abrasion}</span>` : ''}
        ${c.critical ? '<span class="chip req-miss">critical load</span>' : ''}
      </div>
    </div>
  </div>`;
}

// --------------------------------------------------------------- contracts

function sparkline(profile, hours, w = 300, h = 40) {
  const n = 120;
  const vals = [];
  for (let i = 0; i <= n; i++) vals.push(demandAt(profile, (hours * i) / n));
  const max = Math.max(...vals, 1) * 1.12;
  const pts = vals
    .map((v, i) => `${(i / n) * w},${h - (v / max) * (h - 4) - 2}`)
    .join(' ');
  const ratedY = h - (RATED_KW / max) * (h - 4) - 2;
  return `<svg class="profile-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    ${ratedY > 0 && ratedY < h ? `<line x1="0" y1="${ratedY}" x2="${w}" y2="${ratedY}" stroke="rgba(0,0,0,0.42)" stroke-width="1" stroke-dasharray="4 3" vector-effect="non-scaling-stroke"/>` : ''}
    <polyline points="${pts}" fill="none" stroke="#8e2a1c" stroke-width="1.6" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

export function renderContracts(g) {
  const list = board(g);
  const spec = g.spec;

  if (g.job && !g.job.done) {
    return `<div class="card"><div class="card-body">
      <div class="empty-note">You have a job on: <strong>${escapeHtml(g.job.contract.title)}</strong>.<br />
      <span class="faint">Finish or abandon it before taking more work.</span></div>
    </div></div>`;
  }

  const cards = list.map((c) => {
    const missing = missingCaps(c, spec);
    const peak = peakDemand(c.profile, c.hours);
    const mean = meanDemand(c.profile, c.hours);
    const overCapacity = peak > spec.altRatingKW;
    const locked = missing.length > 0;

    // Rough fuel estimate so the player can judge working capital.
    const approxLPerH = (mean / RATED_KW) * 22 * (spec.fuel === 'hvo' ? 1.07 : 1);
    const fuelCost = approxLPerH * c.hours * fuelPrice(g);
    const gross = estimateValue(c);

    const reqChips = (c.requires ?? [])
      .map((r) => `<span class="chip ${spec.capabilities.includes(r) ? 'req-ok' : 'req-miss'}">${capLabel(r)}</span>`)
      .join('');

    return `<div class="contract ${locked ? 'is-locked' : ''} ${c.critical ? 'is-critical' : ''}">
      <div class="contract-top">
        <div>
          <div class="contract-title">${escapeHtml(c.title)}</div>
          <div class="contract-client">${escapeHtml(c.client)}</div>
        </div>
        <span class="tier-chip">${c.filler ? 'Filler' : `Tier ${c.tier}`}</span>
      </div>
      <div class="contract-brief">${escapeHtml(c.brief)}</div>
      ${sparkline(c.profile, c.hours)}
      <div class="chip-row">
        <span class="chip">${profileLabel(c.profile)}</span>
        <span class="chip ${overCapacity ? 'req-miss' : ''}">peak ${num(peak, 0)} kW</span>
        <span class="chip">±${num(c.freqTolHz, 2)} Hz</span>
        <span class="chip">${c.ambientC ?? 20} °C</span>
        ${c.altitudeM ? `<span class="chip warn">${c.altitudeM} m altitude</span>` : ''}
        ${c.abrasion > 1 ? `<span class="chip warn">abrasive site</span>` : ''}
        ${c.critical ? '<span class="chip req-miss">critical</span>' : ''}
        ${c.repeat ? '<span class="chip repeat">repeat business</span>' : ''}
        ${reqChips}
      </div>
      <div class="contract-figures">
        <div><div class="fig-label">Duration</div><div class="fig-value">${duration(c.hours)}</div></div>
        <div><div class="fig-label">Gross est.</div><div class="fig-value">${money(gross)}</div></div>
        <div><div class="fig-label">Fuel est.</div><div class="fig-value">-${money(fuelCost)}</div></div>
      </div>
      <div class="row" style="justify-content:space-between">
        <span class="faint" style="font-size:11px">
          ${locked ? `Needs: ${missing.map(capLabel).join(', ')}`
            : overCapacity ? `Peak exceeds your ${num(spec.altRatingKW, 0)} kW alternator — you will shed load`
            : `Advance ${money(c.mobilization)} on acceptance`}
        </span>
        <button class="btn ${locked ? '' : 'btn-primary'} btn-sm" data-accept="${c.id}" ${locked ? 'disabled' : ''}>Accept</button>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="row" style="justify-content:space-between;margin-bottom:14px">
      <h2 class="section-title" style="margin:0">Hire Desk — standing ${g.reputation}</h2>
      <button class="btn btn-sm" data-act="refresh-board">Ring Round (1 day)</button>
    </div>
    <div class="contract-grid">${cards}</div>`;
}

// --------------------------------------------------------------- tech tree

const NODE_W = 186, NODE_H = 116, SLOT_GAP = 16, LANE_GAP = 34;
const ROW_GAP = 30, PAD_X = 8, PAD_Y = 42;
const SLOT_W = NODE_W + SLOT_GAP;
const ROW_H = NODE_H + ROW_GAP;

/**
 * Branches are lanes; rows are tiers. Several branches hold more than one node
 * on the same tier (the three tier-3 Control options, for instance), so each
 * lane is as many slots wide as its busiest row and every row is centred
 * inside it. Positions are computed once and shared by the nodes and the
 * prerequisite curves, so the lines can never disagree with the boxes.
 */
export function techLayout() {
  const pos = new Map();
  const lanes = [];
  let x = PAD_X;

  for (const b of BRANCHES) {
    const nodes = TECH.filter((t) => t.branch === b.id);
    const byRow = new Map();
    for (const t of nodes) {
      if (!byRow.has(t.row)) byRow.set(t.row, []);
      byRow.get(t.row).push(t);
    }
    const slots = Math.max(...[...byRow.values()].map((r) => r.length));
    const laneW = slots * SLOT_W - SLOT_GAP;

    for (const [row, rowNodes] of byRow) {
      // Centre this row's nodes across the lane.
      const used = rowNodes.length * SLOT_W - SLOT_GAP;
      const offset = (laneW - used) / 2;
      rowNodes.forEach((t, i) => {
        pos.set(t.id, { x: x + offset + i * SLOT_W, y: PAD_Y + row * ROW_H });
      });
    }
    lanes.push({ ...b, x, w: laneW });
    x += laneW + LANE_GAP;
  }

  const maxRow = Math.max(...TECH.map((t) => t.row));
  return {
    pos,
    lanes,
    width: x - LANE_GAP + PAD_X,
    height: PAD_Y + (maxRow + 1) * ROW_H,
  };
}

export function renderTech(g) {
  const owned = new Set(g.owned);
  const locked = lockedBy(g.owned);
  const { pos, lanes, width, height } = techLayout();

  // Prerequisite curves, drawn beneath the nodes.
  const lines = TECH.flatMap((t) =>
    (t.requires ?? []).map((r) => {
      const a = pos.get(r), b = pos.get(t.id);
      const x1 = a.x + NODE_W / 2, y1 = a.y + NODE_H;
      const x2 = b.x + NODE_W / 2, y2 = b.y;
      const mid = (y1 + y2) / 2;
      const active = owned.has(r) && owned.has(t.id);
      const reachable = owned.has(r);
      // Drafted in white line on the blueprint; routes you have already built
      // are inked in green, ones you could build next in gold.
      return `<path d="M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}"
        fill="none" stroke="${active ? '#7ddc8e' : reachable ? '#e8b957' : 'rgba(168,206,235,0.42)'}"
        stroke-width="${active ? 2.2 : 1.3}"
        stroke-dasharray="${active || reachable ? 'none' : '5 4'}" />`;
    }),
  ).join('');

  const laneBg = lanes
    .map((l) => `<rect x="${l.x - 10}" y="${PAD_Y - 24}" width="${l.w + 20}" height="${height - PAD_Y + 26}"
      rx="3" fill="rgba(255,255,255,0.030)" stroke="rgba(168,206,235,0.22)" stroke-dasharray="7 5" />`)
    .join('');

  const heads = lanes
    .map((l) => `<div class="branch-head" style="left:${l.x}px;top:12px;width:${l.w}px;color:hsl(${l.hue} 75% 76%)">${l.name}</div>`)
    .join('');

  const nodes = TECH.map((t) => {
    const p = pos.get(t.id);
    const isOwned = owned.has(t.id);
    const isLocked = locked.has(t.id);
    const check = canResearch(t, g.owned, g.money);
    const reqMet = (t.requires ?? []).every((r) => owned.has(r));
    const cls = isOwned ? 'owned'
      : isLocked ? 'excluded'
      : !reqMet ? 'locked'
      : check.ok ? 'affordable' : '';
    return `<div class="tech-node ${cls}" data-tech="${t.id}"
      style="left:${p.x}px;top:${p.y}px;width:${NODE_W}px;height:${NODE_H}px">
      <div class="tech-name">${escapeHtml(t.name)}</div>
      <div class="tech-blurb">${escapeHtml(t.blurb)}</div>
      <div class="tech-cost">
        ${isOwned ? '<span class="owned-mark">✓ FITTED</span>'
          : isLocked ? '<span class="faint">locked out</span>'
          : `<span class="${check.ok ? '' : 'faint'}">${money(t.cost)}</span>`}
        ${t.excludes && !isOwned && !isLocked ? '<span class="faint" style="font-size:9px">EITHER/OR</span>' : ''}
      </div>
    </div>`;
  }).join('');

  return `
    <div class="row" style="justify-content:space-between;margin-bottom:12px">
      <h2 class="section-title" style="margin:0">Drawing Office — ${g.owned.length}/${TECH.length} modifications fitted</h2>
      <span class="faint" style="font-size:12px">Click a node for detail · scroll sideways for all five branches · upgrades fit between jobs only</span>
    </div>
    <div class="tech-wrap"><div class="tech-canvas" style="height:${height}px;width:${width}px">
      <svg class="tech-svg" width="${width}" height="${height}">${laneBg}${lines}</svg>
      ${heads}${nodes}
    </div></div>`;
}

/** Detail dialog with a real before/after of the machine spec. */
export function techModal(g, id) {
  const t = TECH_BY_ID[id];
  const owned = g.owned.includes(id);
  const check = canResearch(t, g.owned, g.money);
  const before = specFor(g);
  const after = owned ? before : previewSpec(g, id);

  const rows = specDeltaRows(before, after);
  const reqNames = (t.requires ?? []).map((r) => {
    const has = g.owned.includes(r);
    return `<span class="chip ${has ? 'req-ok' : 'req-miss'}">${escapeHtml(TECH_BY_ID[r].name)}</span>`;
  }).join('');
  const excl = (t.excludes ?? []).map((e) => `<span class="chip warn">Locks out ${escapeHtml(TECH_BY_ID[e].name)}</span>`).join('');

  const reason = check.ok ? ''
    : check.reason === 'money' ? `You need ${money(t.cost - g.money)} more.`
    : check.reason === 'requires' ? 'Prerequisites not fitted.'
    : check.reason === 'locked' ? 'Locked out by an earlier choice.'
    : '';

  return `
    <h2>${escapeHtml(t.name)}</h2>
    <div class="modal-sub">${BRANCHES.find((b) => b.id === t.branch).name} · ${money(t.cost)}</div>
    <p style="font-size:12.5px;line-height:1.65">${escapeHtml(t.detail)}</p>
    ${reqNames || excl ? `<div class="chip-row" style="margin:12px 0">${reqNames}${excl}</div>` : ''}
    ${rows ? `<h3 class="section-title" style="margin-top:18px">Effect on the machine</h3>
      <table class="spec-table">${rows}</table>` : ''}
    <div class="row" style="margin-top:20px;justify-content:flex-end">
      ${reason ? `<span class="faint" style="font-size:12px;margin-right:auto">${reason}</span>` : ''}
      <button class="btn" data-act="close-modal">Close</button>
      ${owned ? '<span class="chip req-ok">Already fitted</span>'
        : `<button class="btn btn-primary" data-buy="${t.id}" ${check.ok && !g.job ? '' : 'disabled'}>Fit for ${money(t.cost)}</button>`}
    </div>`;
}

function previewSpec(g, extraId) {
  const spec = buildSpec([...g.owned, extraId], baseSpec);
  spec.tankL += g.tankBonusL;
  return spec;
}

const SPEC_ROWS = [
  ['altRatingKW', 'Alternator rating', 'kW', 1, 1],
  ['indicatedEff', 'Indicated efficiency', '%', 100, 1],
  ['boostGain', 'Boost air gain', '%', 100, 0],
  ['boostTau', 'Turbo response τ', 's', 1, 2, true],
  ['chargeDensityBonus', 'Charge density', '%', 100, 0],
  ['durability', 'Durability', '×', 1, 2],
  ['torqueLimit', 'Bottom-end limit', 'N·m', 1, 0],
  ['radiatorUA', 'Cooling capacity', 'W/K', 1, 0],
  ['droop', 'Governor droop', '%', 100, 2, true],
  ['voltSag', 'Voltage sag', '%', 100, 2, true],
  ['noiseDb', 'Noise at 7 m', 'dB(A)', 1, 0, true],
  ['emissionsTier', 'Emissions stage', '', 1, 0],
  ['fanPowerKW', 'Fan parasitic', 'kW', 1, 2, true],
  ['tankL', 'Tank capacity', 'L', 1, 0],
  ['batteryKWh', 'Battery buffer', 'kWh', 1, 0],
];

function specDeltaRows(before, after) {
  const out = [];
  for (const [key, label, unit, mult, dp, lowerBetter] of SPEC_ROWS) {
    const a = before[key] ?? 0;
    const b = after[key] ?? 0;
    if (Math.abs(a - b) < 1e-9) continue;
    const better = lowerBetter ? b < a : b > a;
    out.push(`<tr><td>${label}</td><td>
      <span class="faint">${(a * mult).toFixed(dp)}</span>
      <span class="${better ? 'delta-up' : 'delta-down'}"> → ${(b * mult).toFixed(dp)}${unit ? ` ${unit}` : ''}</span>
    </td></tr>`);
  }
  // Capabilities are the ones that unlock whole contract classes.
  const newCaps = after.capabilities.filter((c) => !before.capabilities.includes(c));
  for (const c of newCaps) {
    out.push(`<tr><td>Unlocks</td><td><span class="delta-up">${capLabel(c)}</span></td></tr>`);
  }
  if (before.fuel !== after.fuel) {
    out.push(`<tr><td>Fuel</td><td><span class="faint">${before.fuel}</span><span class="delta-up"> → ${after.fuel}</span></td></tr>`);
  }
  return out.join('');
}

// ---------------------------------------------------------------- workshop

export function renderWorkshop(g) {
  const m = g.machine;
  const spec = g.spec;
  const busy = !!g.job && !g.job.done;

  const tank = `<div class="card"><div class="card-body shop-item">
    <div><div class="job-title">${TANK_UPGRADE.name}</div>
    <div class="faint mono" style="font-size:11px">current capacity ${spec.tankL} L</div></div>
    <div class="shop-desc">${TANK_UPGRADE.desc}</div>
    <div class="row" style="justify-content:space-between;margin-top:auto">
      <span class="mono">${money(TANK_UPGRADE.cost)}</span>
      ${g.tankBonusL > 0
        ? '<span class="chip req-ok">Fitted</span>'
        : `<button class="btn btn-sm ${g.money >= TANK_UPGRADE.cost ? 'btn-primary' : ''}" data-act="buy-tank" ${g.money >= TANK_UPGRADE.cost ? '' : 'disabled'}>Buy</button>`}
    </div>
  </div></div>`;

  const fuelToFull = spec.tankL - m.fuelL;
  const fuelBuy = `<div class="card"><div class="card-body shop-item">
    <div><div class="job-title">Fuel</div>
    <div class="faint mono" style="font-size:11px">${spec.fuel.toUpperCase()} at $${fuelPrice(g).toFixed(2)}/L${busy ? ' · +18% on-site delivery' : ''}</div></div>
    <div class="shop-desc">Tank holds ${spec.tankL} L; ${num(m.fuelL, 0)} L on board. Prices move day to day, so filling up cheap before a long job is worth doing.</div>
    <div class="row" style="justify-content:space-between;margin-top:auto">
      <span class="mono">${money(fuelToFull * fuelPrice(g) * (busy ? 1.18 : 1))} to fill</span>
      <button class="btn btn-sm btn-primary" data-act="refuel" ${fuelToFull > 0.5 ? '' : 'disabled'}>Fill up</button>
    </div>
  </div></div>`;

  const rho = densityRatio(0, 20);
  const specRows = [
    ['Alternator rating', `${num(spec.altRatingKW, 0)} kW`],
    ['Rated (plate)', `${RATED_KW} kW`],
    ['Indicated efficiency', `${num(spec.indicatedEff * 100, 1)}%`],
    ['Induction', spec.boostGain > 0 ? `Turbocharged (+${num(spec.boostGain * 100, 0)}% air, τ ${num(spec.boostTau, 2)} s)` : 'Naturally aspirated'],
    ['Governor', `${spec.droop <= 0.006 ? 'Hydraulic' : 'Flyweight'}, ${num(spec.droop * 100, 1)}% droop`],
    ['Excitation', spec.compounded > 0
      ? `Hand rheostat, compounded ${num(spec.compounded * 100, 0)}%`
      : 'Hand rheostat'],
    ['Volts lost at full load', `${num(Math.max(0, spec.armatureReaction - spec.compounded) * 100, 0)}%`],
    ['Rack limiter', spec.aneroid ? 'Aneroid boost compensator' : 'Mechanical stop'],
    ['Oil pressure (rated)', `${num(spec.oilPressureRated, 1)} bar`],
    ['Cooling', `${num(spec.radiatorUA, 0)} W/K${spec.fanVariable ? ', variable fan' : ', fixed fan'}`],
    ['Instruments', spec.fullInstruments ? 'Full switchboard' : 'Basic (V, Hz, A)'],
    ['Noise at 7 m', `${num(spec.noiseDb, 0)} dB(A)`],
    ['Emissions', `Stage ${spec.emissionsTier}`],
    ['Fuel', spec.fuel.toUpperCase()],
    ['Tank', `${spec.tankL} L`],
    ['Battery buffer', spec.batteryKWh > 0 ? `${spec.batteryKWh} kWh / ${spec.batteryKW} kW` : '—'],
    ['Capabilities', spec.capabilities.length ? spec.capabilities.map(capLabel).join(', ') : '—'],
  ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');

  const career = [
    ['Energy registered', `${num(m.kwhRegister ?? 0, 0)} kWh`],
    ['Contracts completed', g.completed.length],
    ['Clean runs', g.cleanRuns],
    ['Failed jobs', g.failedJobs],
    ['Lifetime earned', money(g.lifetimeEarned)],
    ['Energy delivered', `${num(g.lifetimeEnergyKWh, 0)} kWh`],
    ['Fuel burned', `${num(g.lifetimeFuelL, 0)} L`],
    ['Engine hours', num(m.hours, 1)],
  ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');

  return `
    <div class="stack">
      ${busy ? '<div class="card"><div class="card-body"><span class="chip warn">A job is running — upgrades are unavailable until it ends.</span></div></div>' : ''}
      <div>
        <h2 class="section-title">Consumables</h2>
        <div class="shop-grid">${tank}${fuelBuy}</div>
      </div>
      <div class="shop-grid">
        <div class="card">
          <div class="card-head"><span class="card-title">Machine Specification</span></div>
          <div class="card-body"><table class="spec-table">${specRows}</table></div>
        </div>
        <div class="card">
          <div class="card-head"><span class="card-title">Yard Record</span></div>
          <div class="card-body"><table class="spec-table">${career}</table></div>
        </div>
      </div>
    </div>`;
}

// ------------------------------------------------------------- settlement

export function settlementModal(g, job) {
  const r = job.result;
  const c = job.contract;
  const rows = r.lines.map((l) => `<tr><td>${escapeHtml(l.label)}</td>
    <td class="${l.note ? 'faint' : l.amount >= 0 ? 'pos' : 'neg'}">${l.note ? '—' : money(l.amount)}</td></tr>`).join('');

  return `
    <h2>${r.failed ? 'Contract failed' : r.clean ? 'Clean run' : 'Job complete'}</h2>
    <div class="modal-sub">${escapeHtml(c.title)} · ${escapeHtml(c.client)} · ${dateStamp(g.day)}</div>
    <table class="settle-table">
      ${rows}
      <tr><td class="faint">Less mobilisation advance already paid</td><td class="faint">${money(-(r.advance ?? 0))}</td></tr>
      <tr class="settle-total"><td>Settled to your account</td>
        <td class="${(r.net ?? 0) >= 0 ? 'pos' : 'neg'}">${money(r.net ?? r.total)}</td></tr>
    </table>
    <div class="chip-row">
      <span class="chip ${r.repDelta >= 0 ? 'req-ok' : 'req-miss'}">Standing ${r.repDelta >= 0 ? '+' : ''}${r.repDelta}</span>
      <span class="chip">Supply met ${num(r.supplyRatio * 100, 1)}%</span>
      ${r.clean ? '<span class="chip req-ok">No quality faults</span>' : ''}
    </div>
    <div><span class="stamp ${r.failed ? 'failed' : 'paid'}">${r.failed ? 'In Default' : 'Settled'}</span></div>
    <div class="row" style="margin-top:20px;justify-content:flex-end">
      <button class="btn btn-primary" data-act="close-settle">Continue</button>
    </div>`;
}

// ------------------------------------------------------------- live trace

const TRACE_LEN = 240;
export const traceBuf = { hz: [], kw: [], demand: [] };

export function pushTrace(g) {
  const m = g.machine;
  const job = g.job;
  const demand = job && !job.done ? demandAt(job.contract.profile, job.progress.elapsedH) : 0;
  traceBuf.hz.push(m.hz ?? 0);
  traceBuf.kw.push(m.deliveredKW ?? 0);
  traceBuf.demand.push(demand);
  for (const k of ['hz', 'kw', 'demand']) {
    if (traceBuf[k].length > TRACE_LEN) traceBuf[k].shift();
  }
}

export function drawTrace(canvas, g) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Chart paper: pale stock, printed grid, ink traces.
  ctx.fillStyle = '#efe7d0';
  ctx.fillRect(0, 0, w, h);

  const tol = g.job && !g.job.done ? g.job.contract.freqTolHz : 2;
  const hzMin = 60 - Math.max(tol * 2.2, 2.5), hzMax = 60 + Math.max(tol * 2.2, 2.5);
  const kwMax = Math.max(g.spec.altRatingKW, ...traceBuf.demand, ...traceBuf.kw, 10) * 1.1;
  const yOf = (hz) => h - ((hz - hzMin) / (hzMax - hzMin)) * h;

  ctx.strokeStyle = 'rgba(120,95,60,0.16)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 12; i++) {
    const x = (i / 12) * w;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }
  for (let i = 1; i < 6; i++) {
    const y = (i / 6) * h;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  // Tolerance band, printed on the paper.
  ctx.fillStyle = 'rgba(74,122,58,0.16)';
  ctx.fillRect(0, yOf(60 + tol), w, yOf(60 - tol) - yOf(60 + tol));
  ctx.strokeStyle = 'rgba(74,122,58,0.5)';
  ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(0, yOf(60)); ctx.lineTo(w, yOf(60)); ctx.stroke();
  ctx.setLineDash([]);

  const n = traceBuf.hz.length;
  if (n > 1) {
    const xOf = (i) => (i / (TRACE_LEN - 1)) * w;
    const kwY = (v) => h - (v / kwMax) * h;

    // Demand pen (dashed) and delivered pen, in blue ink.
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(40,80,130,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    traceBuf.demand.forEach((v, i) => (i ? ctx.lineTo(xOf(i), kwY(v)) : ctx.moveTo(xOf(i), kwY(v))));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = '#2b5a8c';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    traceBuf.kw.forEach((v, i) => (i ? ctx.lineTo(xOf(i), kwY(v)) : ctx.moveTo(xOf(i), kwY(v))));
    ctx.stroke();

    // Frequency pen, in red ink.
    ctx.strokeStyle = '#8e2a1c';
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    traceBuf.hz.forEach((v, i) => (i ? ctx.lineTo(xOf(i), yOf(v)) : ctx.moveTo(xOf(i), yOf(v))));
    ctx.stroke();
  }

  ctx.font = "9px 'Cutive Mono', monospace";
  ctx.fillStyle = '#8e2a1c';
  ctx.fillText(`${hzMax.toFixed(1)} Hz`, 4, 11);
  ctx.fillText(`${hzMin.toFixed(1)} Hz`, 4, h - 4);
  ctx.fillStyle = '#2b5a8c';
  ctx.textAlign = 'right';
  ctx.fillText(`${kwMax.toFixed(0)} kW`, w - 4, 11);
  ctx.textAlign = 'left';
}
