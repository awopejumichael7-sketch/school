// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const h = vi.hoisted(() => ({
  reset: vi.fn(),
  auth: { status: 'signedOut', user: null, tenantId: null, member: null, tenant: null, isPlatformAdmin: false,
    refresh: vi.fn(), signIn: vi.fn(), signOut: vi.fn() },
}));
vi.mock('firebase/firestore', async (orig) => (await import('./test-store')).firestoreMock(await orig()));
vi.mock('firebase/auth', async (orig) => ({ ...(await orig<typeof import('firebase/auth')>()), sendPasswordResetEmail: h.reset }));
vi.mock('./lib-firebase', async () => (await import('./test-store')).fakeFirebase());
vi.mock('./ctx-auth', () => ({ useAuth: () => h.auth }));
import SchoolLogin from './page-login';
import { resetStore, seed } from './test-store';

const show = (slug = 'royal') => render(<MemoryRouter initialEntries={[`/s/${slug}`]}><Routes>
  <Route path="/s/:slug" element={<SchoolLogin />} /><Route path="/app" element={<p>DASH</p>} /></Routes></MemoryRouter>);

beforeEach(() => {
  cleanup(); resetStore(); h.reset.mockReset(); h.auth.signIn.mockReset();
  seed('slugs/royal', { tenantId: 't1' });
  seed('publicProfiles/t1', { tenantId: 't1', slug: 'royal', name: 'Royal Scholars', motto: 'Lead', logoDataUrl: null, primaryColor: '#112233', secondaryColor: '#445566' });
});

describe('school login', () => {
  it('shows the school branding, and an unknown school shows "not found"', async () => {
    show();
    expect(await screen.findByRole('heading', { name: 'Royal Scholars' })).toBeInTheDocument();
    cleanup(); show('nope-school');
    expect(await screen.findByText('School not found')).toBeInTheDocument();
  });
  it('real emails are used as typed; usernames become the school-private address', async () => {
    h.auth.signIn.mockResolvedValue(undefined);
    const u = userEvent.setup();
    show();
    await u.type(await screen.findByLabelText('Email or username'), 'RSA-2026-0001');
    await u.type(screen.getByLabelText('Password'), 'pw');
    await u.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(h.auth.signIn).toHaveBeenLastCalledWith('rsa-2026-0001@royal.login.invalid', 'pw');
    await u.clear(screen.getByLabelText('Email or username'));
    await u.type(screen.getByLabelText('Email or username'), 'Teacher@School.com');
    await u.type(screen.getByLabelText('Password'), 'pw'); // the app clears the password field after each attempt
    await u.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(h.auth.signIn).toHaveBeenLastCalledWith('Teacher@School.com', 'pw');
  });
  it('wrong password shows a friendly message, never a technical one', async () => {
    h.auth.signIn.mockRejectedValue({ code: 'auth/invalid-credential', message: 'Firebase: Error (auth/invalid-credential).' });
    const u = userEvent.setup();
    show();
    await u.type(await screen.findByLabelText('Email or username'), 'a@b.com');
    await u.type(screen.getByLabelText('Password'), 'x');
    await u.click(screen.getByRole('button', { name: 'Sign in' }));
    const a = await screen.findByRole('alert');
    expect(a).toHaveTextContent('Incorrect email or password.');
    expect(a.textContent).not.toMatch(/firebase/i);
  });
  it('forgot password: sends for emails, gives the same neutral message either way, guides username users', async () => {
    h.reset.mockResolvedValue(undefined);
    const u = userEvent.setup();
    show();
    await u.type(await screen.findByLabelText('Email or username'), 'RSA-2026-0001');
    await u.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/ask your school administrator/i);
    expect(h.reset).not.toHaveBeenCalled();
    await u.clear(screen.getByLabelText('Email or username'));
    await u.type(screen.getByLabelText('Email or username'), 'me@school.com');
    await u.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(await screen.findByText(/if an account exists/i)).toBeInTheDocument();
    expect(h.reset.mock.calls[0]![1]).toBe('me@school.com');
    h.reset.mockRejectedValue({ code: 'auth/user-not-found' });
    await u.click(screen.getByRole('button', { name: 'Forgot password?' }));
    expect(await screen.findByText(/if an account exists/i)).toBeInTheDocument(); // no account enumeration
  });
});
