import { Timestamp, serverTimestamp } from 'firebase/firestore';
import { generateLicenseKey, hashLicenseKey, secureRandomBytes, type RandomBytes } from './lib-license';
import { newId, type Op } from './lib-ops';
import { UserFacingError } from './lib-errors';
import type { BillingCycle, LicenseDoc } from './types';

export interface NewLicenseParams {
  count: number;
  plan: string;
  billingCycle: BillingCycle;
  expiresAt: Date | null;
  note: string;
  creatorUid: string;
}

export interface GeneratedLicense { key: string; hash: string; op: Op }

/** Raw keys exist only in this return value: show/export them once, then discard. */
export async function generateLicenses(
  p: NewLicenseParams,
  rng: RandomBytes = secureRandomBytes,
): Promise<GeneratedLicense[]> {
  if (!Number.isInteger(p.count) || p.count < 1 || p.count > 100) {
    throw new UserFacingError('You can generate between 1 and 100 licenses at a time.');
  }
  const out: GeneratedLicense[] = [];
  const seen = new Set<string>();
  while (out.length < p.count) {
    const key = generateLicenseKey(rng);
    const hash = await hashLicenseKey(key);
    if (seen.has(hash)) continue;
    seen.add(hash);
    out.push({
      key,
      hash,
      op: {
        kind: 'set',
        path: `licenses/${hash}`,
        data: {
          product: 'school-saas',
          plan: p.plan,
          billingCycle: p.billingCycle,
          status: 'UNUSED',
          tenantId: null,
          installationId: null,
          activationCount: 0,
          maxActivations: 1,
          createdAt: serverTimestamp(),
          createdBy: p.creatorUid,
          activatedAt: null,
          activatedBy: null,
          lastValidated: null,
          expiresAt: p.expiresAt ? Timestamp.fromDate(p.expiresAt) : null,
          note: p.note,
        },
      },
    });
  }
  return out;
}

export type LicenseAction =
  | { type: 'DEACTIVATE' }
  | { type: 'REACTIVATE' }
  | { type: 'RESET_INSTALLATION' }
  | { type: 'SET_EXPIRY'; expiresAt: Date | null }
  | { type: 'SET_PLAN'; plan: string; billingCycle: BillingCycle };

function event(
  licenseId: string, tenantId: string | null, type: string, actor: string,
  metadata: Record<string, unknown>, id: string,
): Op {
  return {
    kind: 'set',
    path: `licenseEvents/${id}`,
    data: { licenseId, tenantId, type, actorId: actor, at: serverTimestamp(), metadata },
  };
}

/** Product-owner actions. Returns atomic writes that keep license + tenant in sync. */
export function planLicenseAction(
  hash: string,
  lic: Pick<LicenseDoc, 'status' | 'tenantId'>,
  action: LicenseAction,
  actorUid: string,
  makeId: () => string = newId,
): Op[] {
  const lp = `licenses/${hash}`;
  const tp = lic.tenantId ? `tenants/${lic.tenantId}` : null;
  const ev = (type: string, meta: Record<string, unknown> = {}) =>
    event(hash, lic.tenantId, type, actorUid, meta, makeId());

  switch (action.type) {
    case 'DEACTIVATE': {
      if (lic.status === 'DEACTIVATED') throw new UserFacingError('This license is already deactivated.');
      const ops: Op[] = [{ kind: 'update', path: lp, data: { status: 'DEACTIVATED' } }];
      if (tp) ops.push({ kind: 'update', path: tp, data: { status: 'SUSPENDED', updatedAt: serverTimestamp() } });
      return [...ops, ev('DEACTIVATED')];
    }
    case 'REACTIVATE': {
      if (lic.status !== 'DEACTIVATED') throw new UserFacingError('Only deactivated licenses can be reactivated.');
      const next = tp ? 'ACTIVE' : 'UNUSED';
      const ops: Op[] = [{ kind: 'update', path: lp, data: { status: next } }];
      if (tp) ops.push({ kind: 'update', path: tp, data: { status: 'ACTIVE', updatedAt: serverTimestamp() } });
      return [...ops, ev('REACTIVATED_BY_OWNER')];
    }
    case 'RESET_INSTALLATION': {
      if (!tp) throw new UserFacingError('This license has not been activated, so there is nothing to reset.');
      if (lic.status !== 'ACTIVE') throw new UserFacingError('Only active licenses can be reset.');
      return [
        { kind: 'update', path: lp, data: { status: 'RESET', activationCount: 0, installationId: null } },
        { kind: 'update', path: tp, data: { status: 'SUSPENDED', updatedAt: serverTimestamp() } },
        ev('INSTALLATION_RESET'),
      ];
    }
    case 'SET_EXPIRY': {
      const ts = action.expiresAt ? Timestamp.fromDate(action.expiresAt) : null;
      const ops: Op[] = [{ kind: 'update', path: lp, data: { expiresAt: ts } }];
      if (tp) ops.push({ kind: 'update', path: tp, data: { expiresAt: ts, updatedAt: serverTimestamp() } });
      return [...ops, ev('EXPIRY_CHANGED', { expiresAt: action.expiresAt ? action.expiresAt.toISOString() : null })];
    }
    case 'SET_PLAN': {
      const ops: Op[] = [{ kind: 'update', path: lp, data: { plan: action.plan, billingCycle: action.billingCycle } }];
      if (tp) ops.push({ kind: 'update', path: tp, data: { plan: action.plan, updatedAt: serverTimestamp() } });
      return [...ops, ev('PLAN_CHANGED', { plan: action.plan, billingCycle: action.billingCycle })];
    }
  }
}
