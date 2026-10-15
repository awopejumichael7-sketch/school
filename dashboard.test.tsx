// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('firebase/firestore', async (orig) => {
  const real = await orig<typeof import('firebase/firestore')>();
  return {
    ...real,
    doc: (_d: unknown, p: string) => ({ path: p }),
    collection: (_d: unknown, p: string) => ({ path: p }),
    query: (c: unknown) => c,
    orderBy: () => ({}),
    limit: () => ({}),
    getDoc: async () => ({ exists: () => false, data: () => null }),
    getDocs: async () => ({ docs: [] }),
  };
});
vi.mock('./lib-firebase', () => ({ isConfigured: true, firebase: () => ({ db: {}, auth: {} }) }));
const base = { status: 'ready', user: { uid: 'u1', email: 'a@b.c' }, tenantId: 't1', isPlatformAdmin: false,
  refresh: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
let stub: Record<string, unknown> = base;
vi.mock('./ctx-auth', () => ({ useAuth: () => stub }));
import Dashboard from './page-dashboard';
import { Timestamp } from 'firebase/firestore';

const tenant = (over: Record<string, unknown> = {}) => ({
  name: 'Royal Scholars', status: 'ACTIVE', plan: 'standard', expiresAt: null, setupComplete: true,
  profile: { footer: '' }, settings: { academicSession: '2026/2027', terms: ['T1'], currency: 'NGN', timezone: 'Africa/Lagos' }, ...over,
});
const member = (over: Record<string, unknown> = {}) => ({ role: 'SCHOOL_ADMIN', status: 'ACTIVE', displayName: 'Ada', ...over });
const show = (path = '/app') => render(<MemoryRouter initialEntries={[path]}><Routes>
  <Route path="/app/*" element={<Dashboard />} /><Route path="/" element={<p>LANDING</p>} /></Routes></MemoryRouter>);

beforeEach(() => cleanup());

describe('dashboard states', () => {
  it('does not redirect-loop when the school record failed to load', () => {
    stub = { ...base, member: member(), tenant: null };
    show();
    expect(screen.getByText(/couldn't load your school/i)).toBeInTheDocument();
    expect(screen.queryByText('LANDING')).not.toBeInTheDocument();
  });
  it('shows a disabled-account screen', () => {
    stub = { ...base, member: member({ status: 'DISABLED' }), tenant: null };
    show();
    expect(screen.getByText(/account disabled/i)).toBeInTheDocument();
  });
  it('shows suspended access for a suspended license, with restore link for admins only', () => {
    stub = { ...base, member: member(), tenant: tenant({ status: 'SUSPENDED' }) };
    show();
    expect(screen.getByText(/access suspended/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /restore it with your license key/i })).toBeInTheDocument();
    cleanup();
    stub = { ...base, member: member({ role: 'TEACHER' }), tenant: tenant({ status: 'SUSPENDED' }) };
    show();
    expect(screen.queryByRole('link', { name: /restore/i })).not.toBeInTheDocument();
  });
  it('treats an expired license as suspended', () => {
    stub = { ...base, member: member(), tenant: tenant({ expiresAt: Timestamp.fromDate(new Date(Date.now() - 1000)) }) };
    show();
    expect(screen.getByText(/access suspended/i)).toBeInTheDocument();
  });
  it('renders the active overview and marks future modules as unavailable', async () => {
    stub = { ...base, member: member(), tenant: tenant() };
    show();
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(await screen.findByText('2026/2027')).toBeInTheDocument();
    expect(screen.getAllByTitle(/planned: phase/i).length).toBeGreaterThan(5);
  });
  it('signed-out users are sent to the landing page', () => {
    stub = { ...base, user: null, tenantId: null, member: null, tenant: null };
    show();
    expect(screen.getByText('LANDING')).toBeInTheDocument();
  });

  it('school admin sees every management screen', async () => {
    stub = { ...base, member: member(), tenant: tenant() };
    show();
    await screen.findByRole('heading', { name: 'Overview' });
    for (const l of ['Academics', 'Students', 'Teachers', 'Parents', 'Attendance', 'Fees', 'Users', 'Import', 'Settings']) {
      expect(screen.getAllByRole('link', { name: l }).length).toBeGreaterThan(0);
    }
    expect(screen.queryByRole('link', { name: 'My classes' })).not.toBeInTheDocument();
    expect(screen.getByText('standard')).toBeInTheDocument(); // admins see the license card
  });
  it('license details are hidden from non-admins', async () => {
    stub = { ...base, member: member({ role: 'TEACHER', classIds: [] }), tenant: tenant() };
    show();
    await screen.findByRole('heading', { name: 'Overview' });
    expect(screen.queryByText('License')).not.toBeInTheDocument();
    expect(screen.queryByText('standard')).not.toBeInTheDocument();
    expect(await screen.findByText('2026/2027')).toBeInTheDocument();
  });
  it('a teacher only sees Overview and My classes, and cannot open admin URLs directly', async () => {
    stub = { ...base, member: member({ role: 'TEACHER', classIds: [] }), tenant: tenant() };
    show('/app/users');
    expect(await screen.findByText(/don't have permission to view this page/i)).toBeInTheDocument();
    const names = screen.getAllByRole('link').map((a) => a.textContent);
    expect(new Set(names)).toEqual(new Set(['Overview', 'Attendance', 'My classes']));
    cleanup();
    for (const path of ['/app/settings', '/app/import', '/app/teachers', '/app/students', '/app/parents', '/app/academics', '/app/fees']) {
      show(path);
      expect(await screen.findByText(/don't have permission/i)).toBeInTheDocument();
      cleanup();
    }
  });
  it('students and parents only get the overview', async () => {
    for (const role of ['STUDENT', 'PARENT']) {
      stub = { ...base, member: member({ role }), tenant: tenant() };
      show('/app/students');
      expect(await screen.findByText(/don't have permission/i)).toBeInTheDocument();
      expect(new Set(screen.getAllByRole('link').map((a) => a.textContent))).toEqual(new Set(['Overview']));
      cleanup();
    }
  });
  it('a principal can read students, teachers, attendance and fees but not manage users or settings', async () => {
    stub = { ...base, member: member({ role: 'PRINCIPAL' }), tenant: tenant() };
    show();
    await screen.findByRole('heading', { name: 'Overview' });
    expect(new Set(screen.getAllByRole('link').map((a) => a.textContent))).toEqual(new Set(['Overview', 'Academics', 'Students', 'Teachers', 'Attendance', 'Fees']));
  });
  it('accounts on a temporary password see only the change-password screen (no navigation)', async () => {
    stub = { ...base, member: member({ role: 'TEACHER', mustChangePassword: true }), tenant: tenant() };
    show();
    expect(await screen.findByRole('heading', { name: 'Choose a new password' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'My classes' })).not.toBeInTheDocument();
  });

  it('an accountant sees Students and Fees only; staff see Students, Teachers and Attendance', async () => {
    stub = { ...base, member: member({ role: 'ACCOUNTANT' }), tenant: tenant() };
    show('/app/attendance');
    expect(await screen.findByText(/don't have permission/i)).toBeInTheDocument();   // accountants do not see attendance
    expect(new Set(screen.getAllByRole('link').map((a) => a.textContent))).toEqual(new Set(['Overview', 'Students', 'Fees']));
    cleanup();
    stub = { ...base, member: member({ role: 'STAFF' }), tenant: tenant() };
    show('/app/fees');
    expect(await screen.findByText(/don't have permission/i)).toBeInTheDocument();    // staff do not see fees
    expect(new Set(screen.getAllByRole('link').map((a) => a.textContent))).toEqual(new Set(['Overview', 'Students', 'Teachers', 'Attendance']));
  });
});
