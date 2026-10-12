// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { generateLicenseKey } from './lib-license';
import type { Op } from './lib-ops';

const getDocMock = vi.fn();
const applyOpsMock = vi.fn<(db: unknown, ops: Op[]) => Promise<void>>();
const user = { uid: 'u1', email: 'head@school.test', displayName: null };

vi.mock('firebase/firestore', async (orig) => {
  const real = await orig<typeof import('firebase/firestore')>();
  return { ...real, getDoc: (...a: unknown[]) => getDocMock(...a), doc: (_d: unknown, p: string) => ({ path: p }) };
});
vi.mock('./lib-ops', async (orig) => {
  const real = await orig<typeof import('./lib-ops')>();
  return { ...real, applyOps: (db: unknown, ops: Op[]) => applyOpsMock(db, ops) };
});
vi.mock('./lib-firebase', () => ({ isConfigured: true, firebase: () => ({ db: {}, auth: { currentUser: user } }) }));
const authStub = {
  status: 'ready', user, tenantId: null as string | null, member: null, tenant: null, isPlatformAdmin: false,
  refresh: vi.fn().mockResolvedValue(undefined), signIn: vi.fn(), signOut: vi.fn(),
};
vi.mock('./ctx-auth', () => ({ useAuth: () => authStub }));
import Onboarding from './page-onboarding';

const snap = (d: Record<string, unknown> | null) => ({ exists: () => d !== null, data: () => d });
const UNUSED = { status: 'UNUSED', plan: 'standard', tenantId: null, expiresAt: null };

async function walkToReview(u: ReturnType<typeof userEvent.setup>) {
  await u.type(screen.getByLabelText(/license key/i), generateLicenseKey());
  await u.click(screen.getByRole('button', { name: /verify key/i }));
  await u.click(await screen.findByRole('button', { name: /continue as this administrator/i }));
  await u.type(await screen.findByLabelText(/school name/i), 'Royal Scholars Academy');
  expect(screen.getByLabelText(/school address/i)).toHaveValue('royal-scholars-academy');
  await u.click(screen.getByRole('button', { name: /^continue$/i }));
  await u.click(await screen.findByRole('button', { name: /^review$/i }));
  await screen.findByText(/review and activate/i);
}
const renderWizard = () => render(
  <MemoryRouter initialEntries={['/activate']}>
    <Routes><Route path="/activate" element={<Onboarding />} /><Route path="/app" element={<p>DASHBOARD</p>} /></Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  cleanup(); getDocMock.mockReset(); applyOpsMock.mockReset(); authStub.refresh.mockClear();
  authStub.tenantId = null; localStorage.clear();
});

describe('onboarding wizard end-to-end (mocked Firebase)', () => {
  it('activates: atomic core batch first, then config batches, then lands on the dashboard', async () => {
    getDocMock.mockImplementation(async (ref: { path: string }) =>
      ref.path.startsWith('licenses/') ? snap(UNUSED) : snap(null)); // slug is free
    applyOpsMock.mockResolvedValue(undefined);
    const u = userEvent.setup();
    renderWizard();
    await walkToReview(u);
    await u.click(screen.getByRole('button', { name: /activate & create school/i }));
    expect(await screen.findByText('DASHBOARD')).toBeInTheDocument();

    const first = applyOpsMock.mock.calls[0]![1];
    expect(first.some((o) => o.path.startsWith('licenses/') && o.data.status === 'ACTIVE' && o.data.activationCount === 1)).toBe(true);
    expect(first.some((o) => o.path === `userDirectory/u1`)).toBe(true);
    expect(first.some((o) => o.path.endsWith('/members/u1') && o.data.role === 'SCHOOL_ADMIN')).toBe(true);
    expect(first.some((o) => o.path === 'slugs/royal-scholars-academy')).toBe(true);
    expect(applyOpsMock.mock.calls.length).toBeGreaterThan(2);
    for (const [, ops] of applyOpsMock.mock.calls.slice(1)) expect(ops.length).toBeLessThanOrEqual(9);
    expect(authStub.refresh).toHaveBeenCalled();
  });

  it('race: key taken by someone else just before commit -> "already been activated"', async () => {
    let calls = 0;
    getDocMock.mockImplementation(async (ref: { path: string }) => {
      if (!ref.path.startsWith('licenses/')) return snap(null);
      return snap(++calls === 1 ? UNUSED : { ...UNUSED, status: 'ACTIVE', tenantId: 'other' });
    });
    applyOpsMock.mockRejectedValue({ code: 'permission-denied' });
    const u = userEvent.setup();
    renderWizard();
    await walkToReview(u);
    await u.click(screen.getByRole('button', { name: /activate & create school/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This license key has already been activated.');
    expect(screen.queryByText('DASHBOARD')).not.toBeInTheDocument();
  });

  it('a generic core failure shows a friendly message and allows retry from the start', async () => {
    getDocMock.mockImplementation(async (ref: { path: string }) => (ref.path.startsWith('licenses/') ? snap(UNUSED) : snap(null)));
    applyOpsMock.mockRejectedValueOnce({ code: 'unavailable' });
    const u = userEvent.setup();
    renderWizard();
    await walkToReview(u);
    await u.click(screen.getByRole('button', { name: /activate & create school/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/temporarily unavailable/i);
    applyOpsMock.mockResolvedValue(undefined);
    await u.click(screen.getByRole('button', { name: /activate & create school/i }));
    expect(await screen.findByText('DASHBOARD')).toBeInTheDocument();
  });

  it('config failure after activation offers Resume and continues from the failed batch only', async () => {
    getDocMock.mockImplementation(async (ref: { path: string }) => (ref.path.startsWith('licenses/') ? snap(UNUSED) : snap(null)));
    applyOpsMock.mockResolvedValueOnce(undefined)                  // core ok
      .mockResolvedValueOnce(undefined)                            // config[0] ok
      .mockRejectedValueOnce({ code: 'unavailable' });             // config[1] fails
    const u = userEvent.setup();
    renderWizard();
    await walkToReview(u);
    await u.click(screen.getByRole('button', { name: /activate & create school/i }));
    const resume = await screen.findByRole('button', { name: /resume setup/i });
    expect(screen.queryByRole('button', { name: /activate & create school/i })).not.toBeInTheDocument();
    const callsBefore = applyOpsMock.mock.calls.length; // 3
    applyOpsMock.mockResolvedValue(undefined);
    await u.click(resume);
    await screen.findByText('DASHBOARD');
    const firstRetryOps = applyOpsMock.mock.calls[callsBefore]![1];
    expect(firstRetryOps).toEqual(applyOpsMock.mock.calls[2]![1]); // same batch retried, nothing re-run before it
    expect(applyOpsMock.mock.calls.filter(([, o]) => o.some((x) => x.path.startsWith('licenses/') && x.kind === 'update' && x.data.status === 'ACTIVE')).length).toBe(1); // core never re-run
  });

  it('refuses a taken school address', async () => {
    getDocMock.mockImplementation(async (ref: { path: string }) =>
      ref.path.startsWith('licenses/') ? snap(UNUSED) : ref.path.startsWith('slugs/') ? snap({ tenantId: 'x' }) : snap(null));
    const u = userEvent.setup();
    renderWizard();
    await u.type(screen.getByLabelText(/license key/i), generateLicenseKey());
    await u.click(screen.getByRole('button', { name: /verify key/i }));
    await u.click(await screen.findByRole('button', { name: /continue as this administrator/i }));
    await u.type(await screen.findByLabelText(/school name/i), 'Taken School');
    await u.click(screen.getByRole('button', { name: /^continue$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already in use/i);
  });

  it('blocks an account that already belongs to a school', async () => {
    authStub.tenantId = 'existing';
    getDocMock.mockResolvedValue(snap(UNUSED));
    const u = userEvent.setup();
    renderWizard();
    await u.type(screen.getByLabelText(/license key/i), generateLicenseKey());
    await u.click(screen.getByRole('button', { name: /verify key/i }));
    await u.click(await screen.findByRole('button', { name: /continue as this administrator/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already belongs to a school/i);
    await waitFor(() => expect(applyOpsMock).not.toHaveBeenCalled());
  });

  it('rejects invalid grading before activation', async () => {
    getDocMock.mockImplementation(async (ref: { path: string }) => (ref.path.startsWith('licenses/') ? snap(UNUSED) : snap(null)));
    const u = userEvent.setup();
    renderWizard();
    await u.type(screen.getByLabelText(/license key/i), generateLicenseKey());
    await u.click(screen.getByRole('button', { name: /verify key/i }));
    await u.click(await screen.findByRole('button', { name: /continue as this administrator/i }));
    await u.type(await screen.findByLabelText(/school name/i), 'Grading Test');
    await u.click(screen.getByRole('button', { name: /^continue$/i }));
    await screen.findByText(/academic setup/i);
    await u.click(screen.getAllByRole('button', { name: /remove grade/i })[0]!); // leaves a gap at the top
    await u.click(screen.getByRole('button', { name: /^review$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/highest band must end at 100/i);
  });
});
