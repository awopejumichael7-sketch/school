// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Timestamp } from 'firebase/firestore';
import { generateLicenseKey, hashLicenseKey } from './lib-license';

const getDocMock = vi.fn();

vi.mock('firebase/firestore', async (orig) => {
  const real = await orig<typeof import('firebase/firestore')>();
  return { ...real, getDoc: (...a: unknown[]) => getDocMock(...a), doc: (_db: unknown, path: string) => ({ path }) };
});
vi.mock('./lib-firebase', () => ({
  isConfigured: true,
  firebase: () => ({ db: {}, auth: { currentUser: null } }),
}));
const authStub = { status: 'signedOut', user: null, tenantId: null, member: null, tenant: null, isPlatformAdmin: false,
  refresh: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
vi.mock('./ctx-auth', () => ({ useAuth: () => authStub }));

import Onboarding from './page-onboarding';
import { Field, Alert } from './ui';
import { toDateInput } from './ui';
import { lockoutMs, FREE_ATTEMPTS, MAX_LOCKOUT_MS, recordFailure, secondsLocked, recordSuccess } from './lib-throttle';

const snap = (data: Record<string, unknown> | null) => ({ exists: () => data !== null, data: () => data });
async function submitKey(key: string) {
  const user = userEvent.setup();
  render(<MemoryRouter><Onboarding /></MemoryRouter>);
  await user.type(screen.getByLabelText(/license key/i), key);
  await user.click(screen.getByRole('button', { name: /verify key/i }));
}

beforeEach(() => { cleanup(); getDocMock.mockReset(); localStorage.clear(); });

describe('license verification screen', () => {
  it('rejects malformed keys without touching the database', async () => {
    await submitKey('hello');
    expect(await screen.findByRole('alert')).toHaveTextContent(/does not look like a valid license key/i);
    expect(getDocMock).not.toHaveBeenCalled();
  });

  it('shows a generic message for unknown keys', async () => {
    getDocMock.mockResolvedValue(snap(null));
    await submitKey(generateLicenseKey());
    expect(await screen.findByRole('alert')).toHaveTextContent('This license key is not valid.');
  });

  it('shows the required message for an already-activated key', async () => {
    getDocMock.mockResolvedValue(snap({ status: 'ACTIVE', plan: 'standard', tenantId: 't1', expiresAt: null }));
    await submitKey(generateLicenseKey());
    expect(await screen.findByRole('alert')).toHaveTextContent('This license key has already been activated.');
  });

  it('handles deactivated and expired keys', async () => {
    getDocMock.mockResolvedValue(snap({ status: 'DEACTIVATED', plan: 'p', tenantId: null, expiresAt: null }));
    await submitKey(generateLicenseKey());
    expect(await screen.findByRole('alert')).toHaveTextContent(/deactivated/i);
    cleanup();
    getDocMock.mockResolvedValue(snap({ status: 'UNUSED', plan: 'p', tenantId: null, expiresAt: Timestamp.fromDate(new Date(Date.now() - 86400000)) }));
    await submitKey(generateLicenseKey());
    expect(await screen.findByRole('alert')).toHaveTextContent(/expired/i);
  });

  it('looks the license up by its HASH, never the raw key', async () => {
    const key = generateLicenseKey();
    getDocMock.mockResolvedValue(snap(null));
    await submitKey(key.toLowerCase().replace(/-/g, ' '));
    await screen.findByRole('alert');
    const hash = await hashLicenseKey(key);
    expect(getDocMock).toHaveBeenCalledWith({ path: `licenses/${hash}` });
    expect(JSON.stringify(getDocMock.mock.calls)).not.toContain(key);
  });

  it('advances to the administrator step for a valid unused key', async () => {
    getDocMock.mockResolvedValue(snap({ status: 'UNUSED', plan: 'premium', tenantId: null, expiresAt: null }));
    await submitKey(generateLicenseKey());
    expect(await screen.findByText(/create the first administrator/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/administrator name/i)).toBeInTheDocument();
  });

  it('sends reset licenses to the restore flow (same school only)', async () => {
    getDocMock.mockResolvedValue(snap({ status: 'RESET', plan: 'p', tenantId: 't1', expiresAt: null }));
    await submitKey(generateLicenseKey());
    expect(await screen.findByText(/restore your school/i)).toBeInTheDocument();
  });

  it('locks out after repeated failures (client-side backoff)', async () => {
    getDocMock.mockResolvedValue(snap(null));
    const user = userEvent.setup();
    render(<MemoryRouter><Onboarding /></MemoryRouter>);
    for (let i = 0; i < FREE_ATTEMPTS; i++) {
      await user.clear(screen.getByLabelText(/license key/i));
      await user.type(screen.getByLabelText(/license key/i), generateLicenseKey());
      await user.click(screen.getByRole('button', { name: /verify key/i }));
      await waitFor(() => expect(getDocMock).toHaveBeenCalledTimes(i + 1));
    }
    await user.clear(screen.getByLabelText(/license key/i));
    await user.type(screen.getByLabelText(/license key/i), generateLicenseKey());
    await user.click(screen.getByRole('button', { name: /verify key/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/too many attempts/i);
    expect(getDocMock).toHaveBeenCalledTimes(FREE_ATTEMPTS);
  });

  it('never shows raw technical errors', async () => {
    getDocMock.mockRejectedValue({ code: 'permission-denied', message: 'FirebaseError: PERMISSION_DENIED: Missing or insufficient permissions' });
    await submitKey(generateLicenseKey());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toMatch(/firebase|PERMISSION_DENIED/i);
  });
});

describe('accessibility primitives', () => {
  it('Field associates label, input and error text', () => {
    render(<Field label="Email" error="Bad email" />);
    const input = screen.getByLabelText('Email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText('Bad email')).toBeInTheDocument();
  });
  it('error alerts use role=alert', () => {
    render(<Alert>oops</Alert>);
    expect(screen.getByRole('alert')).toHaveTextContent('oops');
  });
});

describe('helpers', () => {
  it('toDateInput uses the local calendar day', () => {
    expect(toDateInput(new Date(2026, 11, 5, 23, 59, 59))).toBe('2026-12-05');
  });
  it('lockout grows then caps', () => {
    expect(lockoutMs(FREE_ATTEMPTS - 1)).toBe(0);
    expect(lockoutMs(FREE_ATTEMPTS)).toBe(30_000);
    expect(lockoutMs(FREE_ATTEMPTS + 1)).toBe(60_000);
    expect(lockoutMs(99)).toBe(MAX_LOCKOUT_MS);
  });
  it('lockout is stored, expires, and clears on success', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < FREE_ATTEMPTS; i++) recordFailure(t0);
    expect(secondsLocked(t0 + 1000)).toBe(29);
    expect(secondsLocked(t0 + 31_000)).toBe(0);
    recordSuccess();
    expect(secondsLocked(t0)).toBe(0);
  });
});
