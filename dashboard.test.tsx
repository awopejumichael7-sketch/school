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
const show = () => render(<MemoryRouter initialEntries={['/app']}><Routes>
  <Route path="/app" element={<Dashboard />} /><Route path="/" element={<p>LANDING</p>} /></Routes></MemoryRouter>);

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
  it('renders the active overview and marks future modules as unavailable', () => {
    stub = { ...base, member: member(), tenant: tenant() };
    show();
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getByText('2026/2027')).toBeInTheDocument();
    expect(screen.getAllByTitle(/planned: phase/i).length).toBeGreaterThan(5);
  });
  it('signed-out users are sent to the landing page', () => {
    stub = { ...base, user: null, tenantId: null, member: null, tenant: null };
    show();
    expect(screen.getByText('LANDING')).toBeInTheDocument();
  });
});
