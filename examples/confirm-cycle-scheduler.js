// Excerpt (adapted) from CaravelWay: the decision core of the confirm-or-cancel scheduler.
// Storage, multi-tenancy and the email/SMS provider calls are stripped out; identifiers are renamed.
'use strict';

// Every timing is configuration, not a constant. These are the defaults.
const DEFAULTS = Object.freeze({
  firstAskDays: 5,  // first "confirm or cancel" email goes out this many days before pickup
  escalateDays: 2,  // escalation (reminder email + SMS) this many days before pickup
  minGapHours: 20,  // never escalate sooner than this after the first ask
  minLeadHours: 6,  // a pickup nearer than this is last-minute: skip it, leave it for staff
  sendFromHour: 8,  // local send window, inclusive
  sendToHour: 22,   // local send window, exclusive
});

// A send window that is empty or inverted (e.g. 22 -> 2) must not silently stop every reminder.
// Fall back to "from -> midnight" and say so, rather than sending nothing.
function resolveWindow(fromHour, toHour, log = console.error) {
  if (toHour > fromHour) return { fromHour, toHour };
  log(`send window ${fromHour}->${toHour} is empty or inverted; using ${fromHour}->24`);
  return { fromHour, toHour: 24 };
}

// Times are local wall-clock values carried as epoch milliseconds, so getUTC* reads the local
// clock. The production code uses the same convention for the station's time zone.
const HOUR = 3600000;

// Pass-level gates. A pause is a kill switch for the whole cycle: nothing is sent and nothing is
// stamped, and not even a forced run gets past it. Outside the window, nobody gets a 03:00 email.
function shouldRunPass(nowMs, window, { paused = false, force = false } = {}) {
  if (paused) return { run: false, reason: 'paused' };
  const hour = new Date(nowMs).getUTCHours();
  if (!force && (hour < window.fromHour || hour >= window.toHour)) return { run: false, reason: 'off-hours', hour };
  return { run: true };
}

const DAY = 24 * HOUR;
const dateOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const daysBetween = (fromYmd, toYmd) => Math.round((Date.parse(toYmd) - Date.parse(fromYmd)) / DAY);

function pickupMs(r) {
  const m = /^(\d{1,2}):(\d{2})/.exec(r.pickupTime || '');
  if (!r.pickupDate || !m) return null;
  const ms = Date.parse(`${r.pickupDate}T${m[1].padStart(2, '0')}:${m[2]}:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

// WHO is in the cycle. One definition, read by both the sender and the staff dashboard, so the
// dashboard can never show a different population from the one that actually gets emailed.
function inCyclePopulation(r, { backlogFloorId }) {
  if (r.partnerBooking) return false;                       // the partner owns that customer
  if (r.source === 'desk' && !r.reminderOptIn) return false; // desk bookings only when staff tick it
  if (r.id <= backlogFloorId && !r.forceEligible) return false; // never email the pre-launch backlog
  return r.status === 'pending' && !r.customerDecision && Boolean(r.customerEmail);
}

// The decision for ONE reservation on ONE pass. Returns a list of actions; the caller performs them.
// There is deliberately no "cancel" action: silence never cancels a booking, it flags it for staff.
function planActions(r, nowMs, ctx, cfg = DEFAULTS) {
  if (!inCyclePopulation(r, ctx)) return [];
  if (!ctx.locationEmailsOn(r.pickupLocationId)) return []; // staff muted automated mail for this station

  const today = dateOf(nowMs);
  const daysOut = daysBetween(today, r.pickupDate);
  if (daysOut < 0 || daysOut > cfg.firstAskDays) return [];

  // Last-minute guard. It returns unconditionally (not just "once"): a pickup at 01:00 tomorrow is
  // still inside the escalation window this evening, and without this it would get its reminder
  // after the customer has already collected the car.
  const p = pickupMs(r);
  if (p !== null && (p - nowMs) / HOUR < cfg.minLeadHours) {
    return r.firstAskSentAt ? [] : [{ type: 'mark_last_minute' }];
  }

  if (!r.firstAskSentAt) return [{ type: 'send_first_ask' }]; // "<=" so a missed exact day still sends

  const sinceFirstAsk = (nowMs - r.firstAskSentAt) / HOUR;
  if (daysOut > cfg.escalateDays || sinceFirstAsk < cfg.minGapHours) return [];

  // Escalation: email and SMS together, each tracked on its own so one failing never blocks the other.
  const actions = [];
  if (!r.reminderEmailSentAt) actions.push({ type: 'send_reminder_email' });
  if (!r.reminderSmsSentAt && r.smsReachable) actions.push({ type: 'claim_then_send_sms' });
  return actions;
}

// Which failures are worth retrying. Rate limits, 5xx, network errors and auth errors clear on their
// own or after a config fix; any other 4xx rejects this exact message and retrying cannot help.
const TRANSIENT_4XX = new Set([401, 403, 408, 425, 429]);
const isPermanent = (err) => {
  const s = err && err.status;
  return typeof s === 'number' && s >= 400 && s < 500 && !TRANSIENT_4XX.has(s);
};

// How each action is carried out. The two channels get opposite idempotency rules on purpose:
//  - email is free, so SEND then STAMP: a failed send leaves no stamp and is retried next pass;
//  - SMS costs money and a timeout is ambiguous (it may have been delivered), so CLAIM then SEND:
//    the stamp is committed first and a failure is never retried. At most once, never twice.
async function perform(action, r, { store, mailer, sms, now }) {
  switch (action.type) {
    case 'mark_last_minute':
      await store.stamp(r.id, 'firstAskSentAt', now, 'skipped_last_minute');
      return 'skipped';
    case 'send_first_ask':
    case 'send_reminder_email': {
      const field = action.type === 'send_first_ask' ? 'firstAskSentAt' : 'reminderEmailSentAt';
      try {
        await mailer.sendConfirmOrCancel(r, { reminder: action.type === 'send_reminder_email' });
      } catch (err) {
        if (isPermanent(err)) await store.stamp(r.id, field, now, 'failed'); // give up once, stay pending
        return 'failed';
      }
      await store.stamp(r.id, field, now, 'sent');
      return 'sent';
    }
    case 'claim_then_send_sms': {
      // Conditional claim: only wins while the booking is still pending, unanswered and unclaimed.
      const claimed = await store.claimSms(r.id, now);
      if (!claimed) return 'not_claimed';
      const res = await sms.sendConfirmOrCancel(r).catch(() => ({ ok: false }));
      return res.ok ? 'sent' : 'failed_no_retry';
    }
    default:
      throw new Error(`unknown action ${action.type}`);
  }
}

module.exports = { DEFAULTS, resolveWindow, shouldRunPass, inCyclePopulation, planActions, perform, isPermanent };
