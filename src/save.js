import { newMachine } from './sim.js';
import { specFor } from './state.js';

const KEY = 'loadbank.save.v1';

/** Only persist authored state; spec and derived telemetry are rebuilt. */
const FIELDS = [
  'version', 'money', 'reputation', 'day', 'owned', 'tankBonusL', 'boardSeed',
  'completed', 'failedJobs', 'cleanRuns', 'lifetimeEarned', 'lifetimeFuelL',
  'lifetimeEnergyKWh', 'fuelPriceMult', 'log',
];

export function save(g) {
  try {
    const data = {};
    for (const f of FIELDS) data[f] = g[f];
    data.machine = g.machine;
    // A job in progress holds a contract object; store it whole so repeat and
    // filler contracts survive a reload.
    data.job = g.job
      ? { contract: g.job.contract, progress: g.job.progress, done: g.job.done, result: g.job.result, advance: g.job.advance }
      : null;
    localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data.version !== 1) return null;
    const g = { ...data, speed: 0 };
    g.spec = specFor(g);
    g.machine = { ...newMachine(g.spec), ...(data.machine ?? {}) };
    g.log = g.log ?? [];
    return g;
  } catch {
    return null;
  }
}

export function clear() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
