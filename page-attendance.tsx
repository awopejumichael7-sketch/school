import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { collection, doc, getDoc, getDocs, limit, query, where } from 'firebase/firestore';
import { firebase } from './lib-firebase';
import { isActiveItem, useTenant } from './ctx-tenant';
import { Alert, Badge, Button, Card, Field, Select, Spinner } from './ui';
import { useAction } from './use-action';
import { applyOps, newId, type Op } from './lib-ops';
import { auditOp } from './lib-accounts';
import { toCsv } from './lib-csv';
import { downloadText } from './lib-download';
import { isValidIsoDate } from './lib-people';
import { can } from './lib-permissions';
import {
  addCounts, addDays, attendanceDocId, attendancePercent, buildAttendanceCreate, buildAttendanceUpdate, buildReport, countRecords, dayDiff,
  emptyCounts, lowAttendance, monthKeysBetween, monthRange, parseScan, policyOf, STATUS_LABEL, STATUSES, todayInZone, totalOf, weekRange,
  type Counts, type DayDoc, type Report, type Status,
} from './lib-attendance';

type Tab = 'take' | 'reports' | 'overview';
const TEACHER_EDIT_DAYS = 7;
const pctText = (p: number | null) => (p === null ? '—' : `${p}%`);

export default function AttendancePage() {
  const { member, classes } = useTenant();
  const canTake = can(member.role, 'attendance.take');
  const schoolWide = member.role !== 'TEACHER';
  const [tab, setTab] = useState<Tab>(canTake ? 'take' : 'reports');
  const classOptions = useMemo(
    () => classes.filter(isActiveItem).filter((c) => schoolWide || (member.classIds ?? []).includes(c.id)),
    [classes, schoolWide, member.classIds],
  );
  return (
    <>
      <h1>Attendance</h1>
      <nav className="tabs" aria-label="Attendance sections">
        {canTake && <button className={tab === 'take' ? 'on' : ''} aria-pressed={tab === 'take'} onClick={() => setTab('take')}>Take attendance</button>}
        <button className={tab === 'reports' ? 'on' : ''} aria-pressed={tab === 'reports'} onClick={() => setTab('reports')}>Reports</button>
        {schoolWide && <button className={tab === 'overview' ? 'on' : ''} aria-pressed={tab === 'overview'} onClick={() => setTab('overview')}>School overview</button>}
      </nav>
      {classOptions.length === 0 && tab !== 'overview' && <Alert kind="info">{schoolWide ? 'Add classes under Academics first.' : 'You have not been assigned to a class yet. Please ask your administrator.'}</Alert>}
      {tab === 'take' && canTake && <Take classOptions={classOptions} />}
      {tab === 'reports' && <Reports classOptions={classOptions} />}
      {tab === 'overview' && schoolWide && <Overview />}
    </>
  );
}

// ------------------------------------------------------------------------- take attendance
interface Existing { records: Record<string, Status>; names: Record<string, string>; takenByName?: string }

function Take({ classOptions }: { classOptions: { id: string; name: string }[] }) {
  const { tenantId, uid, tenant, member, slug } = useTenant();
  const today = todayInZone(tenant.settings.timezone);
  const policy = policyOf(tenant.settings.attendance);
  const isTeacher = member.role === 'TEACHER';
  const earliest = isTeacher ? addDays(today, -TEACHER_EDIT_DAYS) : '';
  const [classId, setClassId] = useState('');
  const [date, setDate] = useState(today);
  const [roster, setRoster] = useState<{ id: string; name: string }[] | null>(null);
  const [existing, setExisting] = useState<Existing | null>(null);
  const [marks, setMarks] = useState<Record<string, Status>>({});
  const [tick, setTick] = useState(0);
  const [saved, setSaved] = useState<string | null>(null);
  const [scan, setScan] = useState('');
  const [scanMsg, setScanMsg] = useState<string | null>(null);
  const { busy, error, setError, run } = useAction();

  useEffect(() => {
    let alive = true;
    if (!classId || !isValidIsoDate(date)) { setRoster(null); setExisting(null); setMarks({}); return; }
    void (async () => {
      const ok = await run('loadAttendance', async () => {
        const { db } = firebase();
        const [stu, snap] = await Promise.all([
          getDocs(query(collection(db, `tenants/${tenantId}/students`), where('classId', '==', classId), where('status', '==', 'ACTIVE'), limit(300))),
          getDoc(doc(db, `tenants/${tenantId}/attendance/${attendanceDocId(classId, date)}`)),
        ]);
        if (!alive) return false;
        setRoster(stu.docs.map((d) => ({ id: d.id, name: [d.get('firstName'), d.get('middleName'), d.get('lastName')].filter(Boolean).join(' ') }))
          .sort((a, b) => a.name.localeCompare(b.name)));
        const e = snap.exists() ? (snap.data() as Existing) : null;
        setExisting(e);
        setMarks(e ? { ...e.records } : {});
        return true;
      });
      if (ok === undefined && alive) setRoster(null);
    })();
    return () => { alive = false; };
  }, [classId, date, tick, tenantId, run]);

  const rosterIds = useMemo(() => new Set((roster ?? []).map((r) => r.id)), [roster]);
  const counts: Counts = useMemo(() => countRecords(Object.fromEntries(Object.entries(marks).filter(([id]) => rosterIds.has(id)))), [marks, rosterIds]);
  const unmarked = (roster ?? []).filter((r) => !marks[r.id]);
  const mark = (id: string, s: Status) => { setSaved(null); setMarks((m) => ({ ...m, [id]: s })); };

  function quickMark(e: FormEvent) {
    e.preventDefault();
    const parsed = parseScan(scan);
    setScan('');
    if (!parsed) return setScanMsg('That code was not recognised.');
    if (parsed.slug && parsed.slug !== slug) return setScanMsg('That card belongs to a different school.');
    const found = (roster ?? []).find((r) => r.id === parsed.admission);
    if (!found) return setScanMsg(`${parsed.admission} is not in this class.`);
    mark(found.id, 'P');
    setScanMsg(`Marked ${found.name} present.`);
  }

  async function save() {
    setError(null);
    if (!roster || !classId) return;
    if (!isValidIsoDate(date) || date > today) return setError('You cannot record attendance for a future date.');
    if (isTeacher && dayDiff(today, date) > TEACHER_EDIT_DAYS) return setError(`Teachers can only record or change the last ${TEACHER_EDIT_DAYS} days. Please ask an administrator.`);
    if (roster.length === 0) return setError('There are no active students in this class.');
    if (unmarked.length) return setError(`${unmarked.length} student${unmarked.length === 1 ? ' is' : 's are'} not marked yet. Mark everyone (you can use "Mark all present" first).`);
    const outcome = await run('saveAttendance', async () => {
      const keep = Object.fromEntries(Object.entries(existing?.records ?? {}).filter(([id]) => !rosterIds.has(id))) as Record<string, Status>;
      const records: Record<string, Status> = { ...keep, ...Object.fromEntries(roster.map((r) => [r.id, marks[r.id] as Status])) };
      const names = { ...(existing?.names ?? {}), ...Object.fromEntries(roster.map((r) => [r.id, r.name])) };
      const changed = existing ? roster.filter((r) => existing.records[r.id] !== marks[r.id]).length : roster.length;
      const c = countRecords(records);
      const path = `tenants/${tenantId}/attendance/${attendanceDocId(classId, date)}`;
      const ops: Op[] = [
        existing
          ? { kind: 'update', path, data: buildAttendanceUpdate({ records, names, updatedBy: uid }) }
          : { kind: 'set', path, data: buildAttendanceCreate({ tenantId, classId, date, session: tenant.settings.academicSession, records, names, takenBy: uid, takenByName: member.displayName || 'Teacher' }) },
        auditOp(tenantId, uid, newId(), existing ? 'attendance.updated' : 'attendance.recorded', path, { classId, date, P: c.P, A: c.A, L: c.L, E: c.E, changed }),
      ];
      await applyOps(firebase().db, ops);
      return `Attendance saved for ${date}.`;
    });
    if (outcome) { setSaved(outcome); setTick((t) => t + 1); }
  }

  return (
    <Card title="Take attendance">
      {error && <Alert>{error}</Alert>}
      <div className="toolbar">
        <Select label="Class" value={classId} onChange={(e) => { setSaved(null); setClassId(e.target.value); }}>
          <option value="">Choose a class…</option>
          {classOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        <Field label="Date" type="date" value={date} max={today} min={earliest || undefined} onChange={(e) => { setSaved(null); setDate(e.target.value); }} />
      </div>
      {isTeacher && <p className="muted">Teachers can record today and the previous {TEACHER_EDIT_DAYS} days.</p>}
      {classId && roster === null && !error && <Spinner />}
      {roster && (
        <>
          {existing && <Alert kind="info">Attendance was already recorded for this day{existing.takenByName ? ` by ${existing.takenByName}` : ''}. Saving will update it.</Alert>}
          {saved && <Alert kind="success">{saved}</Alert>}
          {roster.length === 0 ? <p className="muted">There are no active students in this class.</p> : (
            <>
              <div className="toolbar">
                <Button variant="secondary" onClick={() => { setSaved(null); setMarks(Object.fromEntries(roster.map((r) => [r.id, 'P' as Status]))); }}>Mark all present</Button>
                <form className="row" onSubmit={quickMark} noValidate>
                  <Field label="Scan or type an admission number" value={scan} onChange={(e) => setScan(e.target.value)} autoComplete="off" autoCapitalize="characters"
                    hint="A barcode/QR scanner can type straight into this box." />
                  <Button type="submit" variant="secondary">Mark present</Button>
                </form>
              </div>
              {scanMsg && <p role="status" className="muted">{scanMsg}</p>}
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Admission no.</th><th>Student</th><th>Attendance</th></tr></thead>
                  <tbody>
                    {roster.map((r) => (
                      <tr key={r.id}>
                        <td>{r.id}</td>
                        <td>{r.name}</td>
                        <td>
                          <div className="seg" role="group" aria-label={`Attendance for ${r.name}`}>
                            {STATUSES.map((s) => (
                              <button key={s} type="button" className={`seg-${s} ${marks[r.id] === s ? 'on' : ''}`} aria-pressed={marks[r.id] === s}
                                aria-label={`${STATUS_LABEL[s]} for ${r.name}`} onClick={() => mark(r.id, s)}>{STATUS_LABEL[s]}</button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p role="status"><strong>{counts.P}</strong> present · <strong>{counts.A}</strong> absent · <strong>{counts.L}</strong> late · <strong>{counts.E}</strong> excused
                {unmarked.length > 0 && <> · <strong>{unmarked.length}</strong> not marked</>} · attendance {pctText(attendancePercent(counts, policy))}</p>
              <Button busy={busy} onClick={() => void save()}>{existing ? 'Update attendance' : 'Save attendance'}</Button>
            </>
          )}
        </>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------------------- reports
type Mode = 'day' | 'week' | 'month' | 'term';

function Reports({ classOptions }: { classOptions: { id: string; name: string }[] }) {
  const { tenantId, tenant, terms } = useTenant();
  const policy = policyOf(tenant.settings.attendance);
  const today = todayInZone(tenant.settings.timezone);
  const [classId, setClassId] = useState('');
  const [mode, setMode] = useState<Mode>('month');
  const [date, setDate] = useState(today);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [termId, setTermId] = useState('');
  const [threshold, setThreshold] = useState(80);
  const [docs, setDocs] = useState<DayDoc[] | null>(null);
  const { busy, error, run } = useAction();

  const term = terms.find((t) => t.id === termId);
  const range = useMemo((): { from: string; to: string } | null => {
    if (mode === 'day') return isValidIsoDate(date) ? { from: date, to: date } : null;
    if (mode === 'week') return isValidIsoDate(date) ? weekRange(date) : null;
    if (mode === 'month') return /^\d{4}-\d{2}$/.test(month) ? monthRange(month) : null;
    return term?.startDate && term.endDate ? { from: term.startDate, to: term.endDate } : null;
  }, [mode, date, month, term]);

  useEffect(() => {
    let alive = true;
    setDocs(null);
    if (!classId || !range) return;
    void (async () => {
      const got = await run('attendanceReport', async () => {
        const { db } = firebase();
        const months = monthKeysBetween(range.from, range.to);
        const snaps = await Promise.all(months.map((m) =>
          getDocs(query(collection(db, `tenants/${tenantId}/attendance`), where('classId', '==', classId), where('month', '==', m), limit(31)))));
        return snaps.flatMap((s) => s.docs.map((d) => d.data() as DayDoc));
      });
      if (alive && got) setDocs(got);
    })();
    return () => { alive = false; };
  }, [classId, range, tenantId, run]);

  const report: Report | null = useMemo(() => (docs && range ? buildReport(docs, range.from, range.to, policy) : null),
    [docs, range, policy.lateCountsAsPresent, policy.excusedCountsAsAbsent]);  // eslint-disable-line react-hooks/exhaustive-deps
  const low = report ? lowAttendance(report.students, threshold) : [];

  function exportCsv() {
    if (!report) return;
    downloadText(`attendance-${classId}-${report.from}-to-${report.to}.csv`, toCsv([
      ['Admission no.', 'Name', 'Present', 'Absent', 'Late', 'Excused', 'Days recorded', 'Attendance %'],
      ...report.students.map((s) => [s.id, s.name, s.counts.P, s.counts.A, s.counts.L, s.counts.E, s.recorded, s.pct ?? '']),
    ]));
  }

  return (
    <>
      <Card title="Attendance report">
        {error && <Alert>{error}</Alert>}
        <div className="toolbar">
          <Select label="Class" value={classId} onChange={(e) => setClassId(e.target.value)}>
            <option value="">Choose a class…</option>
            {classOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <Select label="Period" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
            <option value="day">Daily</option><option value="week">Weekly</option><option value="month">Monthly</option><option value="term">Term</option>
          </Select>
          {(mode === 'day' || mode === 'week') && <Field label={mode === 'week' ? 'Any day in the week' : 'Date'} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
          {mode === 'month' && <Field label="Month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />}
          {mode === 'term' && (
            <Select label="Term" value={termId} onChange={(e) => setTermId(e.target.value)}>
              <option value="">Choose a term…</option>
              {terms.filter(isActiveItem).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          )}
          <Field label="Flag students below (%)" type="number" min={0} max={100} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
        </div>
        {mode === 'term' && termId && !range && <Alert kind="info">Set this term's start and end dates under Academics first.</Alert>}
        {range && <p className="muted">{range.from === range.to ? range.from : `${range.from} to ${range.to}`}</p>}
        {classId && range && docs === null && !error && <Spinner />}
      </Card>
      {report && (
        <>
          <div className="cards">
            <Card title="Class attendance"><p className="big">{pctText(report.summary.pct)}</p><p className="muted">{report.summary.daysRecorded} day{report.summary.daysRecorded === 1 ? '' : 's'} recorded</p></Card>
            <Card title="Totals">
              <dl className="summary"><dt>Present</dt><dd>{report.summary.counts.P}</dd><dt>Absent</dt><dd>{report.summary.counts.A}</dd>
                <dt>Late</dt><dd>{report.summary.counts.L}</dd><dt>Excused</dt><dd>{report.summary.counts.E}</dd></dl>
            </Card>
          </div>
          {report.summary.daysRecorded === 0 ? <Alert kind="info">No attendance has been recorded for this period.</Alert> : (
            <>
              {low.length > 0 && <Alert>Below {threshold}%: {low.map((s) => `${s.name} (${pctText(s.pct)})`).join(', ')}</Alert>}
              <Card title="By student" actions={<Button variant="secondary" busy={busy} onClick={exportCsv}>Download CSV</Button>}>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Admission no.</th><th>Student</th><th>Present</th><th>Absent</th><th>Late</th><th>Excused</th><th>Attendance</th></tr></thead>
                    <tbody>{report.students.map((s) => (
                      <tr key={s.id}><td>{s.id}</td><td>{s.name}</td><td>{s.counts.P}</td><td>{s.counts.A}</td><td>{s.counts.L}</td><td>{s.counts.E}</td>
                        <td>{pctText(s.pct)} {s.pct !== null && s.pct < threshold && <Badge tone="bad">low</Badge>}</td></tr>
                    ))}</tbody>
                  </table>
                </div>
              </Card>
              {report.days.length > 1 && (
                <Card title="By day">
                  <div className="table-wrap">
                    <table>
                      <thead><tr><th>Date</th><th>Present</th><th>Absent</th><th>Late</th><th>Excused</th><th>Attendance</th></tr></thead>
                      <tbody>{report.days.map((d) => <tr key={d.date}><td>{d.date}</td><td>{d.counts.P}</td><td>{d.counts.A}</td><td>{d.counts.L}</td><td>{d.counts.E}</td><td>{pctText(d.pct)}</td></tr>)}</tbody>
                    </table>
                  </div>
                </Card>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------------ school overview
function Overview() {
  const { tenantId, tenant, classes } = useTenant();
  const policy = policyOf(tenant.settings.attendance);
  const today = todayInZone(tenant.settings.timezone);
  const [date, setDate] = useState(today);
  const [rows, setRows] = useState<Map<string, Counts> | null>(null);
  const { error, run } = useAction();

  useEffect(() => {
    let alive = true;
    setRows(null);
    if (!isValidIsoDate(date)) return;
    void (async () => {
      const got = await run('attendanceOverview', async () => {
        const snap = await getDocs(query(collection(firebase().db, `tenants/${tenantId}/attendance`), where('date', '==', date), limit(200)));
        return new Map(snap.docs.map((d) => [String(d.get('classId')), countRecords((d.get('records') ?? {}) as Record<string, Status>)] as const));
      });
      if (alive && got) setRows(got);
    })();
    return () => { alive = false; };
  }, [date, tenantId, run]);

  const active = classes.filter(isActiveItem);
  const school = [...(rows?.values() ?? [])].reduce(addCounts, emptyCounts());
  return (
    <Card title="School overview">
      {error && <Alert>{error}</Alert>}
      <div className="toolbar"><Field label="Date" type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} /></div>
      {!rows ? <Spinner /> : (
        <>
          <p><strong>Whole school:</strong> {school.P} present · {school.A} absent · {school.L} late · {school.E} excused · {pctText(attendancePercent(school, policy))}
            {' '}({rows.size} of {active.length} classes recorded)</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Class</th><th>Present</th><th>Absent</th><th>Late</th><th>Excused</th><th>Attendance</th></tr></thead>
              <tbody>{active.map((c) => {
                const k = rows.get(c.id);
                return k ? <tr key={c.id}><td>{c.name}</td><td>{k.P}</td><td>{k.A}</td><td>{k.L}</td><td>{k.E}</td><td>{pctText(attendancePercent(k, policy))}</td></tr>
                  : <tr key={c.id}><td>{c.name}</td><td colSpan={5} className="muted">Not recorded</td></tr>;
              })}</tbody>
            </table>
          </div>
          {totalOf(school) === 0 && <p className="muted">Nothing has been recorded for this date.</p>}
        </>
      )}
    </Card>
  );
}
