import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStateDb } from '../src/db.js';
import {
  ScheduleStore,
  ScheduleError,
  latestOccurrence,
  nextOccurrence,
  wallTimeToUtc,
  parseAtTime,
  validateScheduleInput,
  isValidTimezone,
} from '../src/schedules.js';

const daily = (overrides = {}) => ({
  frequency: 'daily',
  at_hour: 3,
  at_minute: 0,
  day_of_week: null,
  day_of_month: null,
  timezone: 'UTC',
  ...overrides,
});

test('daily occurrence: today when the time has passed, yesterday otherwise', () => {
  const s = daily();
  const afterTime = latestOccurrence(s, new Date('2026-07-21T12:00:00Z'));
  assert.equal(afterTime.at.toISOString(), '2026-07-21T03:00:00.000Z');
  assert.equal(afterTime.occurrenceKey, '2026-07-21');

  const beforeTime = latestOccurrence(s, new Date('2026-07-21T02:00:00Z'));
  assert.equal(beforeTime.at.toISOString(), '2026-07-20T03:00:00.000Z');
  assert.equal(beforeTime.occurrenceKey, '2026-07-20');
});

test('daily occurrence respects the schedule timezone (America/New_York, EDT)', () => {
  const s = daily({ timezone: 'America/New_York' });
  // 03:00 New York in July = 07:00 UTC.
  const r = latestOccurrence(s, new Date('2026-07-21T08:00:00Z'));
  assert.equal(r.at.toISOString(), '2026-07-21T07:00:00.000Z');
  assert.equal(r.occurrenceKey, '2026-07-21');
});

test('DST gap: a nonexistent wall time resolves to the instant after the gap', () => {
  // 2026-03-08 02:30 America/New_York does not exist (02:00 -> 03:00).
  const resolved = wallTimeToUtc('America/New_York', 2026, 3, 8, 2, 30);
  assert.equal(resolved.toISOString(), '2026-03-08T07:30:00.000Z'); // 03:30 EDT
});

test('weekly occurrence lands on the configured weekday', () => {
  const s = daily({ frequency: 'weekly', day_of_week: 1, at_hour: 5 }); // Monday 05:00 UTC
  // Wednesday 2026-07-22 -> latest Monday is 2026-07-20.
  const r = latestOccurrence(s, new Date('2026-07-22T12:00:00Z'));
  assert.equal(r.at.toISOString(), '2026-07-20T05:00:00.000Z');
  assert.equal(r.occurrenceKey, '2026-07-20');

  const next = nextOccurrence(s, new Date('2026-07-22T12:00:00Z'));
  assert.equal(next.toISOString(), '2026-07-27T05:00:00.000Z');
});

test('monthly day-of-month is clamped to the last day of shorter months', () => {
  const s = daily({ frequency: 'monthly', day_of_month: 31, at_hour: 0 });
  // On 1 May, the latest occurrence is 30 April (April has 30 days).
  const r = latestOccurrence(s, new Date('2026-05-01T12:00:00Z'));
  assert.equal(r.at.toISOString(), '2026-04-30T00:00:00.000Z');
  assert.equal(r.occurrenceKey, '2026-04');

  const next = nextOccurrence(s, new Date('2026-05-01T12:00:00Z'));
  assert.equal(next.toISOString(), '2026-05-31T00:00:00.000Z');
});

test('nextOccurrence for a daily schedule is strictly in the future', () => {
  const s = daily();
  const next = nextOccurrence(s, new Date('2026-07-21T03:00:00Z')); // exactly at the occurrence
  assert.equal(next.toISOString(), '2026-07-22T03:00:00.000Z');
});

test('validation rejects cron-like frequencies, bad times, and bad timezones', () => {
  assert.throws(
    () => validateScheduleInput({ frequency: '*/5 * * * *', atHour: 3, atMinute: 0, timezone: 'UTC' }),
    ScheduleError,
  );
  assert.throws(() => parseAtTime('25:00'), ScheduleError);
  assert.throws(() => parseAtTime('3pm'), ScheduleError);
  assert.deepEqual(parseAtTime('03:30'), { atHour: 3, atMinute: 30 });
  assert.equal(isValidTimezone('Africa/Cairo'), true);
  assert.equal(isValidTimezone('Mars/Olympus'), false);
  assert.throws(
    () => validateScheduleInput({ frequency: 'weekly', atHour: 3, atMinute: 0, timezone: 'UTC', dayOfWeek: 9 }),
    ScheduleError,
  );
  assert.throws(
    () => validateScheduleInput({ frequency: 'daily', atHour: 3, atMinute: 0, timezone: 'UTC', projectId: 'x; rm -rf /' }),
    ScheduleError,
  );
});

test('schedule store: create (disabled), enable, update, list, delete', () => {
  const db = openStateDb(':memory:');
  const store = new ScheduleStore(db);

  const created = store.create({ frequency: 'daily', atHour: 3, atMinute: 0 });
  assert.equal(created.enabled, 0, 'schedules must be created disabled');
  assert.equal(created.timezone, 'Africa/Cairo', 'default timezone is the contract timezone');

  assert.equal(store.list({ enabledOnly: true }).length, 0);
  store.setEnabled(created.id, true);
  assert.equal(store.list({ enabledOnly: true }).length, 1);

  const updated = store.update(created.id, { atHour: 4, atMinute: 30, timezone: 'UTC' });
  assert.equal(updated.at_hour, 4);
  assert.equal(updated.timezone, 'UTC');
  assert.equal(updated.enabled, 1, 'update must not change enablement');

  assert.throws(() => store.update(created.id, { frequency: 'weekly' }), ScheduleError,
    'weekly without day_of_week must be rejected');

  store.delete(created.id);
  assert.equal(store.list().length, 0);
  assert.throws(() => store.setEnabled(created.id, true), ScheduleError);
  db.close();
});
