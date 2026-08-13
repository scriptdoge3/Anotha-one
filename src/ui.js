/**
 * Rendering. Every panel is a pure function of game state -> HTML string,
 * with delegated click handling keyed off data attributes, so there is never
 * a stale listener bound to a node that has been replaced.
 */

import { money, num, duration, escapeHtml } from './format.js';
import { RATED_KW, rpmToHz, densityRatio, baseSpec } from './sim.js';
import { TECH, BRANCHES, TECH_BY_ID, canResearch, lockedBy, buildSpec } from './tech.js';
import {
  demandAt, peakDemand, meanDemand, profileLabel, capLabel,
  missingCaps, estimateValue, TIER_REP,
} from './contracts.js';
import { SPEEDS, SERVICE, TANK_UPGRADE, fuelPrice, board, specFor } from './state.js';

// ------------------------------------------------------------------ topbar

export function renderTop(g) {
  const m = g.machine;
  const wearCls = m.wear > 80 ? 'bad' : m.wear > 50 ? 'warn' : '';
  const repTier = [5, 4, 3, 2, 1].find((t) => g.reputation >= TIER_REP[t]) ?? 1;
  return `
    <div class="stat"><span class="stat-label">Bank</span><span class="stat-value ${g.money < 500 ? 'warn' : 'good'}">${money(g.money)}</span></div>
    <div class="stat"><span class="stat-label">Reputation</span><span class="stat-value">${g.reputation} <span class="faint" style="font-size:11px">T${repTier}</span></span></div>
    <div class="stat"><span class="stat-label">Day</span><span class="stat-value">${g.day}</span></div>
    <div class="stat"><span class="stat-label">Engine hours</span><span class="stat-value">${num(m.hours, 0)}</span></div>
    <div class="stat"><span class="stat-label">Wear</span><span class="stat-value ${wearCls}">${num(m.wear, 1)}%</span></div>
    <div class="stat"><span class="stat-label">Fuel</span><span class="stat-value">$${fuelPrice(g).toFixed(2)}/L</span></div>`;
}

// ----------------------------------------------------------------- operate

/**
 * The Operate panel is the only view that changes every frame, so it is built
 * once and then patched in place. Re-rendering its innerHTML each tick would
 * detach the buttons mid-click and destroy the trace canvas 60 times a second.
 *
 * `gaugeSpecs` and `lampSpecs` are the single source of truth for both the
 * initial build and the per-frame update, so the two can never drift apart.
 */

function gaugeSpecs(g) {
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

  const out = [
    {
      key: 'hz', label: 'Frequency', value: num(hz, 2), unit: 'Hz',
      sub: `${num(m.rpm, 0)} rpm · tol ±${num(tol, 2)}`,
      pct: (hz / 63) * 100,
      state: !m.running ? '' : hzErr > tol ? 'alarm' : hzErr > tol * 0.6 ? 'warn' : '',
      color: !m.running ? 'var(--ink-faint)' : hzErr > tol ? 'var(--red)' : 'var(--green)',
    },
    {
      key: 'kw', label: 'Output', value: num(m.deliveredKW, 1), unit: 'kW',
      sub: `demand ${num(demand, 1)} kW${m.shedKW > 0.5 ? ` · SHED ${num(m.shedKW, 1)}` : ''}`,
      pct: (m.deliveredKW / spec.altRatingKW) * 100,
      state: m.shedKW > 0.5 ? 'alarm' : m.deliveredKW > RATED_KW ? 'warn' : '',
      color: m.deliveredKW > RATED_KW ? 'var(--amber)' : 'var(--blue)',
    },
    {
      key: 'v', label: 'Voltage', value: num(m.volts, 0), unit: 'V',
      sub: `nominal 480 · ${num(((m.volts - 480) / 480) * 100, 1)}%`,
      pct: (m.volts / 520) * 100,
      state: m.running && Math.abs(m.volts - 480) / 480 > voltTol / 100 ? 'alarm' : '',
      color: 'var(--violet)',
    },
    {
      key: 'temp', label: 'Coolant', value: num(m.coolantC, 1), unit: '°C',
      sub: m.coolantC > 103 ? 'DERATING' : `fan ${num((m.fanCmd ?? 1) * 100, 0)}%`,
      pct: (m.coolantC / 125) * 100,
      state: m.coolantC > 110 ? 'alarm' : m.coolantC > 100 ? 'warn' : '',
      color: m.coolantC > 110 ? 'var(--red)' : 'var(--blue)',
    },
    {
      key: 'fuel', label: 'Fuel', value: num(m.fuelL, 0), unit: 'L',
      sub: `${num(m.fuelLPerH, 1)} L/h · ${duration(endurance)} left`,
      pct: fuelPct,
      state: fuelPct < 8 ? 'alarm' : fuelPct < 20 ? 'warn' : '',
      color: fuelPct < 8 ? 'var(--red)' : 'var(--amber)',
    },
    spec.boostGain > 0
      ? {
          key: 'boost', label: 'Boost', value: num(m.boost * 100, 0), unit: '%',
          sub: `rack ${num(m.fuelCmd * 100, 0)}% · τ ${num(spec.boostTau, 2)} s`,
          pct: m.boost * 100, state: '', color: 'var(--amber)',
        }
      : {
          key: 'boost', label: 'Fuel rack', value: num(m.fuelCmd * 100, 0), unit: '%',
          sub: 'naturally aspirated',
          pct: m.fuelCmd * 100, state: '', color: 'var(--amber)',
        },
    {
      key: 'smoke', label: 'Smoke', value: num(m.smoke * 100, 0), unit: '%',
      sub: m.smoke > 0.08 ? 'over-fuelling — air limited' : 'clean',
      pct: m.smoke * 100,
      state: m.smoke > 0.3 ? 'alarm' : m.smoke > 0.08 ? 'warn' : '',
      color: 'var(--red)',
    },
    spec.batteryKWh > 0
      ? {
          key: 'batt', label: 'Battery', value: num(m.batterySoc * 100, 0), unit: '%',
          sub: `${m.batteryFlowKW > 0 ? 'discharging ' : m.batteryFlowKW < 0 ? 'charging ' : 'idle '}${num(Math.abs(m.batteryFlowKW), 1)} kW`,
          pct: m.batterySoc * 100, state: '', color: 'var(--green)',
        }
      : {
          key: 'wear', label: 'Engine wear', value: num(m.wear, 1), unit: '%',
          sub: `${num(m.hoursSinceService, 0)} h since service`,
          pct: m.wear,
          state: m.wear > 80 ? 'alarm' : m.wear > 50 ? 'warn' : '',
          color: m.wear > 80 ? 'var(--red)' : 'var(--amber)',
        },
  ];
  return out;
}

function lampSpecs(g) {
  const m = g.machine;
  const spec = g.spec;
  const fuelPct = (m.fuelL / spec.tankL) * 100;
  const lamps = [
    { key: 'run', label: 'Running', on: m.running, color: 'green' },
    { key: 'load', label: 'On load', on: m.breakerClosed, color: 'green' },
    { key: 'crank', label: 'Cranking', on: m.cranking > 0, color: 'amber' },
    { key: 'temp', label: 'Over-temp', on: m.coolantC > 105, color: 'red' },
    { key: 'over', label: 'Overload', on: m.shedKW > 0.5, color: 'red' },
    { key: 'lowfuel', label: 'Low fuel', on: fuelPct < 20, color: 'amber' },
    { key: 'svc', label: 'Service due', on: m.hoursSinceService > 250, color: 'amber' },
  ];
  if (spec.capabilities.includes('dpf')) {
    lamps.push({
      key: 'dpf', label: `DPF ${num(m.dpfLoad * 100, 0)}%`,
      on: m.dpfLoad > 0.7, color: 'amber',
    });
  }
  return lamps;
}

function gaugeHtml(s) {
  return `<div class="gauge ${s.state ? `is-${s.state}` : ''}" data-gauge="${s.key}">
    <div class="gauge-label">${s.label}</div>
    <div class="gauge-value" data-f="value">${s.value}<span class="gauge-unit">${s.unit ?? ''}</span></div>
    <div class="gauge-sub" data-f="sub">${s.sub ?? ''}</div>
    <div class="bar"><div class="bar-fill" data-f="bar" style="width:${clampPct(s.pct)}%;background:${s.color}"></div></div>
  </div>`;
}

const clampPct = (v) => Math.max(0, Math.min(100, v ?? 0));

/**
 * Structural signature. When this changes the panel is rebuilt; otherwise it is
 * only patched. It covers everything that changes the *shape* of the panel
 * rather than its values.
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
  ].join('|');
}

export function renderOperate(g) {
  const gauges = gaugeSpecs(g).map(gaugeHtml).join('');
  const lamps = lampSpecs(g)
    .map((l) => `<div class="lamp ${l.on ? `on ${l.color}` : ''}" data-lamp="${l.key}"><span class="lamp-dot"></span><span data-f="label">${l.label}</span></div>`)
    .join('');
  const speedBtns = SPEEDS.map(
    (s) => `<button class="speed-btn" data-speed="${s}">${s === 0 ? '❚❚' : `${s}×`}</button>`,
  ).join('');

  return `
  <div class="operate-grid">
    <div class="stack">
      <div class="card">
        <div class="card-head">
          <span class="card-title">Control panel</span>
          <div class="speed-group" data-speeds>${speedBtns}</div>
        </div>
        <div class="card-body stack">
          <div class="controls">
            <button class="btn" data-act="start">Start</button>
            <button class="btn" data-act="stop">Stop</button>
            <button class="btn" data-act="breaker">Close breaker</button>
            <button class="btn" data-act="refuel">Refuel to full</button>
          </div>
          <div class="lamp-row">${lamps}</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><span class="card-title">Instruments</span></div>
        <div class="card-body"><div class="gauge-grid">${gauges}</div></div>
      </div>

      <div class="card">
        <div class="card-head">
          <span class="card-title">Frequency &amp; load trace</span>
          <span class="faint mono" style="font-size:10px">last 60 s</span>
        </div>
        <div class="card-body"><canvas class="trace" id="trace"></canvas></div>
      </div>
    </div>

    <div class="stack">
      ${renderJobCard(g)}
      <div class="card">
        <div class="card-head"><span class="card-title">Log</span></div>
        <div class="card-body"><div class="log" data-log></div></div>
      </div>
    </div>
  </div>`;
}

/** Per-frame patch. Touches only text and style, never structure. */
export function updateOperate(g, root) {
  if (!root) return;
  const m = g.machine;

  for (const s of gaugeSpecs(g)) {
    const node = root.querySelector(`[data-gauge="${s.key}"]`);
    if (!node) continue;
    const val = node.querySelector('[data-f="value"]');
    const unit = val.querySelector('.gauge-unit');
    // Replace only the leading text node so the unit span survives.
    if (val.firstChild && val.firstChild.nodeType === 3) {
      if (val.firstChild.nodeValue !== s.value) val.firstChild.nodeValue = s.value;
    }
    if (unit && unit.textContent !== (s.unit ?? '')) unit.textContent = s.unit ?? '';
    const sub = node.querySelector('[data-f="sub"]');
    if (sub && sub.textContent !== (s.sub ?? '')) sub.textContent = s.sub ?? '';
    const bar = node.querySelector('[data-f="bar"]');
    if (bar) {
      const w = `${clampPct(s.pct)}%`;
      if (bar.style.width !== w) bar.style.width = w;
      if (bar.style.background !== s.color) bar.style.background = s.color;
    }
    node.classList.toggle('is-alarm', s.state === 'alarm');
    node.classList.toggle('is-warn', s.state === 'warn');
  }

  for (const l of lampSpecs(g)) {
    const node = root.querySelector(`[data-lamp="${l.key}"]`);
    if (!node) continue;
    node.className = `lamp ${l.on ? `on ${l.color}` : ''}`;
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
    if (cls !== undefined) b.className = cls;
  };
  setBtn('[data-act="start"]', {
    disabled: m.running || m.cranking > 0,
    cls: `btn ${m.running || m.cranking > 0 ? '' : 'btn-primary'}`,
  });
  setBtn('[data-act="stop"]', { disabled: !m.running });
  setBtn('[data-act="breaker"]', {
    disabled: !m.running,
    text: m.breakerClosed ? 'Open breaker' : 'Close breaker',
    cls: `btn ${m.breakerClosed ? 'btn-danger' : ''}`,
  });

  for (const b of root.querySelectorAll('[data-speeds] .speed-btn')) {
    b.classList.toggle('is-active', Number(b.dataset.speed) === g.speed);
  }

  // Job card figures.
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

  // The log only changes when something is appended.
  const logEl = root.querySelector('[data-log]');
  if (logEl && Number(logEl.dataset.len || -1) !== g.log.length) {
    logEl.dataset.len = String(g.log.length);
    logEl.innerHTML =
      g.log
        .map((l) => `<div class="log-line ${l.kind}"><span class="log-day">D${l.day}</span><span class="log-text">${escapeHtml(l.text)}</span></div>`)
        .join('') || '<div class="faint">Nothing yet.</div>';
  }
}

function renderJobCard(g) {
  const job = g.job;
  if (!job) {
    return `<div class="card"><div class="card-head"><span class="card-title">Current job</span></div>
      <div class="card-body"><div class="empty-note">No job on.<br /><span class="faint">Take one from the Contracts board.</span></div></div></div>`;
  }
  const { contract: c } = job;
  const kv = (key, label) =>
    `<div><div class="kv-label">${label}</div><div class="kv-value" data-job="${key}">—</div></div>`;

  return `<div class="card">
    <div class="card-head"><span class="card-title">Current job</span>
      <button class="btn btn-sm btn-danger" data-act="abandon">Abandon</button></div>
    <div class="card-body stack">
      <div>
        <div class="job-head"><span class="job-title">${escapeHtml(c.title)}</span></div>
        <div class="job-client">${escapeHtml(c.client)}</div>
        <div class="progress-track"><div class="progress-fill" data-job="fill" style="width:0%"></div></div>
        <div class="row" style="justify-content:space-between">
          <span class="faint mono" style="font-size:11px" data-job="elapsed"></span>
          <span class="faint mono" style="font-size:11px" data-job="pctdone"></span>
        </div>
      </div>
      <div class="kv-grid">
        ${kv('energy', 'Delivered')}
        ${kv('supply', 'Supply met')}
        ${kv('outage', 'Shortfall')}
        ${kv('freq', 'Freq. faults')}
        ${kv('volt', 'Volt faults')}
        ${kv('trips', 'Trips')}
        ${kv('fuelused', 'Fuel used')}
        ${c.thermalPayPerKWh ? kv('thermal', 'Heat sold') : ''}
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
    ${ratedY > 0 && ratedY < h ? `<line x1="0" y1="${ratedY}" x2="${w}" y2="${ratedY}" stroke="#3a4550" stroke-width="1" stroke-dasharray="3 3"/>` : ''}
    <polyline points="${pts}" fill="none" stroke="var(--amber)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
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
      <h2 class="section-title" style="margin:0">Available work — reputation ${g.reputation}</h2>
      <button class="btn btn-sm" data-act="refresh-board">Ring round for new work (1 day)</button>
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
      return `<path d="M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}"
        fill="none" stroke="${active ? 'var(--green)' : reachable ? 'var(--amber-dim)' : '#242a30'}"
        stroke-width="${active ? 2.2 : 1.4}" />`;
    }),
  ).join('');

  const laneBg = lanes
    .map((l) => `<rect x="${l.x - 10}" y="${PAD_Y - 22}" width="${l.w + 20}" height="${height - PAD_Y + 24}"
      rx="10" fill="hsl(${l.hue} 40% 50% / 0.035)" stroke="hsl(${l.hue} 40% 50% / 0.10)" />`)
    .join('');

  const heads = lanes
    .map((l) => `<div class="branch-head" style="left:${l.x}px;top:12px;width:${l.w}px;color:hsl(${l.hue} 60% 62%)">${l.name}</div>`)
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
      <h2 class="section-title" style="margin:0">Development programme — ${g.owned.length}/${TECH.length} fitted</h2>
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
    <p style="color:var(--ink-dim);font-size:13.5px;line-height:1.6">${escapeHtml(t.detail)}</p>
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
  const hasTelemetry = spec.capabilities.includes('telemetry');
  const busy = !!g.job && !g.job.done;

  const services = Object.values(SERVICE).map((s) => {
    const cost = hasTelemetry ? s.telemetryCost : s.cost;
    return `<div class="card"><div class="card-body shop-item">
      <div>
        <div class="job-title">${s.name}</div>
        <div class="faint mono" style="font-size:11px">${s.hours} h downtime</div>
      </div>
      <div class="shop-desc">${s.desc}</div>
      <div class="row" style="justify-content:space-between;margin-top:auto">
        <span class="mono">${money(cost)}${hasTelemetry ? ' <span class="faint" style="font-size:10px">telemetry rate</span>' : ''}</span>
        <button class="btn btn-sm ${g.money >= cost && !busy ? 'btn-primary' : ''}" data-service="${s.id}" ${g.money >= cost && !busy ? '' : 'disabled'}>Book in</button>
      </div>
    </div></div>`;
  }).join('');

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
    ['Governor', spec.isochronous ? 'Isochronous electronic' : `Mechanical, ${num(spec.droop * 100, 1)}% droop`],
    ['Voltage regulation', `±${num(spec.voltSag * 100, 1)}% sag at full load`],
    ['Cooling', `${num(spec.radiatorUA, 0)} W/K${spec.fanVariable ? ', variable fan' : ', fixed fan'}`],
    ['Durability', `×${num(spec.durability, 2)}`],
    ['Noise at 7 m', `${num(spec.noiseDb, 0)} dB(A)`],
    ['Emissions', `Stage ${spec.emissionsTier}`],
    ['Fuel', spec.fuel.toUpperCase()],
    ['Tank', `${spec.tankL} L`],
    ['Battery buffer', spec.batteryKWh > 0 ? `${spec.batteryKWh} kWh / ${spec.batteryKW} kW` : '—'],
    ['Capabilities', spec.capabilities.length ? spec.capabilities.map(capLabel).join(', ') : '—'],
  ].map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');

  const career = [
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
      ${busy ? '<div class="card"><div class="card-body"><span class="chip warn">A job is running — servicing and upgrades are unavailable until it ends.</span></div></div>' : ''}
      <div>
        <h2 class="section-title">Maintenance &amp; consumables</h2>
        <div class="shop-grid">${services}${tank}${fuelBuy}</div>
      </div>
      <div class="shop-grid">
        <div class="card">
          <div class="card-head"><span class="card-title">Machine specification</span></div>
          <div class="card-body"><table class="spec-table">${specRows}</table></div>
        </div>
        <div class="card">
          <div class="card-head"><span class="card-title">Career record</span></div>
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
    <div class="modal-sub">${escapeHtml(c.title)} · ${escapeHtml(c.client)}</div>
    <table class="settle-table">
      ${rows}
      <tr><td class="faint">Less mobilisation advance already paid</td><td class="faint">${money(-(r.advance ?? 0))}</td></tr>
      <tr class="settle-total"><td>Settled to your account</td>
        <td class="${(r.net ?? 0) >= 0 ? 'pos' : 'neg'}">${money(r.net ?? r.total)}</td></tr>
    </table>
    <div class="chip-row">
      <span class="chip ${r.repDelta >= 0 ? 'req-ok' : 'req-miss'}">Reputation ${r.repDelta >= 0 ? '+' : ''}${r.repDelta}</span>
      <span class="chip">Supply met ${num(r.supplyRatio * 100, 1)}%</span>
      ${r.clean ? '<span class="chip req-ok">No quality faults</span>' : ''}
    </div>
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
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr; canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const tol = g.job && !g.job.done ? g.job.contract.freqTolHz : 2;
  const hzMin = 60 - Math.max(tol * 2.2, 2.5), hzMax = 60 + Math.max(tol * 2.2, 2.5);
  const kwMax = Math.max(g.spec.altRatingKW, ...traceBuf.demand, ...traceBuf.kw, 10) * 1.1;

  // tolerance band
  const yOf = (hz) => h - ((hz - hzMin) / (hzMax - hzMin)) * h;
  ctx.fillStyle = 'rgba(79,209,139,0.09)';
  ctx.fillRect(0, yOf(60 + tol), w, yOf(60 - tol) - yOf(60 + tol));
  ctx.strokeStyle = '#2a323a';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, yOf(60)); ctx.lineTo(w, yOf(60)); ctx.stroke();

  const n = traceBuf.hz.length;
  if (n > 1) {
    const xOf = (i) => (i / (TRACE_LEN - 1)) * w;

    // demand (dashed) and delivered (solid), on the kW axis
    const kwY = (v) => h - (v / kwMax) * h;
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(87,182,242,0.5)';
    ctx.beginPath();
    traceBuf.demand.forEach((v, i) => (i ? ctx.lineTo(xOf(i), kwY(v)) : ctx.moveTo(xOf(i), kwY(v))));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(87,182,242,0.95)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    traceBuf.kw.forEach((v, i) => (i ? ctx.lineTo(xOf(i), kwY(v)) : ctx.moveTo(xOf(i), kwY(v))));
    ctx.stroke();

    // frequency
    ctx.strokeStyle = '#f2a33c';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    traceBuf.hz.forEach((v, i) => (i ? ctx.lineTo(xOf(i), yOf(v)) : ctx.moveTo(xOf(i), yOf(v))));
    ctx.stroke();
  }

  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = '#63707b';
  ctx.fillText(`${hzMax.toFixed(1)} Hz`, 4, 11);
  ctx.fillText(`${hzMin.toFixed(1)} Hz`, 4, h - 4);
  ctx.fillStyle = 'rgba(87,182,242,0.8)';
  ctx.fillText(`${kwMax.toFixed(0)} kW`, w - 52, 11);
}
