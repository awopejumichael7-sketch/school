import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: string[] = [];
const createMock = vi.fn();
vi.mock('firebase/auth', () => ({
  createUserWithEmailAndPassword: (...a: unknown[]) => createMock(...a),
  deleteUser: async () => { calls.push('delete'); },
  signOut: async () => { calls.push('signOut'); },
}));
vi.mock('./lib-firebase', () => ({ secondaryAuth: () => ({ name: 'secondary' }) }));

let counterDoc: { next: number } | null = null;
const txSets: unknown[] = [];
vi.mock('firebase/firestore', async (orig) => {
  const real = await orig<typeof import('firebase/firestore')>();
  return {
    ...real,
    doc: (_d: unknown, p: string) => ({ path: p }),
    runTransaction: async (_db: unknown, fn: (tx: unknown) => Promise<number>) => {
      const tx = {
        get: async () => ({ exists: () => counterDoc !== null, data: () => counterDoc }),
        set: (_r: unknown, v: { next: number }) => { txSets.push(v); counterDoc = v; },
      };
      return fn(tx);
    },
  };
});

import { withNewAccount } from './lib-newuser';
import { reserveAdmissionNumbers } from './lib-numbers';

beforeEach(() => { calls.length = 0; createMock.mockReset(); counterDoc = null; txSets.length = 0; });

describe('withNewAccount', () => {
  it('creates the account, runs the writes, then signs the secondary session out', async () => {
    createMock.mockResolvedValue({ user: { uid: 'u9' } });
    const out = await withNewAccount('a@b.com', 'pw', async (uid) => { calls.push(`run:${uid}`); return 'ok'; });
    expect(out).toBe('ok');
    expect(calls).toEqual(['run:u9', 'signOut']);
  });
  it('ROLLS BACK the account if the school records fail to save, and still signs out', async () => {
    createMock.mockResolvedValue({ user: { uid: 'u9' } });
    await expect(withNewAccount('a@b.com', 'pw', async () => { throw { code: 'permission-denied' }; })).rejects.toMatchObject({ code: 'permission-denied' });
    expect(calls).toEqual(['delete', 'signOut']);
  });
  it('does nothing else when account creation itself fails (e.g. email in use)', async () => {
    createMock.mockRejectedValue({ code: 'auth/email-already-in-use' });
    const run = vi.fn();
    await expect(withNewAccount('a@b.com', 'pw', run)).rejects.toMatchObject({ code: 'auth/email-already-in-use' });
    expect(run).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
});

describe('reserveAdmissionNumbers', () => {
  it('starts at 1 when no counter exists and creates it', async () => {
    const nums = await reserveAdmissionNumbers({} as never, 't', 2026, 'RSA', 3);
    expect(nums).toEqual(['RSA-2026-0001', 'RSA-2026-0002', 'RSA-2026-0003']);
    expect(counterDoc).toEqual({ next: 4 });
  });
  it('continues from the stored counter and never hands out the same number twice', async () => {
    counterDoc = { next: 10 };
    const a = await reserveAdmissionNumbers({} as never, 't', 2026, 'RSA', 2);
    const b = await reserveAdmissionNumbers({} as never, 't', 2026, 'RSA', 2);
    expect(a).toEqual(['RSA-2026-0010', 'RSA-2026-0011']);
    expect(b).toEqual(['RSA-2026-0012', 'RSA-2026-0013']);
    expect(txSets).toEqual([{ next: 12 }, { next: 14 }]);
  });
  it('rejects absurd counts', async () => {
    await expect(reserveAdmissionNumbers({} as never, 't', 2026, 'X', 0)).rejects.toThrow();
    await expect(reserveAdmissionNumbers({} as never, 't', 2026, 'X', 501)).rejects.toThrow();
  });
});
