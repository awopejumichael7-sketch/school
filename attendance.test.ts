import { describe, it, expect } from 'vitest';
import {
  attendancePercent, countRecords, emptyCounts, addCounts, totalOf, policyOf, DEFAULT_POLICY, addDays, weekdayOf, weekRange, monthRange,
  monthKeysBetween, todayInZone, dayDiff, buildReport, lowAttendance, parseScan, qrPayload, attendanceDocId, buildAttendanceCreate,
  buildAttendanceUpdate, type DayDoc, type Status,
} from './lib-attendance';

describe('attendance percentage', () => {
  it('matches the spec example: 42 present + 3 absent = 93.33%', () => {
    expect(attendancePercent({ P: 42, A: 3, L: 0, E: 0 })).toBe(93.33);
  });
  it('returns null when nothing is recorded (never a misleading 0%)', () => {
    expect(attendancePercent(emptyCounts())).toBeNull();
    expect(attendancePercent({ P: 0, A: 0, L: 0, E: 4 })).toBeNull(); // only excused days, excluded by default
  });
  it('late and excused follow the school policy', () => {
    const c = { P: 8, A: 1, L: 1, E: 1 };
    expect(attendancePercent(c)).toBe(90);                                                  // (8+1)/(8+1+1)
    expect(attendancePercent(c, { lateCountsAsPresent: false, excusedCountsAsAbsent: false })).toBe(80);   // 8/10
    expect(attendancePercent(c, { lateCountsAsPresent: true, excusedCountsAsAbsent: true })).toBe(81.82);  // 9/11
    expect(attendancePercent(c, { lateCountsAsPresent: false, excusedCountsAsAbsent: true })).toBe(72.73); // 8/11
  });
  it('policyOf fills in defaults', () => {
    expect(policyOf(undefined)).toEqual(DEFAULT_POLICY);
    expect(policyOf({ excusedCountsAsAbsent: true })).toEqual({ lateCountsAsPresent: true, excusedCountsAsAbsent: true });
  });
  it('counts records', () => {
    const r: Record<string, Status> = { a: 'P', b: 'P', c: 'A', d: 'L', e: 'E' };
    expect(countRecords(r)).toEqual({ P: 2, A: 1, L: 1, E: 1 });
    expect(totalOf(countRecords(r))).toBe(5);
    expect(addCounts({ P: 1, A: 2, L: 3, E: 4 }, { P: 1, A: 1, L: 1, E: 1 })).toEqual({ P: 2, A: 3, L: 4, E: 5 });
  });
});

describe('dates', () => {
  it('adds days across month, year and leap boundaries', () => {
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2025-02-28', 1)).toBe('2025-03-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('weeks run Monday to Sunday', () => {
    expect(weekdayOf('2026-10-14')).toBe(3); // Wednesday
    expect(weekRange('2026-10-14')).toEqual({ from: '2026-10-12', to: '2026-10-18' });
    expect(weekRange('2026-10-18')).toEqual({ from: '2026-10-12', to: '2026-10-18' }); // Sunday belongs to the week before
    expect(weekRange('2026-10-12')).toEqual({ from: '2026-10-12', to: '2026-10-18' });
    expect(weekRange('2026-12-30')).toEqual({ from: '2026-12-28', to: '2027-01-03' }); // crosses the year
  });
  it('month ranges and keys', () => {
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthRange('2024-02').to).toBe('2024-02-29');
    expect(monthKeysBetween('2026-09-14', '2026-09-30')).toEqual(['2026-09']);
    expect(monthKeysBetween('2026-11-20', '2027-02-05')).toEqual(['2026-11', '2026-12', '2027-01', '2027-02']);
    expect(dayDiff('2026-10-14', '2026-10-07')).toBe(7);
  });
  it("'today' is the school's date, not the server's", () => {
    const lateUtc = new Date('2026-10-14T23:30:00Z');
    expect(todayInZone('Africa/Lagos', lateUtc)).toBe('2026-10-15');  // UTC+1: already tomorrow
    expect(todayInZone('UTC', lateUtc)).toBe('2026-10-14');
    expect(todayInZone('America/Los_Angeles', lateUtc)).toBe('2026-10-14');
    expect(todayInZone('Not/AZone', lateUtc)).toMatch(/^\d{4}-\d{2}-\d{2}$/); // falls back, never throws
  });
});

describe('reports', () => {
  const day = (date: string, records: Record<string, Status>, names: Record<string, string> = { a: 'Ada', b: 'Bola', c: 'Chidi' }): DayDoc => ({ classId: 'jss-1', date, records, names });
  const docs = [
    day('2026-10-12', { a: 'P', b: 'A', c: 'P' }),
    day('2026-10-13', { a: 'P', b: 'L', c: 'P' }),
    day('2026-10-14', { a: 'A', b: 'A', c: 'P' }),
    day('2026-10-20', { a: 'P', b: 'P', c: 'P' }),   // outside the week
  ];
  it('builds per-day, per-student and class summaries for a range', () => {
    const r = buildReport(docs, '2026-10-12', '2026-10-18');
    expect(r.summary.daysRecorded).toBe(3);
    expect(r.summary.counts).toEqual({ P: 5, A: 3, L: 1, E: 0 });
    expect(r.summary.pct).toBe(66.67);          // (5+1)/(5+1+3)
    expect(r.days.map((d) => d.date)).toEqual(['2026-10-12', '2026-10-13', '2026-10-14']);
    expect(r.days[0]).toMatchObject({ total: 3, pct: 66.67 });
    const ada = r.students.find((s) => s.id === 'a')!;
    expect(ada).toMatchObject({ name: 'Ada', recorded: 3, pct: 66.67, counts: { P: 2, A: 1, L: 0, E: 0 } });
    expect(r.students.find((s) => s.id === 'c')!.pct).toBe(100);
    expect(r.students.map((s) => s.name)).toEqual(['Ada', 'Bola', 'Chidi']); // sorted
  });
  it('range is inclusive, order-independent, and empty ranges are safe', () => {
    expect(buildReport([...docs].reverse(), '2026-10-12', '2026-10-12').summary.daysRecorded).toBe(1);
    const none = buildReport(docs, '2027-01-01', '2027-01-31');
    expect(none.summary).toEqual({ daysRecorded: 0, counts: emptyCounts(), pct: null });
    expect(none.students).toEqual([]);
  });
  it('keeps students who left the roster, using the latest recorded name', () => {
    const r = buildReport([day('2026-10-12', { x: 'P' }, { x: 'Old Name' }), day('2026-10-13', { x: 'A' }, { x: 'New Name' })], '2026-10-01', '2026-10-31');
    expect(r.students).toHaveLength(1);
    expect(r.students[0]!.name).toBe('New Name');
  });
  it('flags students below the threshold but never those with no data', () => {
    const r = buildReport(docs, '2026-10-12', '2026-10-18');
    expect(lowAttendance(r.students, 80).map((s) => s.name)).toEqual(['Ada', 'Bola']);
    expect(lowAttendance([{ id: 'z', name: 'Z', counts: emptyCounts(), recorded: 0, pct: null }], 80)).toEqual([]);
  });
  it('the policy changes the result consistently across days, students and summary', () => {
    const strict = { lateCountsAsPresent: false, excusedCountsAsAbsent: false };
    const r = buildReport(docs, '2026-10-12', '2026-10-18', strict);
    expect(r.summary.pct).toBe(55.56);          // 5/9
    expect(r.students.find((s) => s.id === 'b')!.pct).toBe(0);
  });
});

describe('scanner / QR input', () => {
  it('accepts plain admission numbers and school QR payloads, normalising case', () => {
    expect(parseScan('rsa-2026-0001')).toEqual({ slug: null, admission: 'RSA-2026-0001' });
    expect(parseScan('  RSA-2026-0001\n')).toEqual({ slug: null, admission: 'RSA-2026-0001' });
    expect(parseScan(qrPayload('royal', 'rsa-2026-0001'))).toEqual({ slug: 'royal', admission: 'RSA-2026-0001' });
  });
  it('rejects junk and path-like input', () => {
    for (const bad of ['', '  ', 'a/b/c', 'SCH1:royal', 'SCH1::X', '<script>', 'AB', 'x'.repeat(40)]) expect(parseScan(bad), bad).toBeNull();
  });
});

describe('attendance documents', () => {
  const rec: Record<string, Status> = { a: 'P', b: 'A' };
  it('id is class + date; create carries counts that match the records', () => {
    expect(attendanceDocId('jss-1', '2026-10-14')).toBe('jss-1_2026-10-14');
    const d = buildAttendanceCreate({ tenantId: 't', classId: 'jss-1', date: '2026-10-14', session: '2026/2027', records: rec, names: { a: 'A', b: 'B' }, takenBy: 'u', takenByName: 'U' });
    expect(d).toMatchObject({ month: '2026-10', counts: { P: 1, A: 1, L: 0, E: 0 }, total: 2, classId: 'jss-1', takenBy: 'u' });
    const u = buildAttendanceUpdate({ records: rec, names: {}, updatedBy: 'u' });
    for (const k of ['tenantId', 'classId', 'date', 'month', 'createdAt', 'takenBy']) expect(u).not.toHaveProperty(k);
    expect(u).toMatchObject({ total: 2, counts: { P: 1, A: 1, L: 0, E: 0 } });
  });
});
