// Excerpt (adapted) from CaravelWay: tests for the confirm-or-cancel scheduler decision core.
// The cases mirror the production suite; the database harness is replaced by in-memory fakes. Run: node --test
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULTS, resolveWindow, shouldRunPass, planActions, perform } = require('./confirm-cycle-scheduler');

// A fixed clock: 2030-06-10, 12:30 local. Every fixture is built from it, never from the wall clock,
// so a run just before the top of an hour cannot flip a result.
const NOW = Date.parse('2030-06-10T12:30:00Z');
const H = 3600000;
const at = (hoursFromNow) => {
  const d = new Date(NOW + hoursFromNow * H).toISOString();
  return { pickupDate: d.slice(0, 10), pickupTime: d.slice(11, 16) };
};
const ctx = { backlogFloorId: 100, locationEmailsOn: () => true };
const booking = (over = {}) => ({
  id: 500, status: 'pending', customerDecision: null, customerEmail: 'guest@example.com',
  source: 'website', partnerBooking: false, reminderOptIn: false, forceEligible: false,
  pickupLocationId: 1, smsReachable: true,
  firstAskSentAt: null, reminderEmailSentAt: null, reminderSmsSentAt: null,
  ...at(4 * 24), ...over,
});
const types = (r, c = ctx, cfg = DEFAULTS) => planActions(r, NOW, c, cfg).map((a) => a.type);

test('send window: outside the window the pass does not run; a forced run ignores the window', () => {
  const window = { fromHour: 13, toHour: 14 }; // excludes 12:30
  assert.deepEqual(shouldRunPass(NOW, window), { run: false, reason: 'off-hours', hour: 12 });
  assert.equal(shouldRunPass(NOW, window, { force: true }).run, true);
});

test('pause is a kill switch: not even a forced run gets past it', () => {
  assert.deepEqual(shouldRunPass(NOW, { fromHour: 0, toHour: 24 }, { paused: true, force: true }), { run: false, reason: 'paused' });
});

test('an inverted window falls back to from->24 instead of silently sending nothing', () => {
  const logged = [];
  assert.deepEqual(resolveWindow(22, 2, (m) => logged.push(m)), { fromHour: 22, toHour: 24 });
  assert.equal(logged.length, 1);
});

test('first ask goes out inside the window, and only once', () => {
  assert.deepEqual(types(booking()), ['send_first_ask']);
  assert.deepEqual(types(booking({ firstAskSentAt: NOW - 1 * H })), []);
});

test('too far out, or already in the past: nothing', () => {
  assert.deepEqual(types(booking(at(6 * 24))), []);
  assert.deepEqual(types(booking(at(-30))), []);
});

test('last-minute: a pickup inside the lead time is marked once and never emailed', () => {
  const cfg = { ...DEFAULTS, minLeadHours: 8 };
  assert.deepEqual(types(booking(at(7)), ctx, cfg), ['mark_last_minute']);
  assert.deepEqual(types(booking({ ...at(7.9) }), ctx, cfg), ['mark_last_minute'], 'boundary just under the lead');
  assert.deepEqual(types(booking({ ...at(7), firstAskSentAt: NOW }), ctx, cfg), [], 'not re-marked next pass');
  assert.deepEqual(types(booking(at(9)), ctx, cfg), ['send_first_ask'], 'just outside the lead: normal ask');
});

test('regression: no reminder may be sent after the customer has collected the car', () => {
  // First ask went out 21h ago and pickup is 3h away: by date this is inside the escalation window
  // and past the minimum gap, so without the unconditional last-minute guard it would fire.
  const r = booking({ ...at(3), firstAskSentAt: NOW - 21 * H });
  assert.deepEqual(types(r, ctx, { ...DEFAULTS, minLeadHours: 8 }), []);
});

test('escalation: reminder email and SMS together, once the gap has passed', () => {
  assert.deepEqual(types(booking({ ...at(40), firstAskSentAt: NOW - 21 * H })), ['send_reminder_email', 'claim_then_send_sms']);
  assert.deepEqual(types(booking({ ...at(40), firstAskSentAt: NOW - 10 * H })), [], 'gap not met yet');
  assert.deepEqual(types(booking({ ...at(40), firstAskSentAt: NOW - 21 * H, smsReachable: false })), ['send_reminder_email']);
  assert.deepEqual(
    types(booking({ ...at(40), firstAskSentAt: NOW - 21 * H, reminderEmailSentAt: NOW - H })),
    ['claim_then_send_sms'],
    'each channel is tracked on its own',
  );
});

test('population: partner bookings never; desk bookings only when opted in; the backlog never', () => {
  assert.deepEqual(types(booking({ partnerBooking: true })), []);
  assert.deepEqual(types(booking({ source: 'desk' })), []);
  assert.deepEqual(types(booking({ source: 'desk', reminderOptIn: true })), ['send_first_ask']);
  assert.deepEqual(types(booking({ id: 50 })), [], 'created before launch');
  assert.deepEqual(types(booking({ id: 50, forceEligible: true })), ['send_first_ask'], 'explicit opt-in back-fill');
  assert.deepEqual(types(booking({ customerEmail: '' })), []);
  assert.deepEqual(types(booking({ status: 'confirmed' })), []);
});

test('a station with automated email switched off gets nothing, SMS included', () => {
  const muted = { ...ctx, locationEmailsOn: () => false };
  assert.deepEqual(types(booking({ ...at(40), firstAskSentAt: NOW - 21 * H }), muted), []);
});

test('silence never cancels: across every hour of the cycle, only messaging actions are produced', () => {
  const allowed = new Set(['mark_last_minute', 'send_first_ask', 'send_reminder_email', 'claim_then_send_sms']);
  for (let h = -24; h <= 6 * 24; h += 1) {
    for (const firstAskSentAt of [null, NOW - 30 * H]) {
      for (const t of types(booking({ ...at(h), firstAskSentAt }))) assert.ok(allowed.has(t), `h=${h}: ${t}`);
    }
  }
});

// ── performing actions: the two channels have opposite retry rules ───────────────────────────
function fakes({ mailError = null, smsOk = true, claimWins = true } = {}) {
  const calls = [];
  return {
    calls,
    store: {
      stamp: async (id, field, now, outcome) => calls.push(['stamp', field, outcome]),
      claimSms: async () => { calls.push(['claim']); return claimWins; },
    },
    mailer: { sendConfirmOrCancel: async () => { calls.push(['mail']); if (mailError) throw mailError; } },
    sms: { sendConfirmOrCancel: async () => { calls.push(['sms']); return { ok: smsOk }; } },
    now: NOW,
  };
}

test('email: send then stamp; a transient failure leaves no stamp so the next pass retries', async () => {
  const ok = fakes();
  assert.equal(await perform({ type: 'send_first_ask' }, booking(), ok), 'sent');
  assert.deepEqual(ok.calls, [['mail'], ['stamp', 'firstAskSentAt', 'sent']]);

  const flaky = fakes({ mailError: Object.assign(new Error('rate limited'), { status: 429 }) });
  assert.equal(await perform({ type: 'send_first_ask' }, booking(), flaky), 'failed');
  assert.deepEqual(flaky.calls, [['mail']], 'no stamp: retried next pass');
});

test('email: a permanent rejection is stamped as failed so it stops re-firing (booking stays pending)', async () => {
  const bad = fakes({ mailError: Object.assign(new Error('bad recipient'), { status: 422 }) });
  assert.equal(await perform({ type: 'send_first_ask' }, booking(), bad), 'failed');
  assert.deepEqual(bad.calls, [['mail'], ['stamp', 'firstAskSentAt', 'failed']]);
});

test('SMS: claim before sending; a failed send is never retried; a lost claim sends nothing', async () => {
  const failed = fakes({ smsOk: false });
  assert.equal(await perform({ type: 'claim_then_send_sms' }, booking(), failed), 'failed_no_retry');
  assert.deepEqual(failed.calls, [['claim'], ['sms']], 'the claim lands before the paid call');

  const lost = fakes({ claimWins: false });
  assert.equal(await perform({ type: 'claim_then_send_sms' }, booking(), lost), 'not_claimed');
  assert.deepEqual(lost.calls, [['claim']]);
});
