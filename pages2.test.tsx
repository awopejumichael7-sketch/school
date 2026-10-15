// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

const h = vi.hoisted(() => ({
  auth: { status: 'ready', user: { uid: 'admin1', email: 'admin@x.com' }, tenantId: 't1', isPlatformAdmin: false, refresh: vi.fn(), signIn: vi.fn(), signOut: vi.fn() },
}));
vi.mock('firebase/firestore', async (orig) => (await import('./test-store')).firestoreMock(await orig()));
vi.mock('./lib-firebase', async () => (await import('./test-store')).fakeFirebase());
vi.mock('./lib-ops', async (orig) => ({ ...(await orig<typeof import('./lib-ops')>()), applyOps: (await import('./test-store')).applyOpsFake }));
vi.mock('./lib-newuser', async () => ({ withNewAccount: (await import('./test-store')).withNewAccountFake }));
vi.mock('./ctx-auth', () => ({ useAuth: () => h.auth }));

import { TenantProvider } from './ctx-tenant';
import { store, seed, resetStore, writeLog, accounts, hooks } from './test-store';
import AttendancePage from './page-attendance';
import Fees from './page-fees';
import Users from './page-users';
import Academics from './page-academics';
import Settings from './page-settings';
import { DEFAULT_ASSESSMENT, DEFAULT_GRADING } from './lib-config';
import { todayInZone, addDays } from './lib-attendance';
import type { MemberDoc, Role, TenantDoc } from './types';

const T = 't1';
const TODAY = todayInZone('Africa/Lagos');
const YEAR = Number(TODAY.slice(0, 4));
const tenantDoc = {
  name: 'Royal Scholars Academy', ownerUid: 'admin1', licenseId: 'h', plan: 'standard', status: 'ACTIVE', installationId: 'i', expiresAt: null, setupComplete: true,
  profile: { name: 'Royal Scholars Academy', motto: '', address: '1 School Rd', phone: '0800', email: '', website: '', footer: 'Thank you', emailSenderName: 'Royal' },
  settings: { academicSession: '2026/2027', terms: ['Term 1'], currency: 'NGN', timezone: 'Africa/Lagos', grading: DEFAULT_GRADING, assessment: DEFAULT_ASSESSMENT, admissionPrefix: 'RSA' },
} as unknown as TenantDoc;

const stu = (adm: string, first: string, last: string, classId = 'jss-1', status = 'ACTIVE') => ({
  tenantId: T, studentId: adm, admissionNumber: adm, firstName: first, middleName: '', lastName: last, gender: 'FEMALE', dateOfBirth: '2014-05-21', photo: null,
  classId, parentIds: [], phone: '', email: '', address: '', admissionDate: '2026-09-14', status, academicSession: '2026/2027', uid: null,
});
function seedSchool() {
  seed(`tenants/${T}`, tenantDoc as unknown as Record<string, unknown>);
  seed(`publicProfiles/${T}`, { tenantId: T, slug: 'royal', name: 'Royal Scholars Academy', motto: '', logoDataUrl: null, primaryColor: '#112233', secondaryColor: '#445566' });
  seed(`tenants/${T}/classes/jss-1`, { tenantId: T, name: 'JSS 1', order: 0, status: 'ACTIVE' });
  seed(`tenants/${T}/classes/jss-2`, { tenantId: T, name: 'JSS 2', order: 1, status: 'ACTIVE' });
  seed(`tenants/${T}/terms/term-1`, { tenantId: T, name: 'Term 1', order: 0, status: 'ACTIVE', session: '2026/2027' });
  seed(`tenants/${T}/members/admin1`, { uid: 'admin1', tenantId: T, role: 'SCHOOL_ADMIN', status: 'ACTIVE', displayName: 'Ada Admin', email: 'admin@x.com' });
  seed(`tenants/${T}/students/RSA-2026-0001`, stu('RSA-2026-0001', 'Ada', 'Okafor'));
  seed(`tenants/${T}/students/RSA-2026-0002`, stu('RSA-2026-0002', 'Bola', 'Ade'));
  seed(`tenants/${T}/students/RSA-2026-0003`, stu('RSA-2026-0003', 'Chidi', 'Eze'));
  seed(`tenants/${T}/students/RSA-2026-0004`, stu('RSA-2026-0004', 'Gone', 'Student', 'jss-1', 'INACTIVE'));
  seed(`tenants/${T}/students/RSA-2026-0005`, stu('RSA-2026-0005', 'Dayo', 'Bello', 'jss-2'));
}
function mount(ui: ReactElement, role: Role = 'SCHOOL_ADMIN', extra: Partial<MemberDoc> = {}) {
  const member = { uid: 'admin1', tenantId: T, role, status: 'ACTIVE', displayName: 'Ada Admin', email: 'admin@x.com', ...extra } as MemberDoc;
  return render(<MemoryRouter><TenantProvider tenantId={T} uid="admin1" tenant={tenantDoc} member={member}>{ui}</TenantProvider></MemoryRouter>);
}
const doc = (p: string) => store.get(p);
const allWrites = () => writeLog.flat();
const alert = () => screen.findByRole('alert');
const U = () => userEvent.setup();
const blobText = (b: Blob) => new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsText(b); });
const para = (re: RegExp) => screen.findByText((_, el) => el?.tagName === 'P' && re.test((el.textContent ?? '').replace(/\s+/g, ' ')));
const withinCard = (title: string) => within(screen.getByRole('heading', { name: title }).closest('section') as HTMLElement);

beforeEach(() => {
  cleanup(); resetStore(); seedSchool(); h.auth.refresh.mockReset(); h.auth.refresh.mockResolvedValue(undefined);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  window.print = vi.fn();
});

// ========================================================== take attendance
async function openClass(u: ReturnType<typeof userEvent.setup>, classId = 'jss-1') {
  await u.selectOptions(await screen.findByLabelText('Class'), classId);
  await screen.findByText('Ada Okafor');
}
const mark = (u: ReturnType<typeof userEvent.setup>, status: string, name: string) => u.click(screen.getByRole('button', { name: `${status} for ${name}` }));

describe('Take attendance', () => {
  it('lists only ACTIVE students, refuses to save until everyone is marked, then saves one document with counts, names and an audit entry', async () => {
    const u = U();
    mount(<AttendancePage />);
    await openClass(u);
    expect(screen.queryByText('Gone Student')).not.toBeInTheDocument();
    expect(screen.queryByText('Dayo Bello')).not.toBeInTheDocument();
    await mark(u, 'Present', 'Ada Okafor');
    await u.click(screen.getByRole('button', { name: 'Save attendance' }));
    expect(await alert()).toHaveTextContent('2 students are not marked yet');
    expect(writeLog).toHaveLength(0);
    await u.click(screen.getByRole('button', { name: 'Mark all present' }));
    await mark(u, 'Absent', 'Bola Ade');
    await mark(u, 'Late', 'Chidi Eze');
    expect(screen.getAllByRole('status').some((e) => /1 present · 1 absent · 1 late · 0 excused/.test(e.textContent ?? ''))).toBe(true);
    await u.click(screen.getByRole('button', { name: 'Save attendance' }));
    await screen.findByText(`Attendance saved for ${TODAY}.`);
    const d = doc(`tenants/${T}/attendance/jss-1_${TODAY}`)!;
    expect(d).toMatchObject({
      tenantId: T, classId: 'jss-1', date: TODAY, month: TODAY.slice(0, 7), session: '2026/2027', takenBy: 'admin1', total: 3,
      counts: { P: 1, A: 1, L: 1, E: 0 },
      records: { 'RSA-2026-0001': 'P', 'RSA-2026-0002': 'A', 'RSA-2026-0003': 'L' },
      names: { 'RSA-2026-0001': 'Ada Okafor', 'RSA-2026-0002': 'Bola Ade', 'RSA-2026-0003': 'Chidi Eze' },
    });
    expect(allWrites().find((o) => (o.data as { action?: string }).action === 'attendance.recorded')!.data).toMatchObject({ metadata: { classId: 'jss-1', date: TODAY, P: 1, A: 1, L: 1, E: 0, changed: 3 } });
  });

  it('an existing day loads pre-filled and saving UPDATES it (same document, audit says how many changed)', async () => {
    seed(`tenants/${T}/attendance/jss-1_${TODAY}`, {
      tenantId: T, classId: 'jss-1', date: TODAY, month: TODAY.slice(0, 7), session: '2026/2027', takenBy: 'someone', takenByName: 'Mrs Bello', total: 3, counts: { P: 3, A: 0, L: 0, E: 0 },
      records: { 'RSA-2026-0001': 'P', 'RSA-2026-0002': 'P', 'RSA-2026-0003': 'P', 'GONE-9': 'A' }, names: { 'RSA-2026-0001': 'Ada Okafor', 'GONE-9': 'Left Student' },
    });
    const u = U();
    mount(<AttendancePage />);
    await openClass(u);
    expect(await screen.findByText(/already recorded for this day by Mrs Bello/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Present for Bola Ade' })).toHaveAttribute('aria-pressed', 'true');
    await mark(u, 'Excused', 'Bola Ade');
    await u.click(screen.getByRole('button', { name: 'Update attendance' }));
    await screen.findByText(`Attendance saved for ${TODAY}.`);
    const d = doc(`tenants/${T}/attendance/jss-1_${TODAY}`)!;
    expect((d.records as Record<string, string>)['RSA-2026-0002']).toBe('E');
    expect((d.records as Record<string, string>)['GONE-9']).toBe('A');       // students who left the roster keep their history
    expect((d.names as Record<string, string>)['GONE-9']).toBe('Left Student');
    expect(d).toMatchObject({ takenBy: 'someone', total: 4, counts: { P: 2, A: 1, L: 0, E: 1 }, updatedBy: 'admin1' });
    const ops = allWrites();
    expect(ops.find((o) => o.path.endsWith(`jss-1_${TODAY}`))!.kind).toBe('update');
    expect(ops.find((o) => (o.data as { action?: string }).action === 'attendance.updated')!.data).toMatchObject({ metadata: { changed: 1 } });
  });

  it('quick-mark: scanner/typed admission numbers mark present; other schools\' cards and strangers are refused', async () => {
    const u = U();
    mount(<AttendancePage />);
    await openClass(u);
    const box = screen.getByLabelText('Scan or type an admission number');
    await u.type(box, 'rsa-2026-0002{enter}');
    expect(await screen.findByText('Marked Bola Ade present.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Present for Bola Ade' })).toHaveAttribute('aria-pressed', 'true');
    await u.type(box, 'SCH1:royal:RSA-2026-0003{enter}');
    expect(await screen.findByText('Marked Chidi Eze present.')).toBeInTheDocument();
    await u.type(box, 'SCH1:othersch:RSA-2026-0001{enter}');
    expect(await screen.findByText('That card belongs to a different school.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Present for Ada Okafor' })).toHaveAttribute('aria-pressed', 'false');
    await u.type(box, 'RSA-2026-0005{enter}');   // exists, but in JSS 2
    expect(await screen.findByText('RSA-2026-0005 is not in this class.')).toBeInTheDocument();
    await u.type(box, 'a/b{enter}');
    expect(await screen.findByText('That code was not recognised.')).toBeInTheDocument();
  });

  it('a future date cannot be recorded', async () => {
    const u = U();
    mount(<AttendancePage />);
    await openClass(u);
    await u.click(screen.getByRole('button', { name: 'Mark all present' }));
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: addDays(TODAY, 2) } });
    await screen.findByText('Ada Okafor');
    await u.click(screen.getByRole('button', { name: 'Mark all present' }));
    await u.click(screen.getByRole('button', { name: 'Save attendance' }));
    expect(await alert()).toHaveTextContent('future date');
    expect(writeLog).toHaveLength(0);
  });

  it('a teacher sees only their classes and can edit only the last 7 days', async () => {
    const u = U();
    mount(<AttendancePage />, 'TEACHER', { classIds: ['jss-1'] });
    const select = await screen.findByLabelText('Class');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose a class…', 'JSS 1']);
    expect(screen.queryByRole('button', { name: 'School overview' })).not.toBeInTheDocument();
    await u.selectOptions(select, 'jss-1');
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: addDays(TODAY, -10) } });
    await screen.findByText('Ada Okafor');
    await u.click(screen.getByRole('button', { name: 'Mark all present' }));
    await u.click(screen.getByRole('button', { name: 'Save attendance' }));
    expect(await alert()).toHaveTextContent('last 7 days');
    expect(writeLog).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: addDays(TODAY, -3) } });
    await screen.findByText('Ada Okafor');
    await u.click(screen.getByRole('button', { name: 'Mark all present' }));
    await u.click(screen.getByRole('button', { name: 'Save attendance' }));
    await screen.findByText(`Attendance saved for ${addDays(TODAY, -3)}.`);
    expect(doc(`tenants/${T}/attendance/jss-1_${addDays(TODAY, -3)}`)).toMatchObject({ takenBy: 'admin1', classId: 'jss-1' });
  });

  it('a save failure shows a friendly message and records nothing', async () => {
    hooks.failBatch = () => ({ code: 'permission-denied', message: 'FirebaseError: PERMISSION_DENIED' });
    const u = U();
    mount(<AttendancePage />);
    await openClass(u);
    await u.click(screen.getByRole('button', { name: 'Mark all present' }));
    await u.click(screen.getByRole('button', { name: 'Save attendance' }));
    const a = await alert();
    expect(a).toHaveTextContent("You don't have permission");
    expect(a.textContent).not.toMatch(/firebase|PERMISSION_DENIED/i);
    expect(doc(`tenants/${T}/attendance/jss-1_${TODAY}`)).toBeUndefined();
  });

  it('principal and staff can read reports but have no Take tab', async () => {
    mount(<AttendancePage />, 'PRINCIPAL');
    expect(await screen.findByRole('heading', { name: 'Attendance report' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Take attendance' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'School overview' })).toBeInTheDocument();
  });
});

// ================================================================ reports
const day = (date: string, records: Record<string, string>) => seed(`tenants/${T}/attendance/jss-1_${date}`, {
  tenantId: T, classId: 'jss-1', date, month: date.slice(0, 7), session: '2026/2027', records,
  names: { 'RSA-2026-0001': 'Ada Okafor', 'RSA-2026-0002': 'Bola Ade', 'RSA-2026-0003': 'Chidi Eze' }, counts: {}, total: 3,
});
function seedDays() {
  day('2026-09-14', { 'RSA-2026-0001': 'P', 'RSA-2026-0002': 'A', 'RSA-2026-0003': 'P' });
  day('2026-09-15', { 'RSA-2026-0001': 'P', 'RSA-2026-0002': 'L', 'RSA-2026-0003': 'P' });
  day('2026-09-16', { 'RSA-2026-0001': 'A', 'RSA-2026-0002': 'A', 'RSA-2026-0003': 'P' });
  day('2026-10-01', { 'RSA-2026-0001': 'P', 'RSA-2026-0002': 'P', 'RSA-2026-0003': 'P' });
}
async function openReport(u: ReturnType<typeof userEvent.setup>, month = '2026-09') {
  await u.click(await screen.findByRole('button', { name: 'Reports' }));
  await u.selectOptions(await screen.findByLabelText('Class'), 'jss-1');
  fireEvent.change(screen.getByLabelText('Month'), { target: { value: month } });
}
describe('Attendance reports', () => {
  it('monthly report: class %, per-student %, flags low attendance, day-by-day', async () => {
    seedDays();
    const u = U();
    mount(<AttendancePage />);
    await openReport(u);
    await screen.findByText('3 days recorded');
    expect(withinCard('Class attendance').getByText('66.67%')).toBeInTheDocument();          // (5 present + 1 late) / 9
    const row = (n: string) => within(screen.getByText(n).closest('tr') as HTMLElement);
    expect(row('Ada Okafor').getByText(/66\.67%/)).toBeInTheDocument();
    expect(row('Bola Ade').getByText(/33\.33%/)).toBeInTheDocument();
    expect(row('Bola Ade').getByText('low')).toBeInTheDocument();
    expect(row('Chidi Eze').getByText(/100%/)).toBeInTheDocument();
    expect(screen.getByText(/Below 80%: Ada Okafor \(66\.67%\), Bola Ade \(33\.33%\)/)).toBeInTheDocument();
    expect(screen.queryByText('2026-10-01')).not.toBeInTheDocument();                         // other month excluded
    expect(withinCard('By day').getByText('2026-09-15')).toBeInTheDocument();
  });
  it('weekly and daily periods use the right date ranges', async () => {
    seedDays();
    const u = U();
    mount(<AttendancePage />);
    await openReport(u);
    await u.selectOptions(screen.getByLabelText('Period'), 'week');
    fireEvent.change(screen.getByLabelText('Any day in the week'), { target: { value: '2026-09-16' } });   // Wed -> Mon 14th..Sun 20th
    await screen.findByText('3 days recorded');
    await u.selectOptions(screen.getByLabelText('Period'), 'day');
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-09-16' } });
    await screen.findByText('1 day recorded');
    expect(withinCard('Class attendance').getByText('33.33%')).toBeInTheDocument();           // 1 present of 3
  });
  it('term report needs term dates; with dates it spans months', async () => {
    seedDays();
    const u = U();
    mount(<AttendancePage />);
    await u.click(await screen.findByRole('button', { name: 'Reports' }));
    await u.selectOptions(await screen.findByLabelText('Class'), 'jss-1');
    await u.selectOptions(screen.getByLabelText('Period'), 'term');
    await u.selectOptions(screen.getByLabelText('Term'), 'term-1');
    expect(await screen.findByText(/Set this term's start and end dates under Academics first/)).toBeInTheDocument();
    cleanup();
    seed(`tenants/${T}/terms/term-1`, { tenantId: T, name: 'Term 1', order: 0, status: 'ACTIVE', startDate: '2026-09-01', endDate: '2026-12-15' });
    mount(<AttendancePage />);
    await u.click(await screen.findByRole('button', { name: 'Reports' }));
    await u.selectOptions(await screen.findByLabelText('Class'), 'jss-1');
    await u.selectOptions(screen.getByLabelText('Period'), 'term');
    await u.selectOptions(screen.getByLabelText('Term'), 'term-1');
    await screen.findByText('4 days recorded');                                               // Sept + Oct documents
  });
  it('shows a clear message when nothing is recorded, and never a fake 0%', async () => {
    const u = U();
    mount(<AttendancePage />);
    await openReport(u, '2026-01');
    expect(await screen.findByText('No attendance has been recorded for this period.')).toBeInTheDocument();
    expect(withinCard('Class attendance').getByText('—')).toBeInTheDocument();
  });
  it('exports a CSV with every student row', async () => {
    seedDays();
    const made: Blob[] = [];
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b) => { made.push(b); return 'blob:x'; };
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const u = U();
    mount(<AttendancePage />);
    await openReport(u);
    await screen.findByText('3 days recorded');
    await u.click(screen.getByRole('button', { name: 'Download CSV' }));
    const csv = await blobText(made[0]!);
    expect(csv).toContain('Admission no.,Name,Present,Absent,Late,Excused,Days recorded,Attendance %');
    expect(csv).toContain('RSA-2026-0002,Bola Ade,0,2,1,0,3,33.33');
  });
  it('the school policy changes the numbers (late/excused settings)', async () => {
    seedDays();
    seed(`tenants/${T}`, { ...(tenantDoc as unknown as Record<string, unknown>), settings: { ...tenantDoc.settings, attendance: { lateCountsAsPresent: false, excusedCountsAsAbsent: false } } });
    const strict = { ...tenantDoc, settings: { ...tenantDoc.settings, attendance: { lateCountsAsPresent: false, excusedCountsAsAbsent: false } } } as TenantDoc;
    const member = { uid: 'admin1', tenantId: T, role: 'SCHOOL_ADMIN', status: 'ACTIVE', displayName: 'A', email: 'a' } as MemberDoc;
    const u = U();
    render(<MemoryRouter><TenantProvider tenantId={T} uid="admin1" tenant={strict} member={member}><AttendancePage /></TenantProvider></MemoryRouter>);
    await openReport(u);
    await screen.findByText('3 days recorded');
    expect(withinCard('Class attendance').getByText('55.56%')).toBeInTheDocument();           // 5 / 9 when late does not count
  });
  it('school overview: per-class totals for a date and which classes have not recorded', async () => {
    day(TODAY, { 'RSA-2026-0001': 'P', 'RSA-2026-0002': 'A', 'RSA-2026-0003': 'P' });
    const u = U();
    mount(<AttendancePage />);
    await u.click(await screen.findByRole('button', { name: 'School overview' }));
    await screen.findByText(/1 of 2 classes recorded/);
    expect(screen.getByText('JSS 1').closest('tr')).toHaveTextContent('66.67%');
    expect(screen.getByText('JSS 2').closest('tr')).toHaveTextContent('Not recorded');
  });
});

// ================================================================== fees
async function addItem(u: ReturnType<typeof userEvent.setup>, name = 'Tuition', amount = '50,000', cls = 'JSS 1') {
  await u.click(await screen.findByRole('button', { name: 'Fee items' }));
  await u.click(await screen.findByRole('button', { name: 'Add fee item' }));
  await u.type(screen.getByLabelText('Name'), name);
  await u.type(screen.getByLabelText(/Amount per student/), amount);
  await u.click(screen.getByLabelText(cls));
  await u.click(screen.getByRole('button', { name: 'Add fee item' }));
  await screen.findByRole('button', { name: `Edit ${name}` });
}
const itemId = () => [...store.keys()].find((k) => k.startsWith(`tenants/${T}/feeItems/`))!.split('/').pop()!;

describe('Fee items and invoices', () => {
  it('creates a fee item with the amount stored as integer minor units', async () => {
    const u = U();
    mount(<Fees />, 'ACCOUNTANT');
    await addItem(u);
    const d = doc(`tenants/${T}/feeItems/${itemId()}`)!;
    expect(d).toMatchObject({ name: 'Tuition', category: 'TUITION', amount: 5_000_000, classIds: ['jss-1'], status: 'ACTIVE', session: '2026/2027', createdBy: 'admin1' });
    expect(Number.isInteger(d.amount)).toBe(true);
    expect(allWrites().some((o) => (o.data as { action?: string }).action === 'feeItem.created')).toBe(true);
  });
  it('validates: amount, classes and name', async () => {
    const u = U();
    mount(<Fees />);
    await u.click(await screen.findByRole('button', { name: 'Fee items' }));
    await u.click(await screen.findByRole('button', { name: 'Add fee item' }));
    await u.type(screen.getByLabelText(/Amount per student/), 'abc');
    await u.click(screen.getByRole('button', { name: 'Add fee item' }));
    expect(await screen.findByText('Enter a name for this fee.')).toBeInTheDocument();
    expect(screen.getByText(/Enter a valid amount/)).toBeInTheDocument();
    expect(screen.getByText('Choose at least one class.')).toBeInTheDocument();
    expect(writeLog).toHaveLength(0);
  });
  it('shows exactly who will be billed, then creates one invoice per ACTIVE student; running again bills only newcomers', async () => {
    const u = U();
    mount(<Fees />);
    await addItem(u);
    await u.click(screen.getByRole('button', { name: 'Generate invoices for Tuition' }));
    await para(/3 students will be billed NGN 50,000\.00 each \(NGN 150,000\.00 in total\)/);
    expect(writeLog.filter((b) => b.some((o) => o.path.includes('/fees/')))).toHaveLength(0);       // nothing written by the preview
    await u.click(screen.getByRole('button', { name: 'Create 3 invoices' }));
    await screen.findByText('3 invoices created.');
    const id = itemId();
    for (const s of ['0001', '0002', '0003']) {
      expect(doc(`tenants/${T}/fees/${id}_RSA-2026-${s}`)).toMatchObject({ itemId: id, amount: 5_000_000, amountPaid: 0, balance: 5_000_000, status: 'UNPAID', classId: 'jss-1', session: '2026/2027' });
    }
    expect(doc(`tenants/${T}/fees/${id}_RSA-2026-0004`)).toBeUndefined();                       // inactive student not billed
    expect(doc(`tenants/${T}/fees/${id}_RSA-2026-0005`)).toBeUndefined();                       // other class not billed
    seed(`tenants/${T}/students/RSA-2026-0009`, stu('RSA-2026-0009', 'New', 'Pupil'));
    await u.click(screen.getByRole('button', { name: 'Generate invoices for Tuition' }));
    await para(/1 student will be billed.*3 already have this invoice and are skipped/);
    await u.click(screen.getByRole('button', { name: 'Create 1 invoice' }));
    await screen.findByText('1 invoice created.');
    expect(doc(`tenants/${T}/fees/${id}_RSA-2026-0009`)).toBeTruthy();
    expect(Object.keys(Object.fromEntries([...store].filter(([k]) => k.startsWith(`tenants/${T}/fees/`))))).toHaveLength(4);
  });
  it('large classes are written in small batches and a failed batch is reported (the rest still go through)', async () => {
    for (let i = 10; i < 30; i++) seed(`tenants/${T}/students/RSA-2026-00${i}`, stu(`RSA-2026-00${i}`, `S${i}`, 'Kid', 'jss-2'));
    const u = U();
    mount(<Fees />);
    await addItem(u, 'Books', '5000', 'JSS 2');
    let n = 0;
    hooks.failBatch = (ops) => (ops.some((o) => o.path.includes('/fees/')) && ++n === 2 ? { code: 'unavailable' } : null);
    await u.click(screen.getByRole('button', { name: 'Generate invoices for Books' }));
    await para(/21 students will be billed/);
    await u.click(screen.getByRole('button', { name: 'Create 21 invoices' }));
    await screen.findByText(/13 invoices created\. 8 could not be saved/);
    expect(writeLog.filter((b) => b.some((o) => o.path.includes('/fees/'))).every((b) => b.length <= 8)).toBe(true);
    // retry bills only the 8 that failed
    hooks.failBatch = undefined;
    await u.click(screen.getByRole('button', { name: 'Generate invoices for Books' }));
    await para(/8 students will be billed/);
  });
  it('archive hides Generate; principal can look but not change', async () => {
    seed(`tenants/${T}/feeItems/tuition`, { tenantId: T, name: 'Tuition', category: 'TUITION', amount: 5_000_000, classIds: ['jss-1'], termId: '', session: '2026/2027', status: 'ACTIVE' });
    const u = U();
    mount(<Fees />);
    await u.click(await screen.findByRole('button', { name: 'Fee items' }));
    await u.click(await screen.findByRole('button', { name: 'Archive Tuition' }));
    await screen.findByRole('button', { name: 'Restore Tuition' });
    expect(screen.queryByRole('button', { name: 'Generate invoices for Tuition' })).not.toBeInTheDocument();
    expect(doc(`tenants/${T}/feeItems/tuition`)).toMatchObject({ status: 'ARCHIVED' });
    cleanup();
    mount(<Fees />, 'PRINCIPAL');
    await u.click(await screen.findByRole('button', { name: 'Fee items' }));
    await screen.findAllByText('Tuition');
    expect(screen.queryByRole('button', { name: 'Add fee item' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit /i })).not.toBeInTheDocument();
  });
});

const fee = (id: string, over: Record<string, unknown> = {}) => seed(`tenants/${T}/fees/${id}`, {
  tenantId: T, studentId: 'RSA-2026-0001', studentName: 'Ada Okafor', classId: 'jss-1', itemId: 'tuition', description: 'Tuition', category: 'TUITION',
  amount: 5_000_000, amountPaid: 0, balance: 5_000_000, status: 'UNPAID', session: '2026/2027', termId: '', dueDate: '', createdBy: 'x', ...over,
});
async function openAccount(u: ReturnType<typeof userEvent.setup>, adm = 'RSA-2026-0001') {
  await u.click(await screen.findByRole('button', { name: 'Student accounts' }));
  await u.type(await screen.findByLabelText('Admission number'), adm);
  await u.click(screen.getByRole('button', { name: 'Open account' }));
  await screen.findByText(/Class: JSS 1/);
}
async function pay(u: ReturnType<typeof userEvent.setup>, amount: string, extra: { method?: string; reference?: string } = {}) {
  await u.click(screen.getByRole('button', { name: 'Record payment for Tuition' }));
  const box = await screen.findByLabelText(/Amount \(NGN\)/);
  await u.clear(box); await u.type(box, amount);
  if (extra.method) await u.selectOptions(screen.getByLabelText('Method'), extra.method);
  if (extra.reference) await u.type(screen.getByLabelText('Reference'), extra.reference);
  await u.click(screen.getByRole('button', { name: 'Save payment' }));
}

describe('Student fee account', () => {
  it('records a partial payment: receipt + new balance in ONE batch, numbered receipt, audit, printable receipt', async () => {
    fee('tuition_RSA-2026-0001');
    const u = U();
    mount(<Fees />, 'ACCOUNTANT');
    await openAccount(u);
    await pay(u, '10,000.50');
    const receipt = await screen.findByRole('region', { name: 'Receipt' });
    const num = `RCPT-${YEAR}-000001`;
    expect(within(receipt).getByText(num)).toBeInTheDocument();
    expect(within(receipt).getByText(/NGN 10,000\.50/)).toBeInTheDocument();
    expect(within(receipt).getByText(/NGN 39,999\.50/)).toBeInTheDocument();                   // balance after
    expect(within(receipt).getByText('Ada Okafor (RSA-2026-0001)')).toBeInTheDocument();
    expect(within(receipt).getByText('Thank you')).toBeInTheDocument();
    expect(doc(`tenants/${T}/payments/${num}`)).toMatchObject({
      kind: 'PAYMENT', amount: 1_000_050, balanceAfter: 3_999_950, feeId: 'tuition_RSA-2026-0001', studentId: 'RSA-2026-0001',
      method: 'CASH', reversed: false, reversedBy: null, reverses: null, recordedBy: 'admin1', receiptNumber: num,
    });
    expect(doc(`tenants/${T}/fees/tuition_RSA-2026-0001`)).toMatchObject({ amountPaid: 1_000_050, balance: 3_999_950, status: 'PARTIAL' });
    const batch = writeLog.find((b) => b.some((o) => o.path.includes('/payments/')))!;
    expect(batch.map((o) => o.path)).toEqual(expect.arrayContaining([`tenants/${T}/payments/${num}`, `tenants/${T}/fees/tuition_RSA-2026-0001`]));  // atomic
    expect(batch.some((o) => (o.data as { action?: string }).action === 'payment.recorded')).toBe(true);
    expect(doc(`tenants/${T}/counters/receipts-${YEAR}`)).toEqual({ next: 2 });
    await userEvent.setup().click(within(receipt.parentElement as HTMLElement).getByRole('button', { name: 'Print receipt' }));
    expect(window.print).toHaveBeenCalled();
  });
  it('paying the full balance marks the fee PAID and removes the pay button; receipt numbers keep counting', async () => {
    fee('tuition_RSA-2026-0001', { amountPaid: 1_000_000, balance: 4_000_000, status: 'PARTIAL' });
    fee('books_RSA-2026-0001', { description: 'Books', amount: 100_000, balance: 100_000 });
    const u = U();
    mount(<Fees />);
    await openAccount(u);
    await pay(u, '40000');
    await screen.findByRole('region', { name: 'Receipt' });
    expect(doc(`tenants/${T}/fees/tuition_RSA-2026-0001`)).toMatchObject({ amountPaid: 5_000_000, balance: 0, status: 'PAID' });
    expect(screen.queryByRole('button', { name: 'Record payment for Tuition' })).not.toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Record payment for Books' }));
    await u.click(await screen.findByRole('button', { name: 'Save payment' }));
    await waitFor(() => expect(doc(`tenants/${T}/payments/RCPT-${YEAR}-000002`)).toBeTruthy());
    expect(doc(`tenants/${T}/fees/books_RSA-2026-0001`)).toMatchObject({ amountPaid: 100_000, balance: 0, status: 'PAID' });
  });
  it('refuses overpayment, zero, junk, future dates and missing references (no writes)', async () => {
    fee('tuition_RSA-2026-0001');
    const u = U();
    mount(<Fees />);
    await openAccount(u);
    await pay(u, '50,000.01');
    expect(await screen.findByText('That is more than the outstanding balance.')).toBeInTheDocument();
    const box = screen.getByLabelText(/Amount \(NGN\)/);
    await u.clear(box); await u.type(box, '-5');
    await u.click(screen.getByRole('button', { name: 'Save payment' }));
    expect(await screen.findByText('Enter a valid amount.')).toBeInTheDocument();
    await u.clear(box); await u.type(box, '100');
    fireEvent.change(screen.getByLabelText('Payment date'), { target: { value: addDays(TODAY, 1) } });
    await u.click(screen.getByRole('button', { name: 'Save payment' }));
    expect(await screen.findByText(/not in the future/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Payment date'), { target: { value: TODAY } });
    await u.selectOptions(screen.getByLabelText('Method'), 'BANK_TRANSFER');
    await u.click(screen.getByRole('button', { name: 'Save payment' }));
    expect(await screen.findByText(/reference is required for bank transfer/)).toBeInTheDocument();
    expect(writeLog).toHaveLength(0);
    await u.type(screen.getByLabelText('Reference'), 'TRX-778');
    await u.click(screen.getByRole('button', { name: 'Save payment' }));
    await screen.findByRole('region', { name: 'Receipt' });
    expect(allWrites().find((o) => o.path.includes('/payments/'))!.data).toMatchObject({ method: 'BANK_TRANSFER', reference: 'TRX-778', amount: 10_000 });
  });
  it('reversal: puts the money back, keeps the original on record, cannot be reversed twice', async () => {
    fee('tuition_RSA-2026-0001', { amountPaid: 1_000_000, balance: 4_000_000, status: 'PARTIAL' });
    seed(`tenants/${T}/payments/RCPT-${YEAR}-000001`, {
      tenantId: T, feeId: 'tuition_RSA-2026-0001', studentId: 'RSA-2026-0001', studentName: 'Ada Okafor', classId: 'jss-1', description: 'Tuition', amount: 1_000_000,
      balanceAfter: 4_000_000, kind: 'PAYMENT', method: 'CASH', reference: '', note: '', paymentDate: TODAY, receiptNumber: `RCPT-${YEAR}-000001`,
      reverses: null, reversed: false, reversedBy: null, recordedBy: 'x', recordedByName: 'Someone',
    });
    seed(`tenants/${T}/counters/receipts-${YEAR}`, { next: 2 });
    const u = U();
    mount(<Fees />);
    await openAccount(u);
    await u.click(screen.getByRole('button', { name: `Reverse payment RCPT-${YEAR}-000001` }));
    await u.click(await screen.findByRole('button', { name: 'Reverse payment' }));
    expect(await screen.findByText('Say why the payment is being reversed.')).toBeInTheDocument();
    await u.type(screen.getByLabelText('Reason'), 'Wrong student');
    await u.click(screen.getByRole('button', { name: 'Reverse payment' }));
    const receipt = await screen.findByRole('region', { name: 'Receipt' });
    expect(within(receipt).getByText('Payment reversal')).toBeInTheDocument();
    const rev = `REV-${YEAR}-000002`;
    expect(doc(`tenants/${T}/payments/${rev}`)).toMatchObject({ kind: 'REVERSAL', reverses: `RCPT-${YEAR}-000001`, amount: 1_000_000, balanceAfter: 5_000_000, note: 'Wrong student' });
    expect(doc(`tenants/${T}/payments/RCPT-${YEAR}-000001`)).toMatchObject({ reversed: true, reversedBy: rev, amount: 1_000_000 });   // original kept
    expect(doc(`tenants/${T}/fees/tuition_RSA-2026-0001`)).toMatchObject({ amountPaid: 0, balance: 5_000_000, status: 'UNPAID' });
    expect(screen.queryByRole('button', { name: `Reverse payment RCPT-${YEAR}-000001` })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: `Reverse payment ${rev}` })).not.toBeInTheDocument();     // a reversal cannot be reversed
    expect(screen.getAllByText('reversed').length).toBeGreaterThan(0);
  });
  it('cancel an unpaid fee (excluded from the totals) and restore it; paid fees cannot be cancelled', async () => {
    fee('tuition_RSA-2026-0001');
    fee('books_RSA-2026-0001', { description: 'Books', amount: 100_000, amountPaid: 100_000, balance: 0, status: 'PAID' });
    const u = U();
    mount(<Fees />);
    await openAccount(u);
    expect(screen.queryByRole('button', { name: 'Cancel Books' })).not.toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Cancel Tuition' }));
    await screen.findByRole('button', { name: 'Restore Tuition' });
    expect(doc(`tenants/${T}/fees/tuition_RSA-2026-0001`)).toMatchObject({ status: 'CANCELLED' });
    expect(screen.queryByRole('button', { name: 'Record payment for Tuition' })).not.toBeInTheDocument();
    expect(withinCard('Ada Okafor (RSA-2026-0001)').getAllByText('Balance')[0]!.nextElementSibling).toHaveTextContent('NGN 0.00');
    await u.click(screen.getByRole('button', { name: 'Restore Tuition' }));
    await screen.findByRole('button', { name: 'Record payment for Tuition' });
    expect(doc(`tenants/${T}/fees/tuition_RSA-2026-0001`)).toMatchObject({ status: 'UNPAID' });
  });
  it('adds a one-off fee for a student', async () => {
    const u = U();
    mount(<Fees />);
    await openAccount(u);
    await u.click(screen.getByRole('button', { name: 'Add a fee' }));
    await u.type(screen.getByLabelText('Description'), 'Excursion');
    await u.type(screen.getByLabelText(/Amount \(NGN\)/), '2,500');
    await u.click(screen.getByRole('button', { name: 'Add fee' }));
    await screen.findByText('Excursion');
    const key = [...store.keys()].find((k) => k.includes('/fees/custom_'))!;
    expect(doc(key)).toMatchObject({ description: 'Excursion', amount: 250_000, balance: 250_000, status: 'UNPAID', itemId: null, studentId: 'RSA-2026-0001', amountPaid: 0 });
  });
  it('a conflict (balance changed elsewhere / not permitted) reloads the account, explains, and records nothing', async () => {
    fee('tuition_RSA-2026-0001');
    hooks.failBatch = (ops) => (ops.some((o) => o.path.includes('/payments/')) ? { code: 'permission-denied' } : null);
    const u = U();
    mount(<Fees />);
    await openAccount(u);
    seed(`tenants/${T}/fees/tuition_RSA-2026-0001`, { ...store.get(`tenants/${T}/fees/tuition_RSA-2026-0001`)!, amountPaid: 2_000_000, balance: 3_000_000, status: 'PARTIAL' });   // someone else paid meanwhile
    await pay(u, '100');
    expect(await alert()).toHaveTextContent('This account changed while you were working');
    expect(await screen.findByText('NGN 30,000.00', { selector: 'td' })).toBeInTheDocument();     // reloaded figure
    expect([...store.keys()].some((k) => k.includes('/payments/'))).toBe(false);
  });
  it('unknown or malformed admission numbers give a friendly message', async () => {
    const u = U();
    mount(<Fees />);
    await u.click(await screen.findByRole('button', { name: 'Student accounts' }));
    await u.type(await screen.findByLabelText('Admission number'), 'NOPE-1');
    await u.click(screen.getByRole('button', { name: 'Open account' }));
    expect(await alert()).toHaveTextContent('No student with that admission number.');
    await u.clear(screen.getByLabelText('Admission number')); await u.type(screen.getByLabelText('Admission number'), 'a/b');
    await u.click(screen.getByRole('button', { name: 'Open account' }));
    expect(await alert()).toHaveTextContent('No student with that admission number.');
  });
  it('read-only roles see the account but no money buttons', async () => {
    fee('tuition_RSA-2026-0001', { amountPaid: 1_000_000, balance: 4_000_000, status: 'PARTIAL' });
    const u = U();
    mount(<Fees />, 'PRINCIPAL');
    await openAccount(u);
    expect(screen.getAllByText('Tuition').length).toBeGreaterThan(0);
    for (const b of [/Record payment/, /Cancel /, /Add a fee/, /Reverse payment/]) expect(screen.queryByRole('button', { name: b })).not.toBeInTheDocument();
  });
});

describe('Fees summary and outstanding', () => {
  beforeEach(() => {
    fee('t_S1', { studentId: 'RSA-2026-0001', studentName: 'Ada Okafor', amountPaid: 1_000_000, balance: 4_000_000, status: 'PARTIAL' });
    fee('t_S2', { studentId: 'RSA-2026-0002', studentName: 'Bola Ade', amountPaid: 5_000_000, balance: 0, status: 'PAID' });
    fee('t_S3', { studentId: 'RSA-2026-0003', studentName: 'Chidi Eze' });
    fee('t_S5', { studentId: 'RSA-2026-0005', studentName: 'Dayo Bello', classId: 'jss-2', amount: 2_000_000, balance: 2_000_000 });
    fee('t_X', { studentId: 'RSA-2026-0001', amount: 99_900, balance: 99_900, status: 'CANCELLED' });          // cancelled: never counted
    fee('t_OLD', { studentId: 'RSA-2026-0001', session: '2025/2026', amount: 777_700, balance: 777_700 });      // other session
  });
  it('totals come from server-side sums: billed, collected, outstanding, rate; cancelled and other sessions excluded', async () => {
    mount(<Fees />);
    await screen.findByText('4 invoices');
    expect(withinCard('Billed').getByText('NGN 170,000.00')).toBeInTheDocument();       // 50k*3 + 20k
    expect(withinCard('Collected').getByText('NGN 60,000.00')).toBeInTheDocument();
    expect(withinCard('Collected').getByText('35.29% of billed')).toBeInTheDocument();
    expect(withinCard('Outstanding').getByText('NGN 110,000.00')).toBeInTheDocument();
  });
  it('lists only unpaid/partial lines; class and session filters recompute everything', async () => {
    const u = U();
    mount(<Fees />);
    await screen.findByText('Chidi Eze');
    expect(screen.queryByText('Bola Ade')).not.toBeInTheDocument();                     // fully paid
    expect(screen.getAllByText('Ada Okafor')).toHaveLength(1);                           // cancelled line excluded
    await u.selectOptions(screen.getByLabelText('Class'), 'jss-2');
    await screen.findByText('1 invoice');
    expect(withinCard('Billed').getByText('NGN 20,000.00')).toBeInTheDocument();
    expect(screen.queryByText('Chidi Eze')).not.toBeInTheDocument();
    await u.selectOptions(screen.getByLabelText('Class'), '');
    const s = screen.getByLabelText('Session');
    await u.clear(s); await u.type(s, '2025/2026');
    await screen.findByText('1 invoice');
    expect(withinCard('Billed').getByText('NGN 7,777.00')).toBeInTheDocument();
  });
  it('Open account jumps to that student; outstanding CSV uses plain decimal amounts', async () => {
    const made: Blob[] = [];
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b) => { made.push(b); return 'blob:x'; };
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const u = U();
    mount(<Fees />);
    await screen.findByText('Chidi Eze');
    await u.click(screen.getByRole('button', { name: 'Download CSV' }));
    const csv = await blobText(made[0]!);
    expect(csv).toContain('Admission no.,Student,Class,Fee,Category,Due date,Amount,Paid,Balance,Status');
    expect(csv).toContain('RSA-2026-0003,Chidi Eze,JSS 1,Tuition,Tuition,,50000.00,0.00,50000.00,UNPAID');
    await u.click(screen.getByRole('button', { name: 'Open account of Chidi Eze' }));
    expect(await screen.findByText(/Class: JSS 1/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Chidi Eze (RSA-2026-0003)' })).toBeInTheDocument();
  });
  it('paginates outstanding lines 25 at a time', async () => {
    for (let i = 0; i < 30; i++) fee(`bulk_${String(i).padStart(2, '0')}`, { studentId: `B-${i}`, studentName: `Bulk ${i}`, amount: 100, balance: 100 });
    const u = U();
    mount(<Fees />);
    await screen.findByRole('button', { name: 'Load more' });
    expect(screen.getAllByRole('button', { name: /^Open account of/ })).toHaveLength(25);
    await u.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /^Open account of/ }).length).toBeGreaterThan(25));
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });
});

// ======================================================= staff, terms, settings
describe('Add staff user', () => {
  it('creates an accountant: member + directory in one batch, forced password change, credentials shown once', async () => {
    const u = U();
    mount(<Users />);
    await u.click(await screen.findByRole('button', { name: 'Add staff user' }));
    await u.type(screen.getByLabelText('Full name'), 'Mr Cash');
    await u.type(screen.getByLabelText(/Email/), 'cash@x.com');
    await u.click(screen.getByRole('button', { name: 'Create user' }));
    await screen.findByText(/account created/i);
    expect(accounts[0]).toMatchObject({ email: 'cash@x.com' });
    expect(doc(`tenants/${T}/members/uid-1`)).toMatchObject({ role: 'ACCOUNTANT', status: 'ACTIVE', mustChangePassword: true, displayName: 'Mr Cash', loginId: 'cash@x.com' });
    expect(doc('userDirectory/uid-1')).toEqual({ tenantId: T });
    expect(screen.getByText(accounts[0]!.password)).toBeInTheDocument();
    expect(allWrites().some((o) => (o.data as { action?: string }).action === 'user.created')).toBe(true);
  });
  it('validates the email and name before creating anything', async () => {
    const u = U();
    mount(<Users />);
    await u.click(await screen.findByRole('button', { name: 'Add staff user' }));
    await u.type(screen.getByLabelText('Full name'), 'Mr Cash');
    await u.type(screen.getByLabelText(/Email/), 'nope');
    await u.click(screen.getByRole('button', { name: 'Create user' }));
    expect(await alert()).toHaveTextContent('valid email');
    expect(accounts).toHaveLength(0);
  });
});

describe('Term dates and attendance policy', () => {
  it('sets term dates and rejects an end before the start', async () => {
    const u = U();
    mount(<Academics />);
    const termsCard = async () => withinCard('Terms');
    await screen.findByText('Term 1');
    await u.click((await termsCard()).getByRole('button', { name: 'Set dates for Term 1' }));
    fireEvent.change(screen.getByLabelText('Start date for Term 1'), { target: { value: '2026-09-07' } });
    fireEvent.change(screen.getByLabelText('End date for Term 1'), { target: { value: '2026-09-01' } });
    await u.click(screen.getByRole('button', { name: 'Save dates' }));
    expect(await alert()).toHaveTextContent('end date cannot be before');
    fireEvent.change(screen.getByLabelText('End date for Term 1'), { target: { value: '2026-12-18' } });
    await u.click(screen.getByRole('button', { name: 'Save dates' }));
    await screen.findByText('2026-09-07 to 2026-12-18');
    expect(doc(`tenants/${T}/terms/term-1`)).toMatchObject({ startDate: '2026-09-07', endDate: '2026-12-18' });
  });
  it('saves the attendance policy chosen in Settings', async () => {
    const u = U();
    mount(<Settings />);
    await u.click(await screen.findByLabelText('A late student counts as attended'));
    await u.click(screen.getByLabelText('An excused absence counts against the student'));
    await u.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByText('Settings saved.');
    expect((doc(`tenants/${T}`)!.settings as { attendance: unknown }).attendance).toEqual({ lateCountsAsPresent: false, excusedCountsAsAbsent: true });
  });
});
