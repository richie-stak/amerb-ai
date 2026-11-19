// A waiting line for the local model. One machine can only run a few generations at once; without
// a queue, the rest of the staff just see a frozen chat. Requests beyond the limit wait in strict
// first-come order and are told where they stand ("you're 3rd in line"). Models run by an
// external provider don't use this machine's capacity, so they never wait here.
//
// Settings (admin portal → Operations, stored in app_settings), with environment defaults:
//   queue_concurrency   generations at once            (CHAT_CONCURRENCY, default 2)
//   queue_max_waiting   people allowed to wait         (CHAT_MAX_WAITING, default 30)
//   queue_per_user      one person's active + waiting  (CHAT_PER_USER, default 2)
const { getSetting } = require('./settings');

function numberSetting(key, envName, fallback, { min = 0 } = {}) {
  const raw = getSetting(key, null);
  const value = Number(raw !== null && raw !== '' ? raw : process.env[envName]);
  return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
}

const limits = () => ({
  concurrency: numberSetting('queue_concurrency', 'CHAT_CONCURRENCY', 2, { min: 1 }),
  maxWaiting: numberSetting('queue_max_waiting', 'CHAT_MAX_WAITING', 30, { min: 0 }),
  perUser: numberSetting('queue_per_user', 'CHAT_PER_USER', 2, { min: 1 }),
});

class QueueFullError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'QueueFullError';
    this.code = code;
    this.status = 429;
  }
}

const active = new Set(); // { userId, startedAt }
const waiting = []; // { userId, queuedAt, grant, onUpdate }
let totalServed = 0;
let totalRejected = 0;
// Rolling average of how long a generation holds its slot, for the wait estimate.
const recentDurations = [];

function averageDurationMs() {
  if (!recentDurations.length) return 20_000;
  return recentDurations.reduce((a, b) => a + b, 0) / recentDurations.length;
}

// Tells everyone still waiting where they now stand.
function notifyWaiting() {
  const { concurrency } = limits();
  const per = averageDurationMs();
  waiting.forEach((entry, i) => {
    const position = i + 1;
    entry.onUpdate?.({
      state: 'waiting',
      position,
      ahead: i,
      waiting: waiting.length,
      etaSeconds: Math.max(1, Math.round((Math.ceil(position / concurrency) * per) / 1000)),
    });
  });
}

function pump() {
  const { concurrency } = limits();
  while (waiting.length && active.size < concurrency) {
    const next = waiting.shift();
    next.grant();
  }
  notifyWaiting();
}

function makeRelease(slot) {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active.delete(slot);
    recentDurations.push(Date.now() - slot.startedAt);
    if (recentDurations.length > 20) recentDurations.shift();
    totalServed += 1;
    pump();
  };
}

// Resolves with a release() function once a slot is free. `onUpdate` receives
// { state: 'waiting', position, waiting, etaSeconds } while queued and { state: 'running' } when the
// turn begins (not called at all if a slot was free immediately). Rejects with QueueFullError when
// the line is full or this person already has too many requests going, and with an AbortError if
// `signal` fires while waiting — the request then simply leaves the line.
// Why this person couldn't join the line right now, or null if they can. Checked up front (before
// a message is saved) so a rejected message doesn't leave a half-created conversation behind.
function refusal(userId) {
  const { concurrency, maxWaiting, perUser } = limits();
  const mine = [...active].filter((s) => s.userId === userId).length + waiting.filter((w) => w.userId === userId).length;
  if (mine >= perUser) {
    return new QueueFullError(
      `You already have ${mine} message${mine === 1 ? '' : 's'} being answered. Wait for one to finish, then send the next.`,
      'per_user_limit'
    );
  }
  const wouldWait = active.size >= concurrency || waiting.length > 0;
  if (wouldWait && waiting.length >= maxWaiting) {
    return new QueueFullError('AMERB AI is very busy right now. Please try again in a minute.', 'queue_full');
  }
  return null;
}

function precheck(userId) {
  const err = refusal(userId);
  if (err) totalRejected += 1;
  return err;
}

function acquire(userId, { signal, onUpdate } = {}) {
  const { concurrency } = limits();

  const err = refusal(userId);
  if (err) {
    totalRejected += 1;
    return Promise.reject(err);
  }

  if (active.size < concurrency && !waiting.length) {
    const slot = { userId, startedAt: Date.now() };
    active.add(slot);
    return Promise.resolve(makeRelease(slot));
  }

  return new Promise((resolve, reject) => {
    const entry = {
      userId,
      queuedAt: Date.now(),
      onUpdate,
      grant: () => {
        signal?.removeEventListener('abort', onAbort);
        const slot = { userId, startedAt: Date.now() };
        active.add(slot);
        onUpdate?.({ state: 'running', waited: Date.now() - entry.queuedAt });
        resolve(makeRelease(slot));
      },
    };
    const cancelled = () => {
      const err = new Error('Request cancelled while waiting');
      err.name = 'AbortError';
      return err;
    };
    const onAbort = () => {
      const i = waiting.indexOf(entry);
      if (i === -1) return;
      waiting.splice(i, 1);
      notifyWaiting();
      reject(cancelled());
    };
    if (signal?.aborted) return reject(cancelled());
    signal?.addEventListener('abort', onAbort, { once: true });
    waiting.push(entry);
    notifyWaiting();
  });
}

function stats() {
  const l = limits();
  const now = Date.now();
  return {
    ...l,
    active: active.size,
    waiting: waiting.length,
    oldestWaitSeconds: waiting.length ? Math.round((now - waiting[0].queuedAt) / 1000) : 0,
    averageSeconds: Math.round(averageDurationMs() / 1000),
    served: totalServed,
    rejected: totalRejected,
  };
}

module.exports = { acquire, precheck, stats, limits, QueueFullError };
