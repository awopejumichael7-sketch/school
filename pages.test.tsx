// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

const h = vi.hoisted(() => ({
  updatePassword: vi.fn(), sendPasswordResetEmail: vi.fn(),
  auth: { status: 'ready', user: { uid: 'admin1', email: 'admin@x.com' }, tenantId: 't1', isPlatformAdmin: false,
    refresh: vi.fn(), signIn: vi.fn(), signOut: vi.fn() },
}));
vi.mock('firebase/firestore', async (orig) => (await import('./test-store')).firestoreMock(await orig()));
vi.mock('firebase/auth', async (orig) => ({ ...(await orig<typeof import('firebase/auth')>()), updatePassword: h.updatePassword, sendPasswordResetEmail: h.sendPasswordResetEmail }));
vi.mock('./lib-firebase', async () => (await import('./test-store')).fakeFirebase());
vi.mock('./lib-ops', async (orig) => ({ ...(await orig<typeof import('./lib-ops')>()), applyOps: (await import('./test-store')).applyOpsFake }));
vi.mock('./lib-newuser', async () => ({ withNewAccount: (await import('./test-store')).withNewAccountFake }));
vi.mock('./ctx-auth', () => ({ useAuth: () => h.auth }));

import { TenantProvider } from './ctx-tenant';
import { store, seed, resetStore, writeLog, accounts, hooks } from './test-store';
import Academics from './page-academics';
import Students from './page-students';
import Teachers from './page-teachers';
import Parents from './page-parents';
import Users from './page-users';
import Settings from './page-settings';
import ImportPage from './page-import';
import MyClasses from './page-myclasses';
import ChangePassword from './page-changepassword';
import { DEFAULT_ASSESSMENT, DEFAULT_GRADING } from './lib-config';
import type { MemberDoc, Role, TenantDoc } from './types';

if (!File.prototype.text) {
  File.prototype.text = function (this: File) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsText(this); });
  };
}

const T = 't1';
const YEAR = new Date().getFullYear();
const tenantDoc = {
  name: 'Royal Scholars Academy', ownerUid: 'admin1', licenseId: 'h', plan: 'standard', status: 'ACTIVE', installationId: 'i', expiresAt: null,
  setupComplete: true,
  profile: { name: 'Royal Scholars Academy', motto: 'Lead', address: '', phone: '', email: '', website: '', footer: '', emailSenderName: 'Royal' },
  settings: { academicSession: '2026/2027', terms: ['Term 1'], currency: 'NGN', timezone: 'Africa/Lagos', grading: DEFAULT_GRADING, assessment: DEFAULT_ASSESSMENT, admissionPrefix: 'RSA' },
} as unknown as TenantDoc;

function seedSchool() {
  seed(`tenants/${T}`, tenantDoc as unknown as Record<string, unknown>);
  seed(`publicProfiles/${T}`, { tenantId: T, slug: 'royal', name: 'Royal Scholars Academy', motto: 'Lead', logoDataUrl: null, primaryColor: '#112233', secondaryColor: '#445566' });
  seed(`tenants/${T}/classes/jss-1`, { tenantId: T, name: 'JSS 1', order: 0, status: 'ACTIVE' });
  seed(`tenants/${T}/classes/jss-2`, { tenantId: T, name: 'JSS 2', order: 1, status: 'ACTIVE' });
  seed(`tenants/${T}/subjects/maths`, { tenantId: T, name: 'Mathematics', order: 0, status: 'ACTIVE' });
  seed(`tenants/${T}/subjects/english`, { tenantId: T, name: 'English', order: 1, status: 'ACTIVE' });
  seed(`tenants/${T}/terms/term-1`, { tenantId: T, name: 'Term 1', order: 0, status: 'ACTIVE' });
  seed(`tenants/${T}/members/admin1`, { uid: 'admin1', tenantId: T, role: 'SCHOOL_ADMIN', status: 'ACTIVE', displayName: 'Ada Admin', email: 'admin@x.com' });
}
const student = (adm: string, over: Record<string, unknown> = {}) => ({
  tenantId: T, studentId: adm, admissionNumber: adm, firstName: 'Ada', middleName: '', lastName: 'Okafor', gender: 'FEMALE',
  dateOfBirth: '2014-05-21', photo: null, classId: 'jss-1', parentIds: [], phone: '', email: '', address: '',
  admissionDate: '2026-09-14', status: 'ACTIVE', academicSession: '2026/2027', uid: null, ...over,
});

function mount(ui: ReactElement, role: Role = 'SCHOOL_ADMIN', extra: Partial<MemberDoc> = {}) {
  const member = { uid: 'admin1', tenantId: T, role, status: 'ACTIVE', displayName: 'Ada Admin', email: 'admin@x.com', ...extra } as MemberDoc;
  return render(<MemoryRouter><TenantProvider tenantId={T} uid="admin1" tenant={tenantDoc} member={member}>{ui}</TenantProvider></MemoryRouter>);
}
const doc = (p: string) => store.get(p);
const allWrites = () => writeLog.flat();
const alert = () => screen.findByRole('alert');

beforeEach(() => {
  cleanup(); resetStore(); seedSchool();
  h.updatePassword.mockReset(); h.sendPasswordResetEmail.mockReset(); h.auth.refresh.mockReset(); h.auth.refresh.mockResolvedValue(undefined);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

// =============================================================== academics
describe('Academics', () => {
  const card = (name: string) => within(screen.getByRole('heading', { name }).closest('section') as HTMLElement);
  it('adds a class with an id, next order, active status and an audit entry', async () => {
    const u = userEvent.setup();
    mount(<Academics />);
    await screen.findByText('JSS 2');
    await u.type(card('Classes').getByLabelText('New class name'), 'JSS 3');
    await u.click(card('Classes').getByRole('button', { name: 'Add' }));
    await screen.findByText('JSS 3');
    expect(doc(`tenants/${T}/classes/jss-3`)).toMatchObject({ tenantId: T, name: 'JSS 3', order: 2, status: 'ACTIVE' });
    expect(allWrites().some((o) => o.path.includes('/auditLogs/') && (o.data as { action: string }).action === 'classes.created')).toBe(true);
  });
  it('blocks duplicates case-insensitively and writes nothing', async () => {
    const u = userEvent.setup();
    mount(<Academics />);
    await screen.findByText('JSS 2');
    await u.type(card('Classes').getByLabelText('New class name'), 'jss 1');
    await u.click(card('Classes').getByRole('button', { name: 'Add' }));
    expect(await alert()).toHaveTextContent('already exists');
    expect(writeLog.length).toBe(0);
  });
  it('terms record the current session', async () => {
    const u = userEvent.setup();
    mount(<Academics />);
    await screen.findByText('Term 1');
    await u.type(card('Terms').getByLabelText('New term name'), 'Term 2');
    await u.click(card('Terms').getByRole('button', { name: 'Add' }));
    await screen.findByText('Term 2');
    expect(doc(`tenants/${T}/terms/term-2`)).toMatchObject({ session: '2026/2027' });
  });
  it('archives and restores instead of deleting; archived items are labelled', async () => {
    const u = userEvent.setup();
    mount(<Academics />);
    await u.click(await screen.findByRole('button', { name: 'Archive JSS 2' }));
    await screen.findByText('archived');
    expect(doc(`tenants/${T}/classes/jss-2`)).toMatchObject({ status: 'ARCHIVED', name: 'JSS 2' });
    await u.click(screen.getByRole('button', { name: 'Restore JSS 2' }));
    await waitFor(() => expect(screen.queryByText('archived')).not.toBeInTheDocument());
    expect(doc(`tenants/${T}/classes/jss-2`)).toMatchObject({ status: 'ACTIVE' });
  });
  it('renames, rejecting a name already used by another item', async () => {
    const u = userEvent.setup();
    mount(<Academics />);
    await u.click(await screen.findByRole('button', { name: 'Rename JSS 2' }));
    const box = screen.getByLabelText('Rename JSS 2');
    await u.clear(box); await u.type(box, 'JSS 1');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    expect(await alert()).toHaveTextContent('already exists');
    await u.clear(box); await u.type(box, 'Junior 2');
    await u.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Junior 2');
    expect(doc(`tenants/${T}/classes/jss-2`)).toMatchObject({ name: 'Junior 2' });
  });
});

// ================================================================ students
async function fillStudent(u: ReturnType<typeof userEvent.setup>, over: { first?: string; adm?: string } = {}) {
  await u.click(await screen.findByRole('button', { name: 'Add student' }));
  await u.type(screen.getByLabelText(/first name/i), over.first ?? 'Ada');
  await u.type(screen.getByLabelText(/last name/i), 'Okafor');
  await u.selectOptions(screen.getByLabelText('Gender'), 'FEMALE');
  fireEvent.change(screen.getByLabelText(/date of birth/i), { target: { value: '2014-05-21' } });
  await u.selectOptions(screen.getByLabelText('Class'), 'jss-1');
  fireEvent.change(screen.getByLabelText(/admission date/i), { target: { value: '2026-09-14' } });
  if (over.adm) await u.type(screen.getByLabelText('Admission number'), over.adm);
}
describe('Students', () => {
  it('creates a student with an auto admission number from the counter', async () => {
    const u = userEvent.setup();
    mount(<Students />);
    await fillStudent(u);
    await u.click(screen.getByRole('button', { name: 'Add student' }));
    await screen.findByText('RSA-2026-0001');
    expect(doc(`tenants/${T}/students/RSA-2026-0001`)).toMatchObject({
      studentId: 'RSA-2026-0001', firstName: 'Ada', classId: 'jss-1', status: 'ACTIVE', parentIds: [], uid: null, academicSession: '2026/2027', tenantId: T,
    });
    expect(doc(`tenants/${T}/counters/students-2026`)).toEqual({ next: 2 });
    // second student gets the next number
    await fillStudent(u, { first: 'Bola' });
    await u.click(screen.getByRole('button', { name: 'Add student' }));
    await screen.findByText('RSA-2026-0002');
  });
  it('shows field errors and writes nothing for an empty form', async () => {
    const u = userEvent.setup();
    mount(<Students />);
    await u.click(await screen.findByRole('button', { name: 'Add student' }));
    await u.click(screen.getByRole('button', { name: 'Add student' }));
    expect(await screen.findByText('Enter the first name.')).toBeInTheDocument();
    expect(screen.getByText('Choose a class.')).toBeInTheDocument();
    expect(writeLog.length).toBe(0);
  });
  it('rejects a custom admission number that already exists, and upper-cases new ones', async () => {
    seed(`tenants/${T}/students/CUSTOM-1`, student('CUSTOM-1'));
    const u = userEvent.setup();
    mount(<Students />);
    await fillStudent(u, { adm: 'custom-1' });
    await u.click(screen.getByRole('button', { name: 'Add student' }));
    expect(await alert()).toHaveTextContent('already exists');
    const box = screen.getByLabelText('Admission number');
    await u.clear(box); await u.type(box, 'new-77');
    await u.click(screen.getByRole('button', { name: 'Add student' }));
    await screen.findByText('NEW-77');
    expect(doc(`tenants/${T}/students/NEW-77`)).toBeTruthy();
  });
  it('creates a sign-in: private username, forced password change, credentials shown once', async () => {
    const u = userEvent.setup();
    mount(<Students />);
    await fillStudent(u);
    await u.click(screen.getByLabelText(/also create a sign-in/i));
    await u.click(screen.getByRole('button', { name: 'Add student' }));
    await screen.findByText(/account created/i);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.email).toBe('rsa-2026-0001@royal.login.invalid');
    expect(screen.getByText(accounts[0]!.password)).toBeInTheDocument();
    expect(doc(`tenants/${T}/members/uid-1`)).toMatchObject({ role: 'STUDENT', status: 'ACTIVE', mustChangePassword: true, loginId: 'RSA-2026-0001' });
    expect(doc('userDirectory/uid-1')).toEqual({ tenantId: T });
    expect(doc(`tenants/${T}/students/RSA-2026-0001`)).toMatchObject({ uid: 'uid-1' });
    // member + directory + student land in ONE batch (atomic)
    const batch = writeLog.find((b) => b.some((o) => o.path === 'userDirectory/uid-1'))!;
    expect(batch.map((o) => o.path)).toEqual(expect.arrayContaining([`tenants/${T}/students/RSA-2026-0001`, `tenants/${T}/members/uid-1`]));
    await u.click(screen.getByRole('button', { name: /i have saved it/i }));
    expect(screen.queryByText(accounts[0]!.password)).not.toBeInTheDocument();
  });
  it('shows a friendly error and keeps no student if saving fails', async () => {
    hooks.failBatch = () => ({ code: 'permission-denied' });
    const u = userEvent.setup();
    mount(<Students />);
    await fillStudent(u);
    await u.click(screen.getByRole('button', { name: 'Add student' }));
    const a = await alert();
    expect(a).toHaveTextContent("You don't have permission to perform this action.");
    expect(a.textContent).not.toMatch(/firebase|PERMISSION_DENIED/i);
    expect(doc(`tenants/${T}/students/RSA-2026-0001`)).toBeUndefined();
  });
  it('edits without touching immutable fields, and can change class', async () => {
    seed(`tenants/${T}/students/RSA-2026-0001`, student('RSA-2026-0001'));
    const u = userEvent.setup();
    mount(<Students />);
    await u.click(await screen.findByRole('button', { name: 'Edit Ada Okafor' }));
    expect(screen.queryByLabelText(/admission number/i)).not.toBeInTheDocument();
    await u.selectOptions(screen.getByLabelText('Class'), 'jss-2');
    await u.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('cell', { name: 'JSS 2' })).toBeInTheDocument();
    const op = allWrites().find((o) => o.kind === 'update' && o.path.endsWith('RSA-2026-0001'))!;
    for (const k of ['tenantId', 'admissionNumber', 'studentId', 'createdAt', 'createdBy', 'uid', 'parentIds']) expect(op.data).not.toHaveProperty(k);
    expect(doc(`tenants/${T}/students/RSA-2026-0001`)).toMatchObject({ classId: 'jss-2', admissionNumber: 'RSA-2026-0001' });
  });
  it('deactivating a student with a login also disables their sign-in', async () => {
    seed(`tenants/${T}/students/RSA-2026-0001`, student('RSA-2026-0001', { uid: 'uid-9' }));
    seed(`tenants/${T}/members/uid-9`, { uid: 'uid-9', tenantId: T, role: 'STUDENT', status: 'ACTIVE', displayName: 'Ada Okafor', email: '' });
    const u = userEvent.setup();
    mount(<Students />);
    await u.click(await screen.findByRole('button', { name: 'Deactivate Ada Okafor' }));
    await screen.findByRole('button', { name: 'Activate Ada Okafor' });
    expect(doc(`tenants/${T}/students/RSA-2026-0001`)).toMatchObject({ status: 'INACTIVE' });
    expect(doc(`tenants/${T}/members/uid-9`)).toMatchObject({ status: 'DISABLED' });
    await u.click(screen.getByRole('button', { name: 'Activate Ada Okafor' }));
    await screen.findByRole('button', { name: 'Deactivate Ada Okafor' });
    expect(doc(`tenants/${T}/members/uid-9`)).toMatchObject({ status: 'ACTIVE' });
  });
  it('paginates 25 at a time, filters by class, and finds by admission number', async () => {
    for (let i = 1; i <= 30; i++) seed(`tenants/${T}/students/RSA-2026-${String(i).padStart(4, '0')}`, student(`RSA-2026-${String(i).padStart(4, '0')}`, { classId: i <= 27 ? 'jss-1' : 'jss-2', firstName: `S${i}` }));
    const u = userEvent.setup();
    mount(<Students />);
    await screen.findByText('RSA-2026-0025');
    expect(screen.queryByText('RSA-2026-0026')).not.toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('RSA-2026-0030');
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    await u.selectOptions(screen.getByLabelText('Class'), 'jss-2');
    await waitFor(() => expect(screen.queryByText('RSA-2026-0001')).not.toBeInTheDocument());
    expect(screen.getByText('RSA-2026-0028')).toBeInTheDocument();
    await u.selectOptions(screen.getByLabelText('Class'), '');
    await u.type(screen.getByLabelText('Find by admission number'), 'RSA-2026-0003');
    await u.click(screen.getByRole('button', { name: 'Find' }));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2));
    await u.clear(screen.getByLabelText('Find by admission number'));
    await u.type(screen.getByLabelText('Find by admission number'), 'NOPE-1');
    await u.click(screen.getByRole('button', { name: 'Find' }));
    expect(await alert()).toHaveTextContent('No student with that admission number.');
    await u.clear(screen.getByLabelText('Find by admission number'));
    await u.type(screen.getByLabelText('Find by admission number'), 'a/b/c');   // not a valid path piece: no crash, friendly message
    await u.click(screen.getByRole('button', { name: 'Find' }));
    expect(await alert()).toHaveTextContent('No student with that admission number.');
    await u.clear(screen.getByLabelText('Find by admission number'));
    await u.type(screen.getByLabelText('Find by admission number'), 'rsa-2026-0003');   // case-insensitive
    await u.click(screen.getByRole('button', { name: 'Find' }));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2));
  });
  it('a principal can look but not change', async () => {
    seed(`tenants/${T}/students/RSA-2026-0001`, student('RSA-2026-0001'));
    mount(<Students />, 'PRINCIPAL');
    await screen.findByText('RSA-2026-0001');
    expect(screen.queryByRole('button', { name: 'Add student' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit /i })).not.toBeInTheDocument();
  });
});

// ================================================================ teachers
async function fillTeacher(u: ReturnType<typeof userEvent.setup>, email = 'bello@x.com') {
  await u.click(await screen.findByRole('button', { name: 'Add teacher' }));
  await u.type(screen.getByLabelText('Full name'), 'Mrs Bello');
  if (email) await u.type(screen.getByLabelText(/email/i), email);
  await u.click(screen.getByLabelText('JSS 1'));
  await u.click(screen.getByLabelText('Mathematics'));
}
describe('Teachers', () => {
  it('creates a teacher + login in one atomic batch with assignments mirrored on the member', async () => {
    const u = userEvent.setup();
    mount(<Teachers />);
    await fillTeacher(u);
    await u.click(screen.getByRole('button', { name: 'Add teacher' }));
    await screen.findByText(/account created/i);
    expect(accounts[0]).toMatchObject({ email: 'bello@x.com' });
    expect(doc(`tenants/${T}/teachers/uid-1`)).toMatchObject({ name: 'Mrs Bello', uid: 'uid-1', classes: ['jss-1'], subjects: ['maths'], status: 'ACTIVE', loginId: 'bello@x.com' });
    expect(doc(`tenants/${T}/members/uid-1`)).toMatchObject({ role: 'TEACHER', classIds: ['jss-1'], subjectIds: ['maths'], mustChangePassword: true });
    expect(doc('userDirectory/uid-1')).toEqual({ tenantId: T });
    expect(screen.getByText(accounts[0]!.password)).toBeInTheDocument();
  });
  it('requires a valid email and writes nothing otherwise', async () => {
    const u = userEvent.setup();
    mount(<Teachers />);
    await fillTeacher(u, 'not-an-email');
    await u.click(screen.getByRole('button', { name: 'Add teacher' }));
    expect(await screen.findByText(/valid email address/i)).toBeInTheDocument();
    expect(accounts).toHaveLength(0); expect(writeLog).toHaveLength(0);
  });
  it('an email that already has an account gives a friendly message', async () => {
    const u = userEvent.setup();
    mount(<Teachers />);
    await fillTeacher(u);
    await u.click(screen.getByRole('button', { name: 'Add teacher' }));
    await screen.findByText(/account created/i);
    await u.click(screen.getByRole('button', { name: /i have saved it/i }));
    await fillTeacher(u);
    await u.click(screen.getByRole('button', { name: 'Add teacher' }));
    expect(await alert()).toHaveTextContent('already exists');
  });
  it('edit updates assignments on the teacher AND the member (rules read the member)', async () => {
    seed(`tenants/${T}/teachers/t9`, { tenantId: T, teacherId: 'TCH-T9', uid: 't9', name: 'Mr Odd', photo: null, phone: '', email: 'odd@x.com', loginId: 'odd@x.com', subjects: ['maths'], classes: ['jss-1'], status: 'ACTIVE' });
    seed(`tenants/${T}/members/t9`, { uid: 't9', tenantId: T, role: 'TEACHER', status: 'ACTIVE', displayName: 'Mr Odd', email: 'odd@x.com', classIds: ['jss-1'], subjectIds: ['maths'] });
    const u = userEvent.setup();
    mount(<Teachers />);
    await u.click(await screen.findByRole('button', { name: 'Edit Mr Odd' }));
    expect(screen.getByLabelText(/email/i)).toBeDisabled();
    await u.click(screen.getByLabelText('JSS 1')); await u.click(screen.getByLabelText('JSS 2'));
    await u.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Mr Odd');
    expect(doc(`tenants/${T}/teachers/t9`)).toMatchObject({ classes: ['jss-2'], subjects: ['maths'] });
    expect(doc(`tenants/${T}/members/t9`)).toMatchObject({ classIds: ['jss-2'], role: 'TEACHER' });
  });
  it('deactivating locks the teacher out (member disabled) and activating restores', async () => {
    seed(`tenants/${T}/teachers/t9`, { tenantId: T, teacherId: 'TCH-T9', uid: 't9', name: 'Mr Odd', photo: null, phone: '', email: 'odd@x.com', loginId: 'odd@x.com', subjects: [], classes: [], status: 'ACTIVE' });
    seed(`tenants/${T}/members/t9`, { uid: 't9', tenantId: T, role: 'TEACHER', status: 'ACTIVE', displayName: 'Mr Odd', email: 'odd@x.com' });
    const u = userEvent.setup();
    mount(<Teachers />);
    await u.click(await screen.findByRole('button', { name: 'Deactivate Mr Odd' }));
    await screen.findByRole('button', { name: 'Activate Mr Odd' });
    expect(doc(`tenants/${T}/members/t9`)).toMatchObject({ status: 'DISABLED' });
    await u.click(screen.getByRole('button', { name: 'Activate Mr Odd' }));
    await waitFor(() => expect(doc(`tenants/${T}/members/t9`)).toMatchObject({ status: 'ACTIVE' }));
  });
  it('sends a password reset email', async () => {
    seed(`tenants/${T}/teachers/t9`, { tenantId: T, teacherId: 'TCH-T9', uid: 't9', name: 'Mr Odd', photo: null, phone: '', email: 'odd@x.com', loginId: 'odd@x.com', subjects: [], classes: [], status: 'ACTIVE' });
    h.sendPasswordResetEmail.mockResolvedValue(undefined);
    const u = userEvent.setup();
    mount(<Teachers />);
    await u.click(await screen.findByRole('button', { name: 'Send password reset to Mr Odd' }));
    await screen.findByText(/reset email was sent to odd@x.com/i);
    expect(h.sendPasswordResetEmail.mock.calls[0]![1]).toBe('odd@x.com');
  });
  it('staff can view teachers but not manage them', async () => {
    seed(`tenants/${T}/teachers/t9`, { tenantId: T, teacherId: 'TCH-T9', uid: 't9', name: 'Mr Odd', photo: null, phone: '', email: 'odd@x.com', loginId: 'odd@x.com', subjects: [], classes: [], status: 'ACTIVE' });
    mount(<Teachers />, 'STAFF');
    await screen.findByText('Mr Odd');
    expect(screen.queryByRole('button', { name: 'Add teacher' })).not.toBeInTheDocument();
  });
});

// ================================================================= parents
const kid = (n: string, parents: string[] = []) => seed(`tenants/${T}/students/${n}`, student(n, { parentIds: parents }));
async function fillParent(u: ReturnType<typeof userEvent.setup>, kids: string, email = '') {
  await u.click(await screen.findByRole('button', { name: 'Add parent' }));
  await u.type(screen.getByLabelText('Full name'), 'Mr Okafor');
  if (email) await u.type(screen.getByLabelText(/email/i), email);
  await u.type(screen.getByLabelText(/children/i), kids);
}
describe('Parents', () => {
  it('creates one account linked to several children (both sides updated, one batch)', async () => {
    kid('RSA-2026-0001'); kid('RSA-2026-0002');
    const u = userEvent.setup();
    mount(<Parents />);
    await fillParent(u, 'rsa-2026-0001, RSA-2026-0002');
    await u.click(screen.getByRole('button', { name: 'Add parent' }));
    await screen.findByText(/account created/i);
    expect(accounts[0]!.email).toMatch(/^parent-[a-z0-9]{6}@royal\.login\.invalid$/);
    expect(doc(`tenants/${T}/parents/uid-1`)).toMatchObject({ childIds: ['RSA-2026-0001', 'RSA-2026-0002'], status: 'ACTIVE' });
    expect(doc(`tenants/${T}/students/RSA-2026-0001`)).toMatchObject({ parentIds: ['uid-1'] });
    expect(doc(`tenants/${T}/students/RSA-2026-0002`)).toMatchObject({ parentIds: ['uid-1'] });
    expect(doc(`tenants/${T}/members/uid-1`)).toMatchObject({ role: 'PARENT', mustChangePassword: true });
    expect(writeLog.some((b) => b.length >= 5 && b.some((o) => o.path === 'userDirectory/uid-1'))).toBe(true);
  });
  it('uses a real email as the sign-in when given', async () => {
    kid('RSA-2026-0001');
    const u = userEvent.setup();
    mount(<Parents />);
    await fillParent(u, 'RSA-2026-0001', 'dad@x.com');
    await u.click(screen.getByRole('button', { name: 'Add parent' }));
    await screen.findByText(/account created/i);
    expect(accounts[0]!.email).toBe('dad@x.com');
    expect(doc(`tenants/${T}/members/uid-1`)).toMatchObject({ loginId: 'dad@x.com', email: 'dad@x.com' });
  });
  it('an unknown admission number is rejected BEFORE any account is created', async () => {
    kid('RSA-2026-0001');
    const u = userEvent.setup();
    mount(<Parents />);
    await fillParent(u, 'RSA-2026-0001, RSA-9999');
    await u.click(screen.getByRole('button', { name: 'Add parent' }));
    expect(await alert()).toHaveTextContent('No student with admission number RSA-9999.');
    expect(accounts).toHaveLength(0);
    expect(doc(`tenants/${T}/students/RSA-2026-0001`)).toMatchObject({ parentIds: [] });
  });
  it('limits how many children can be linked in one save', async () => {
    const u = userEvent.setup();
    mount(<Parents />);
    await fillParent(u, 'A-1, B-2, C-3, D-4, E-5');
    await u.click(screen.getByRole('button', { name: 'Add parent' }));
    expect(await screen.findByText(/at most 4 children/i)).toBeInTheDocument();
    expect(accounts).toHaveLength(0);
  });
  it('editing re-links children: adds, removes, and keeps both sides in sync', async () => {
    kid('RSA-2026-0001', ['p5']); kid('RSA-2026-0002');
    seed(`tenants/${T}/parents/p5`, { tenantId: T, uid: 'p5', name: 'Mr Okafor', phone: '', email: '', loginId: 'parent-abc123', childIds: ['RSA-2026-0001'], status: 'ACTIVE' });
    seed(`tenants/${T}/members/p5`, { uid: 'p5', tenantId: T, role: 'PARENT', status: 'ACTIVE', displayName: 'Mr Okafor', email: '' });
    const u = userEvent.setup();
    mount(<Parents />);
    await u.click(await screen.findByRole('button', { name: 'Edit Mr Okafor' }));
    const box = screen.getByLabelText(/children/i);
    await u.clear(box); await u.type(box, 'RSA-2026-0002');
    await u.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('Mr Okafor');
    expect(doc(`tenants/${T}/students/RSA-2026-0001`)).toMatchObject({ parentIds: [] });
    expect(doc(`tenants/${T}/students/RSA-2026-0002`)).toMatchObject({ parentIds: ['p5'] });
    expect(doc(`tenants/${T}/parents/p5`)).toMatchObject({ childIds: ['RSA-2026-0002'] });
  });
  it('editing rejects a malformed admission number without any write', async () => {
    seed(`tenants/${T}/parents/p5`, { tenantId: T, uid: 'p5', name: 'Mr Okafor', phone: '', email: '', loginId: 'parent-abc123', childIds: [], status: 'ACTIVE' });
    const u = userEvent.setup();
    mount(<Parents />);
    await u.click(await screen.findByRole('button', { name: 'Edit Mr Okafor' }));
    await u.type(screen.getByLabelText(/children/i), 'a/b');
    await u.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/not a valid admission number/i)).toBeInTheDocument();
    expect(writeLog).toHaveLength(0);
  });
  it('deactivating a parent disables their sign-in', async () => {
    seed(`tenants/${T}/parents/p5`, { tenantId: T, uid: 'p5', name: 'Mr Okafor', phone: '', email: '', loginId: 'parent-abc123', childIds: [], status: 'ACTIVE' });
    seed(`tenants/${T}/members/p5`, { uid: 'p5', tenantId: T, role: 'PARENT', status: 'ACTIVE', displayName: 'Mr Okafor', email: '' });
    const u = userEvent.setup();
    mount(<Parents />);
    await u.click(await screen.findByRole('button', { name: 'Deactivate Mr Okafor' }));
    await screen.findByRole('button', { name: 'Activate Mr Okafor' });
    expect(doc(`tenants/${T}/members/p5`)).toMatchObject({ status: 'DISABLED' });
  });
});

// ==================================================================== users
describe('Users', () => {
  beforeEach(() => {
    seed(`tenants/${T}/members/t9`, { uid: 't9', tenantId: T, role: 'TEACHER', status: 'ACTIVE', displayName: 'Mr Odd', email: 'odd@x.com', loginId: 'odd@x.com' });
    seed(`tenants/${T}/members/s9`, { uid: 's9', tenantId: T, role: 'STUDENT', status: 'ACTIVE', displayName: 'Stu Dent', email: '', loginId: 'RSA-2026-0001', mustChangePassword: true });
  });
  it('lists everyone; you cannot act on yourself; resets only offered for real emails', async () => {
    mount(<Users />);
    await screen.findByText('Mr Odd');
    const adminRow = screen.getByText('Ada Admin').closest('tr') as HTMLElement;
    expect(within(adminRow).queryByRole('button', { name: /^(Disable|Enable)$/ })).not.toBeInTheDocument();
    expect(within(adminRow).queryByRole('combobox')).not.toBeInTheDocument(); // cannot change own role
    expect(within(adminRow).getByText('SCHOOL ADMIN')).toBeInTheDocument();
    // real emails (admin, teacher) get a reset button; the username-only student does not
    expect(screen.getAllByRole('button', { name: 'Send password reset' })).toHaveLength(2);
    expect(screen.getByText('new')).toBeInTheDocument();
  });
  it('disables and re-enables another user, with an audit entry', async () => {
    const u = userEvent.setup();
    mount(<Users />);
    const row = (await screen.findByText('Mr Odd')).closest('tr') as HTMLElement;
    await u.click(within(row).getByRole('button', { name: 'Disable' }));
    await within(row).findByRole('button', { name: 'Enable' });
    expect(doc(`tenants/${T}/members/t9`)).toMatchObject({ status: 'DISABLED' });
    expect(allWrites().some((o) => (o.data as { action?: string }).action === 'user.disabled')).toBe(true);
    await u.click(within(row).getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(doc(`tenants/${T}/members/t9`)).toMatchObject({ status: 'ACTIVE' }));
  });
  it('changes a role', async () => {
    const u = userEvent.setup();
    mount(<Users />);
    await u.selectOptions(await screen.findByLabelText('Role for Mr Odd'), 'STAFF');
    await waitFor(() => expect(doc(`tenants/${T}/members/t9`)).toMatchObject({ role: 'STAFF' }));
  });
});

// ================================================================ settings
describe('Settings', () => {
  it('saves school profile to the tenant AND the public login page, and remembers the old session', async () => {
    const u = userEvent.setup();
    mount(<Settings />);
    const name = await screen.findByLabelText('School name');
    await u.clear(name); await u.type(name, 'Royal Scholars College');
    const session = screen.getByLabelText('Current academic session');
    await u.clear(session); await u.type(session, '2027/2028');
    await u.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByText('Settings saved.');
    expect(doc(`tenants/${T}`)).toMatchObject({ name: 'Royal Scholars College' });
    const settings = doc(`tenants/${T}`)!.settings as { academicSession: string; pastSessions: string[]; admissionPrefix: string; terms: string[] };
    expect(settings).toMatchObject({ academicSession: '2027/2028', pastSessions: ['2026/2027'], admissionPrefix: 'RSA', terms: ['Term 1'] });
    expect(doc(`publicProfiles/${T}`)).toMatchObject({ name: 'Royal Scholars College', slug: 'royal' });
    expect(h.auth.refresh).toHaveBeenCalled();
  });
  it('rejects an invalid timezone', async () => {
    const u = userEvent.setup();
    mount(<Settings />);
    const tz = await screen.findByLabelText('Timezone');
    await u.clear(tz); await u.type(tz, 'Mars/Olympus');
    await u.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await alert()).toHaveTextContent(/valid timezone/i);
    expect(writeLog).toHaveLength(0);
  });
  it('validates before saving (prefix, grading) and writes nothing', async () => {
    const u = userEvent.setup();
    mount(<Settings />);
    const prefix = await screen.findByLabelText('Admission number prefix');
    await u.clear(prefix); await u.type(prefix, 'x');
    await u.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await alert()).toHaveTextContent(/prefix must be 2-6/i);
    await u.clear(prefix); await u.type(prefix, 'ROY');
    await u.click(screen.getAllByRole('button', { name: /remove grade/i })[0]!);
    await u.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await alert()).toHaveTextContent(/band must end at 100/i);
    expect(writeLog).toHaveLength(0);
  });
});

// ================================================================= import
const csvFile = (text: string, name = 'data.csv') => new File([text], name, { type: 'text/csv' });
const upload = (u: ReturnType<typeof userEvent.setup>, text: string) => u.upload(screen.getByLabelText(/choose your csv file/i), csvFile(text));
const previewText = (re: RegExp) => screen.findByText((_, el) => el?.tagName === 'P' && re.test(el.textContent ?? ''));
const SH = 'firstName,lastName,gender,dateOfBirth,className,admissionNumber\n';
describe('Import', () => {
  it('previews valid/invalid rows, imports only valid ones, numbers them from the counter', async () => {
    const u = userEvent.setup();
    mount(<ImportPage />);
    await upload(u, SH + 'Ada,Okafor,FEMALE,2014-05-21,JSS 1,\nBola,Ade,MALE,2013-01-02,jss 2,\nBad,Row,MALE,2013-02-30,JSS 1,\nCy,Dee,MALE,2013-01-01,Nope,');
    await previewText(/2\s*valid.*2\s*with errors/);
    expect(screen.getByText(/dateOfBirth must be a real past date/)).toBeInTheDocument();
    expect(screen.getByText(/Class "Nope" does not exist/)).toBeInTheDocument();
    expect(writeLog).toHaveLength(0); // nothing saved before confirmation
    await u.click(screen.getByRole('button', { name: 'Import 2 valid records' }));
    await screen.findByText(/Imported 2 records/);
    expect(doc(`tenants/${T}/students/RSA-${YEAR}-0001`)).toMatchObject({ firstName: 'Ada', classId: 'jss-1' });
    expect(doc(`tenants/${T}/students/RSA-${YEAR}-0002`)).toMatchObject({ firstName: 'Bola', classId: 'jss-2' });
    expect(doc(`tenants/${T}/counters/students-${YEAR}`)).toEqual({ next: 3 });
    expect(allWrites().some((o) => (o.data as { action?: string }).action === 'students.imported')).toBe(true);
  });
  it('flags custom admission numbers that already exist', async () => {
    seed(`tenants/${T}/students/OLD-1`, student('OLD-1'));
    const u = userEvent.setup();
    mount(<ImportPage />);
    await upload(u, SH + 'Ada,Okafor,FEMALE,2014-05-21,JSS 1,old-1\nBo,Ade,MALE,2013-01-02,JSS 1,NEW-1');
    await previewText(/1\s*valid.*1\s*with errors/);
    expect(screen.getByText(/already exists/)).toBeInTheDocument();
  });
  it('reports per-row failures when one batch fails, and still saves the others', async () => {
    const rows = Array.from({ length: 20 }, (_, i) => `S${i},Test,MALE,2013-01-01,JSS 1,`).join('\n');
    hooks.failBatch = (_ops, index) => (index === 1 ? { code: 'permission-denied' } : null);
    const u = userEvent.setup();
    mount(<ImportPage />);
    await upload(u, SH + rows);
    await u.click(await screen.findByRole('button', { name: 'Import 20 valid records' }));
    await screen.findByText(/Imported 12 records/);
    expect(screen.getByText(/8 could not be saved/)).toBeInTheDocument();
    expect(screen.getByText(/Line 10:/)).toBeInTheDocument();
    expect(screen.getByText(/Line 17:/)).toBeInTheDocument();
    expect(writeLog.slice(0, 3).every((b) => b.length <= 8)).toBe(true);
  });
  it('blocks files with missing required columns', async () => {
    const u = userEvent.setup();
    mount(<ImportPage />);
    await upload(u, 'firstName,lastName\nA,B');
    expect(await screen.findByText(/Missing required column "gender"/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Import \d/ })).not.toBeInTheDocument();
  });
  it('imports teachers: creates accounts, mirrors assignments, shows credentials once', async () => {
    const u = userEvent.setup();
    mount(<ImportPage />);
    await u.selectOptions(screen.getByLabelText('Type'), 'teachers');
    await upload(u, 'name,email,phone,subjects,classes\nMrs Bello,bello@x.com,,Mathematics;English,JSS 1\nMr Taken,bad,,,\nMr Odd,odd@x.com,,Chemistry,');
    await previewText(/1\s*valid.*2\s*with errors/);
    await u.click(screen.getByRole('button', { name: 'Import 1 valid record' }));
    await screen.findByText(/Imported 1 record\./);
    expect(accounts.map((a) => a.email)).toEqual(['bello@x.com']);
    expect(doc(`tenants/${T}/teachers/uid-1`)).toMatchObject({ name: 'Mrs Bello', subjects: ['maths', 'english'], classes: ['jss-1'] });
    expect(doc(`tenants/${T}/members/uid-1`)).toMatchObject({ role: 'TEACHER', classIds: ['jss-1'], mustChangePassword: true });
    expect(screen.getByText(accounts[0]!.password)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download logins as CSV' })).toBeInTheDocument();
  });
  it('teacher import continues past a failed account and reports it', async () => {
    seed(`tenants/${T}/teachers/old`, { tenantId: T, name: 'Existing', email: 'dupe@x.com', status: 'ACTIVE' });
    const u = userEvent.setup();
    mount(<ImportPage />);
    await u.selectOptions(screen.getByLabelText('Type'), 'teachers');
    await upload(u, 'name,email\nA One,a@x.com\nB Two,dupe@x.com\nC Three,c@x.com');
    await previewText(/2\s*valid.*1\s*with errors/);
    expect(screen.getByText(/already used/)).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Import 2 valid records' }));
    await screen.findByText(/Imported 2 records/);
    expect(accounts.map((a) => a.email)).toEqual(['a@x.com', 'c@x.com']);
  });
  it('imports classes and subjects, skipping duplicates and continuing the order', async () => {
    const u = userEvent.setup();
    mount(<ImportPage />);
    await u.selectOptions(screen.getByLabelText('Type'), 'classes');
    await upload(u, 'name\nJSS 1\nSS 1\nSS 2\nss 1');
    await previewText(/2\s*valid.*2\s*with errors/);
    await u.click(screen.getByRole('button', { name: 'Import 2 valid records' }));
    await screen.findByText(/Imported 2 records/);
    expect(doc(`tenants/${T}/classes/ss-1`)).toMatchObject({ name: 'SS 1', order: 2, status: 'ACTIVE' });
    expect(doc(`tenants/${T}/classes/ss-2`)).toMatchObject({ name: 'SS 2', order: 3 });
  });
  it('offers a template download for each type', async () => {
    const created: Blob[] = [];
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b) => { created.push(b); return 'blob:x'; };
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => undefined;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const u = userEvent.setup();
    mount(<ImportPage />);
    await u.click(screen.getByRole('button', { name: 'Download template' }));
    expect(created).toHaveLength(1);
    const text = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsText(created[0] as Blob); });
    expect(text).toContain('firstName,lastName,gender,dateOfBirth,className');
  });
});

// ======================================================= teacher scoping UI
describe('My classes (teacher)', () => {
  it('shows only the teacher\'s assigned classes and only active students', async () => {
    seed(`tenants/${T}/students/A-1`, student('A-1', { firstName: 'InClass', classId: 'jss-1' }));
    seed(`tenants/${T}/students/A-2`, student('A-2', { firstName: 'Gone', classId: 'jss-1', status: 'INACTIVE' }));
    seed(`tenants/${T}/students/B-1`, student('B-1', { firstName: 'OtherClass', classId: 'jss-2' }));
    mount(<MyClasses />, 'TEACHER', { uid: 'admin1', classIds: ['jss-1'] });
    await screen.findByText('InClass Okafor');
    expect(screen.queryByText('Gone Okafor')).not.toBeInTheDocument();
    expect(screen.queryByText('OtherClass Okafor')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'JSS 2' })).not.toBeInTheDocument();
  });
  it('explains when nothing is assigned', async () => {
    mount(<MyClasses />, 'TEACHER', { classIds: [] });
    expect(await screen.findByText(/not been assigned to any class/i)).toBeInTheDocument();
  });
});

// =========================================================== change password
describe('Change password (first sign-in)', () => {
  const show = () => render(<MemoryRouter><ChangePassword /></MemoryRouter>);
  it('validates length and match, then updates the password and clears the flag', async () => {
    seed(`tenants/${T}/members/admin1`, { uid: 'admin1', tenantId: T, role: 'TEACHER', status: 'ACTIVE', displayName: 'X', email: 'x', mustChangePassword: true });
    h.updatePassword.mockResolvedValue(undefined);
    const u = userEvent.setup();
    show();
    await u.type(screen.getByLabelText('New password'), 'short');
    await u.type(screen.getByLabelText('Repeat new password'), 'short');
    await u.click(screen.getByRole('button', { name: 'Save password' }));
    expect(await alert()).toHaveTextContent('at least 8 characters');
    await u.clear(screen.getByLabelText('New password')); await u.clear(screen.getByLabelText('Repeat new password'));
    await u.type(screen.getByLabelText('New password'), 'LongEnough1');
    await u.type(screen.getByLabelText('Repeat new password'), 'Different22');
    await u.click(screen.getByRole('button', { name: 'Save password' }));
    expect(await alert()).toHaveTextContent('do not match');
    expect(h.updatePassword).not.toHaveBeenCalled();
    await u.clear(screen.getByLabelText('Repeat new password')); await u.type(screen.getByLabelText('Repeat new password'), 'LongEnough1');
    await u.click(screen.getByRole('button', { name: 'Save password' }));
    await waitFor(() => expect(h.auth.refresh).toHaveBeenCalled());
    expect(h.updatePassword.mock.calls[0]![1]).toBe('LongEnough1');
    expect(doc(`tenants/${T}/members/admin1`)).toMatchObject({ mustChangePassword: false });
  });
  it('does not clear the flag if the password change fails', async () => {
    seed(`tenants/${T}/members/admin1`, { uid: 'admin1', tenantId: T, role: 'TEACHER', status: 'ACTIVE', displayName: 'X', email: 'x', mustChangePassword: true });
    h.updatePassword.mockRejectedValue({ code: 'auth/requires-recent-login' });
    const u = userEvent.setup();
    show();
    await u.type(screen.getByLabelText('New password'), 'LongEnough1');
    await u.type(screen.getByLabelText('Repeat new password'), 'LongEnough1');
    await u.click(screen.getByRole('button', { name: 'Save password' }));
    expect(await alert()).toHaveTextContent('sign in again');
    expect(doc(`tenants/${T}/members/admin1`)).toMatchObject({ mustChangePassword: true });
  });
});
