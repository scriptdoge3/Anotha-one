/**
 * Entry point: the frame loop, event wiring, and the bridge between DOM
 * events and the pure state functions in state.js.
 */

import {
  createGame, advance, acceptContract, abandonJob, clearFinishedJob,
  startEngine, stopEngine, setBreaker, refuel, buyTech, doService, buyTank,
  refreshBoard, SPEEDS,
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

function renderAll() {
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
    updateOperate(g, el('panel-operate'));
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
  const t = ev.target.closest('[data-act],[data-speed],[data-accept],[data-tech],[data-buy],[data-service],[data-tab]');
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

  if (t.dataset.service) return apply(doService(g, t.dataset.service));

  switch (t.dataset.act) {
    case 'start': return apply(startEngine(g));
    case 'stop': return apply(stopEngine(g));
    case 'breaker': return apply(setBreaker(g, !g.machine.breakerClosed));
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

el('btnSave').addEventListener('click', () => {
  const ok = save.save(g);
  toast(ok ? 'Saved.' : 'Could not save.', ok ? 'good' : 'bad');
});

el('btnReset').addEventListener('click', () => {
  if (!confirm('Start a new career? Your current progress will be erased.')) return;
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

  renderAll();
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

// Expose for debugging in the console.
window.game = () => g;
