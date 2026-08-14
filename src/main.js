/**
 * Entry point: the frame loop, event wiring, and the bridge between DOM
 * events and the pure state functions in state.js.
 */

import {
  createGame, advance, acceptContract, abandonJob, clearFinishedJob,
  startEngine, stopEngine, setBreaker, refuel, buyTech, buyTank,
  refreshBoard, setThrottle, bumpThrottle, setGovMode, setExcitation,
  bumpExcitation, bumpDroop, setFieldBreaker, setRunMode, resetRelays, refreshSpec, SPEEDS,
} from './state.js';
import * as save from './save.js';
import {
  renderTop, renderOperate, updateOperate, operateSignature, renderContracts,
  renderTech, renderWorkshop, techModal, settlementModal, pushTrace, drawTrace,
} from './ui.js';

const el = (id) => document.getElementById(id);

let g = save.load() ?? createGame();
let activeTab = 'operate';
let modalTech = null;
let settleShown = false;

// Panels other than Operate don't need to re-render every frame.
let staticDirty = true;
const markDirty = () => { staticDirty = true; };

// ------------------------------------------------------------------ toasts

function toast(msg, kind = 'info') {
  const stack = el('toasts');
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = msg;
  stack.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 260);
  }, 2800);
}

function apply(result) {
  if (result && result.ok === false) toast(result.msg, 'bad');
  markDirty();
  return result;
}

// ------------------------------------------------------------------ render

let lastOperateSig = null;
let lastTop = '';

function renderAll(dt = 1 / 60) {
  // The header is cheap but still not worth rewriting 60 times a second.
  const top = renderTop(g);
  if (top !== lastTop) { el('topStats').innerHTML = top; lastTop = top; }

  if (activeTab === 'operate') {
    const sig = operateSignature(g);
    if (staticDirty || sig !== lastOperateSig) {
      el('panel-operate').innerHTML = renderOperate(g);
      lastOperateSig = sig;
      staticDirty = false;
    }
    updateOperate(g, el('panel-operate'), dt);
    drawTrace(el('trace'), g);
  } else if (staticDirty) {
    if (activeTab === 'contracts') el('panel-contracts').innerHTML = renderContracts(g);
    if (activeTab === 'tech') el('panel-tech').innerHTML = renderTech(g);
    if (activeTab === 'workshop') el('panel-workshop').innerHTML = renderWorkshop(g);
    staticDirty = false;
  }

  // Settlement dialog pops once, when a job finishes.
  if (g.job?.done && !settleShown) {
    settleShown = true;
    openModal(settlementModal(g, g.job));
  }
}

function openModal(html) {
  el('modalBody').innerHTML = html;
  el('modal').classList.remove('hidden');
}
function closeModal() {
  el('modal').classList.add('hidden');
  modalTech = null;
}

function switchTab(tab) {
  activeTab = tab;
  staticDirty = true;
  for (const b of document.querySelectorAll('.tab')) {
    b.classList.toggle('is-active', b.dataset.tab === tab);
  }
  for (const p of ['operate', 'contracts', 'tech', 'workshop']) {
    el(`panel-${p}`).classList.toggle('hidden', p !== tab);
  }
  renderAll();
}

// ------------------------------------------------------------------- input

document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-act],[data-speed],[data-accept],[data-tech],[data-buy],[data-tab],[data-gov],[data-run]');
  if (!t) return;

  if (t.dataset.tab) return switchTab(t.dataset.tab);

  if (t.dataset.speed !== undefined) {
    g.speed = Number(t.dataset.speed);
    return markDirty();
  }

  if (t.dataset.accept) {
    const r = apply(acceptContract(g, t.dataset.accept));
    if (r.ok) { g.speed = 1; switchTab('operate'); }
    return;
  }

  if (t.dataset.tech) {
    modalTech = t.dataset.tech;
    return openModal(techModal(g, modalTech));
  }

  if (t.dataset.buy) {
    const r = apply(buyTech(g, t.dataset.buy));
    if (r.ok) { closeModal(); toast('Upgrade fitted.', 'good'); }
    else openModal(techModal(g, t.dataset.buy));
    return;
  }

  if (t.dataset.gov) return apply(setGovMode(g, t.dataset.gov));
  if (t.dataset.run) return apply(setRunMode(g, t.dataset.run));

  switch (t.dataset.act) {
    case 'start': return apply(startEngine(g));
    case 'field': return apply(setFieldBreaker(g, !g.machine.fieldClosed));
    case 'trip': return apply(setBreaker(g, false));
    case 'close': return apply(setBreaker(g, true));
    case 'reset-relays': return apply(resetRelays(g));
    case 'force-close':
      if (confirm('Force the breaker shut out of step?\n\nThe rotor will be dragged into step with the bus. Expect real damage.')) {
        apply(setBreaker(g, true, { force: true }));
      }
      return;
    case 'stop': return apply(stopEngine(g));
    case 'refuel': return apply(refuel(g));
    case 'buy-tank': return apply(buyTank(g));
    case 'refresh-board': return apply(refreshBoard(g));
    case 'abandon':
      if (confirm('Abandon this job? You will hand back the mobilisation advance and take a reputation hit.')) {
        apply(abandonJob(g));
      }
      return;
    case 'close-modal': return closeModal();
    case 'close-settle':
      clearFinishedJob(g);
      settleShown = false;
      closeModal();
      markDirty();
      return;
  }
});

// ---- levers and nudge switches --------------------------------------------
// Levers write straight through on input, and are marked while held so the
// per-frame patch does not fight the drag.
document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (!el.dataset || !el.dataset.lever) return;
  const v = Number(el.value);
  if (el.dataset.lever === 'throttle') setThrottle(g, v);
  else if (el.dataset.lever === 'exc') setExcitation(g, v);
});
for (const [down, up] of [['pointerdown', 'pointerup'], ['pointerdown', 'pointercancel']]) {
  document.addEventListener(down, (ev) => {
    const el = ev.target.closest?.('[data-lever]');
    if (el) el.dataset.dragging = '1';
  });
  document.addEventListener(up, () => {
    for (const el of document.querySelectorAll('[data-lever]')) delete el.dataset.dragging;
  });
}

// Raise/lower switches repeat while held, the way a real spring-return
// speed-trim switch does.
let nudgeTimer = null;
function stopNudge() {
  if (nudgeTimer) { clearInterval(nudgeTimer); nudgeTimer = null; }
}
document.addEventListener('pointerdown', (ev) => {
  const t = ev.target.closest?.('[data-nudge]');
  if (!t) return;
  ev.preventDefault();
  const step = Number(t.dataset.step);
  const which = t.dataset.nudge;
  const fire = () => {
    if (which === 'throttle') bumpThrottle(g, step);
    else if (which === 'droop') bumpDroop(g, step);
    else bumpExcitation(g, step);
  };
  fire();
  stopNudge();
  nudgeTimer = setInterval(fire, 70);
});
for (const e of ['pointerup', 'pointercancel', 'pointerleave']) {
  document.addEventListener(e, stopNudge);
}

el('btnSave').addEventListener('click', () => {
  const ok = save.save(g);
  toast(ok ? 'Saved.' : 'Could not save.', ok ? 'good' : 'bad');
});

el('btnReset').addEventListener('click', () => {
  if (!confirm('Open a new yard? The current career will be erased.')) return;
  save.clear();
  g = createGame();
  settleShown = false;
  switchTab('operate');
});

el('modal').addEventListener('click', (ev) => {
  if (ev.target === el('modal')) closeModal();
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') closeModal();
  if (ev.target.tagName === 'INPUT') return;
  // Space pauses; number keys step the time scale.
  if (ev.key === ' ') {
    ev.preventDefault();
    g.speed = g.speed === 0 ? 1 : 0;
    markDirty();
  }
  const idx = '123456'.indexOf(ev.key);
  if (idx >= 0 && idx < SPEEDS.length) { g.speed = SPEEDS[idx]; markDirty(); }

  // Arrows trim the throttle; shift trims the field instead.
  const fine = ev.altKey ? 0.001 : 0.005;
  if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
    ev.preventDefault();
    const d = (ev.key === 'ArrowUp' ? 1 : -1) * fine;
    if (ev.shiftKey) bumpExcitation(g, d * 2);
    else bumpThrottle(g, d);
  }
});

// -------------------------------------------------------------- frame loop

let last = performance.now();
let traceAccum = 0;
let saveAccum = 0;

function frame(now) {
  const realDt = Math.min((now - last) / 1000, 0.25);
  last = now;

  if (g.speed > 0 && !g.job?.done) {
    advance(g, realDt * g.speed);
  }

  // Sample the trace on wall-clock time so the plot scrolls at a readable
  // rate no matter how fast the sim is running.
  traceAccum += realDt;
  if (traceAccum >= 0.25) {
    traceAccum = 0;
    pushTrace(g);
  }

  saveAccum += realDt;
  if (saveAccum > 20) { saveAccum = 0; save.save(g); }

  renderAll(realDt);
  requestAnimationFrame(frame);
}

// Persist on the way out, so closing the tab never costs you a job in progress.
for (const ev of ['beforeunload', 'pagehide']) {
  window.addEventListener(ev, () => save.save(g));
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') save.save(g);
});

switchTab('operate');
requestAnimationFrame(frame);

// Exposed for debugging in the console and for the browser-driven checks.
window.game = () => g;
window.__refresh = () => { refreshSpec(g); markDirty(); };
