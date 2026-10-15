import { serverTimestamp } from 'firebase/firestore';

export type Status = 'P' | 'A' | 'L' | 'E';
export const STATUSES: Status[] = ['P', 'A', 'L', 'E'];
export const STATUS_LABEL: Record<Status, string> = { P: 'Present', A: 'Absent', L: 'Late', E: 'Excused' };
export interface Counts { P: number; A: number; L: number; E: number }

/**
 * Schools differ on whether lateness or excused absence counts against a student, so it is a setting.
 * Defaults: Late counts as attended; Excused days are left out of the calculation.
 */
export interface Policy { lateCountsAsPresent: boolean; excusedCountsAsAbsent: boolean }
export const DEFAULT_POLICY: Policy = { lateCountsAsPresent: true, excusedCountsAsAbsent: false };
export function policyOf(a?: Partial<Policy> | null): Policy {
  return {
    lateCountsAsPresent: a?.lateCountsAsPresent ?? DEFAULT_POLICY.lateCountsAsPresent,
    excusedCountsAsAbsent: a?.excusedCountsAsAbsent ?? DEFAULT_POLICY.excusedCountsAsAbsent,
  };
}

export const emptyCounts = (): Counts => ({ P: 0, A: 0, L: 0, E: 0 });
export function countRecords(records: Record<string, Status>): Counts {
  const c = emptyCounts();
  for (const s of Object.values(records)) if (s in c) c[s] += 1;
  return c;
}
export const addCounts = (a: Counts, b: Counts): Counts => ({ P: a.P + b.P, A: a.A + b.A, L: a.L + b.L, E: a.E + b.E });
export const totalOf = (c: Counts) => c.P + c.A + c.L + c.E;

/** Spec example: 42 present, 3 absent -> 42 / 45 x 100 = 93.33. Returns null when there is nothing to measure. */
export function attendancePercent(c: Counts, p: Policy = DEFAULT_POLICY): number | null {
  const possible = c.P + c.A + c.L + (p.excusedCountsAsAbsent ? c.E : 0);
  if (possible === 0) return null;
  const attended = c.P + (p.lateCountsAsPresent ? c.L : 0);
  return Math.round((attended / possible) * 10000) / 100;
}

// ------------------------------------------------------------------- dates (YYYY-MM-DD, no time-zone traps)
const pad = (n: number) => String(n).padStart(2, '0');
function parts(iso: string): [number, number, number] {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return [y, m, d];
}
export function addDays(iso: string, n: number): string {
  const [y, m, d] = parts(iso);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}
export function weekdayOf(iso: string): number {
  const [y, m, d] = parts(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
}
/** Monday to Sunday containing the date. */
export function weekRange(iso: string): { from: string; to: string } {
  const from = addDays(iso, -((weekdayOf(iso) + 6) % 7));
  return { from, to: addDays(from, 6) };
}
export function monthRange(ym: string): { from: string; to: string } {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return { from: `${ym}-01`, to: `${ym}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}` };
}
export function monthKeysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = parts(from);
  const [ey, em] = parts(to);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${pad(m)}`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}
/** Today's date in the SCHOOL's time zone (a Lagos school at 23:30 UTC is already tomorrow). */
export function todayInZone(tz: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }
}
export const dayDiff = (later: string, earlier: string): number => {
  const [y1, m1, d1] = parts(later); const [y2, m2, d2] = parts(earlier);
  return Math.round((Date.UTC(y1, m1 - 1, d1) - Date.UTC(y2, m2 - 1, d2)) / 86_400_000);
};

// ------------------------------------------------------------------------------ documents
export const attendanceDocId = (classId: string, date: string) => `${classId}_${date}`;

export interface DayDoc {
  classId: string;
  date: string;
  records: Record<string, Status>;
  names: Record<string, string>;
}

export function buildAttendanceCreate(i: {
  tenantId: string; classId: string; date: string; session: string;
  records: Record<string, Status>; names: Record<string, string>; takenBy: string; takenByName: string;
}): Record<string, unknown> {
  const counts = countRecords(i.records);
  return {
    tenantId: i.tenantId, classId: i.classId, date: i.date, month: i.date.slice(0, 7), session: i.session,
    records: i.records, names: i.names, counts, total: totalOf(counts),
    takenBy: i.takenBy, takenByName: i.takenByName, createdAt: serverTimestamp(),
  };
}
export function buildAttendanceUpdate(i: {
  records: Record<string, Status>; names: Record<string, string>; updatedBy: string;
}): Record<string, unknown> {
  const counts = countRecords(i.records);
  return { records: i.records, names: i.names, counts, total: totalOf(counts), updatedAt: serverTimestamp(), updatedBy: i.updatedBy };
}

// -------------------------------------------------------------------------------- reports
export interface StudentRow { id: string; name: string; counts: Counts; recorded: number; pct: number | null }
export interface DayRow { date: string; counts: Counts; total: number; pct: number | null }
export interface Report {
  from: string; to: string;
  days: DayRow[];
  students: StudentRow[];
  summary: { daysRecorded: number; counts: Counts; pct: number | null };
}

export function buildReport(docs: DayDoc[], from: string, to: string, policy: Policy = DEFAULT_POLICY): Report {
  const inRange = docs.filter((d) => d.date >= from && d.date <= to).sort((a, b) => a.date.localeCompare(b.date));
  const per = new Map<string, StudentRow>();
  const days: DayRow[] = [];
  let all = emptyCounts();
  for (const d of inRange) {
    const dc = countRecords(d.records);
    all = addCounts(all, dc);
    days.push({ date: d.date, counts: dc, total: totalOf(dc), pct: attendancePercent(dc, policy) });
    for (const [id, status] of Object.entries(d.records)) {
      let row = per.get(id);
      if (!row) { row = { id, name: d.names[id] ?? id, counts: emptyCounts(), recorded: 0, pct: null }; per.set(id, row); }
      if (d.names[id]) row.name = d.names[id] as string; // latest name wins (docs are in date order)
      row.counts[status] += 1;
    }
  }
  const students = [...per.values()].map((r) => ({ ...r, recorded: totalOf(r.counts), pct: attendancePercent(r.counts, policy) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { from, to, days, students, summary: { daysRecorded: days.length, counts: all, pct: attendancePercent(all, policy) } };
}

/** Students below the threshold (students with nothing recorded are never flagged). */
export const lowAttendance = (rows: StudentRow[], thresholdPct: number) =>
  rows.filter((r) => r.pct !== null && r.pct < thresholdPct);

// ------------------------------------------------------------------- QR / scanner input
/**
 * QR architecture: a student's ID card encodes `SCH1:<school-address>:<admission number>`. A phone camera scanner or a
 * USB/Bluetooth barcode scanner (which types like a keyboard) feeds the text to the quick-mark box. Plain admission
 * numbers also work. The school address is checked so another school's card is never accepted.
 */
export const qrPayload = (slug: string, admission: string) => `SCH1:${slug}:${admission.toUpperCase()}`;
export function parseScan(raw: string): { slug: string | null; admission: string } | null {
  const t = raw.trim();
  if (!t) return null;
  const m = /^SCH1:([a-z0-9-]{3,40}):([A-Za-z0-9-]{3,30})$/.exec(t);
  if (m) return { slug: m[1] as string, admission: (m[2] as string).toUpperCase() };
  return /^[A-Za-z0-9-]{3,30}$/.test(t) ? { slug: null, admission: t.toUpperCase() } : null;
}
