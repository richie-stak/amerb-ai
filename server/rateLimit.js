// Per-person message limits, so one user (or a runaway script) can't use up the whole machine.
// A sliding window: each person may send N messages in any 60 seconds and M in any hour.
// Counts live in memory — a restart resets them, which is fine for a fairness guard.
//
//   rate_limit_per_minute   (default 15, 0 = no limit)
//   rate_limit_per_hour     (default 300, 0 = no limit)
const { getSetting } = require('./settings');

function numberSetting(key, fallback) {
  const raw = getSetting(key, null);
  const value = Number(raw);
  return raw !== null && raw !== '' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

const limits = () => ({
  perMinute: numberSetting('rate_limit_per_minute', 15),
  perHour: numberSetting('rate_limit_per_hour', 300),
});

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const hits = new Map(); // userId -> ascending timestamps of messages within the last hour
let totalLimited = 0;

// Records one message for this person. Returns { ok: true }, or { ok: false, retryAfterSeconds,
// message } when they're over a limit (the attempt is then not counted).
function consume(userId, now = Date.now()) {
  const { perMinute, perHour } = limits();
  const list = hits.get(userId) || [];
  while (list.length && list[0] <= now - HOUR) list.shift();

  const lastMinute = list.filter((t) => t > now - MINUTE);
  let retryAt = 0;
  let which = '';
  if (perMinute && lastMinute.length >= perMinute) {
    retryAt = lastMinute[lastMinute.length - perMinute] + MINUTE;
    which = `${perMinute} messages a minute`;
  }
  if (perHour && list.length >= perHour) {
    const hourRetry = list[list.length - perHour] + HOUR;
    if (hourRetry > retryAt) {
      retryAt = hourRetry;
      which = `${perHour} messages an hour`;
    }
  }
  if (retryAt) {
    totalLimited += 1;
    const retryAfterSeconds = Math.max(1, Math.ceil((retryAt - now) / 1000));
    const wait = retryAfterSeconds >= 90 ? `${Math.ceil(retryAfterSeconds / 60)} minutes` : `${retryAfterSeconds} seconds`;
    return {
      ok: false,
      retryAfterSeconds,
      message: `You're sending messages faster than the limit of ${which}. Please wait about ${wait} and try again.`,
    };
  }
  list.push(now);
  hits.set(userId, list);
  return { ok: true };
}

// Drops people who haven't sent anything for an hour, so the map can't grow forever.
function sweep(now = Date.now()) {
  for (const [userId, list] of hits) {
    if (!list.length || list[list.length - 1] <= now - HOUR) hits.delete(userId);
  }
}
setInterval(sweep, 10 * MINUTE).unref();

const stats = () => ({ ...limits(), trackedUsers: hits.size, blocked: totalLimited });

module.exports = { consume, stats, limits };
