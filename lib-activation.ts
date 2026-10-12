import { serverTimestamp } from 'firebase/firestore';
import { chunkOps, type Op } from './lib-ops';
import { slugify } from './lib-config';
import type { LicenseDoc, SchoolProfile, SchoolSettings } from './types';

export interface ActivationInput {
  licenseHash: string;
  license: Pick<LicenseDoc, 'plan' | 'expiresAt'>;
  uid: string;
  adminName: string;
  adminEmail: string;
  tenantId: string;
  installationId: string;
  slug: string;
  profile: SchoolProfile;
  logoDataUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
  settings: SchoolSettings;
  classes: string[];
  subjects: string[];
}

export interface ActivationPlan {
  /** One atomic batch: bind license, create tenant + first admin + public pages. */
  core: Op[];
  /** Follow-up batches (license event, classes, subjects, terms, audit). Idempotent, safe to retry. */
  config: Op[][];
}

/** Deterministic, unique document IDs from display names. */
export function uniqueIds(names: string[], prefix: string): string[] {
  const used = new Map<string, number>();
  return names.map((n, i) => {
    const base = slugify(n) || `${prefix}${i + 1}`;
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  });
}

export function buildActivationPlan(i: ActivationInput): ActivationPlan {
  const t = i.tenantId;
  const core: Op[] = [
    {
      // Rules: only UNUSED -> ACTIVE, count 0 -> 1, bound to the tenant created in this same batch.
      kind: 'update',
      path: `licenses/${i.licenseHash}`,
      data: {
        status: 'ACTIVE',
        tenantId: t,
        installationId: i.installationId,
        activationCount: 1,
        activatedAt: serverTimestamp(),
        activatedBy: i.uid,
        lastValidated: serverTimestamp(),
      },
    },
    {
      kind: 'set',
      path: `tenants/${t}`,
      data: {
        name: i.profile.name,
        ownerUid: i.uid,
        licenseId: i.licenseHash,
        plan: i.license.plan,
        status: 'ACTIVE',
        installationId: i.installationId,
        expiresAt: i.license.expiresAt ?? null,
        profile: i.profile,
        settings: i.settings,
        setupComplete: false,
        createdAt: serverTimestamp(),
      },
    },
    {
      kind: 'set',
      path: `tenants/${t}/members/${i.uid}`,
      data: {
        uid: i.uid,
        tenantId: t,
        role: 'SCHOOL_ADMIN',
        status: 'ACTIVE',
        displayName: i.adminName,
        email: i.adminEmail,
      },
    },
    { kind: 'set', path: `userDirectory/${i.uid}`, data: { tenantId: t } },
    {
      kind: 'set',
      path: `publicProfiles/${t}`,
      data: {
        tenantId: t,
        slug: i.slug,
        name: i.profile.name,
        motto: i.profile.motto,
        logoDataUrl: i.logoDataUrl,
        primaryColor: i.primaryColor,
        secondaryColor: i.secondaryColor,
      },
    },
    { kind: 'set', path: `slugs/${i.slug}`, data: { tenantId: t } },
  ];

  // Own tiny batch: keeps the core batch under the 20 rules-access-call limit.
  const eventBatch: Op[] = [
    {
      kind: 'set',
      path: `licenseEvents/act_${t}`,
      data: { licenseId: i.licenseHash, tenantId: t, type: 'ACTIVATED', actorId: i.uid, at: serverTimestamp() },
    },
  ];

  const rows: Op[] = [];
  const classIds = uniqueIds(i.classes, 'class');
  i.classes.forEach((name, idx) =>
    rows.push({
      kind: 'set',
      path: `tenants/${t}/classes/${classIds[idx]}`,
      data: { tenantId: t, name, order: idx, status: 'ACTIVE', createdAt: serverTimestamp() },
    }),
  );
  const subjectIds = uniqueIds(i.subjects, 'subject');
  i.subjects.forEach((name, idx) =>
    rows.push({
      kind: 'set',
      path: `tenants/${t}/subjects/${subjectIds[idx]}`,
      data: { tenantId: t, name, order: idx, status: 'ACTIVE', createdAt: serverTimestamp() },
    }),
  );
  const termIds = uniqueIds(i.settings.terms, 'term');
  i.settings.terms.forEach((name, idx) =>
    rows.push({
      kind: 'set',
      path: `tenants/${t}/terms/${termIds[idx]}`,
      data: { tenantId: t, name, order: idx, session: i.settings.academicSession, createdAt: serverTimestamp() },
    }),
  );
  rows.push({
    kind: 'set',
    path: `tenants/${t}/auditLogs/act_${t}`,
    data: {
      actorId: i.uid,
      tenantId: t,
      action: 'license.activated',
      target: `licenses/${i.licenseHash.slice(0, 8)}`,
      timestamp: serverTimestamp(),
      metadata: { plan: i.license.plan, school: i.profile.name },
    },
  });
  // Last op: mark setup complete, so a half-finished setup is detectable and resumable.
  const batches = chunkOps(rows);
  // Own batch: the tenant-update rule performs more access calls than a plain row write.
  batches.push([{
    kind: 'update',
    path: `tenants/${t}`,
    data: { setupComplete: true, updatedAt: serverTimestamp() },
  }]);

  return { core, config: [eventBatch, ...batches] };
}

/** School admin re-binding a RESET license to the SAME tenant (never a different one). */
export function buildReactivationPlan(args: {
  licenseHash: string;
  tenantId: string;
  uid: string;
  installationId: string;
}): Op[] {
  return [
    {
      kind: 'update',
      path: `licenses/${args.licenseHash}`,
      data: {
        status: 'ACTIVE',
        installationId: args.installationId,
        activationCount: 1,
        lastValidated: serverTimestamp(),
      },
    },
    {
      kind: 'update',
      path: `tenants/${args.tenantId}`,
      data: { status: 'ACTIVE', installationId: args.installationId, updatedAt: serverTimestamp() },
    },
    {
      kind: 'set',
      path: `licenseEvents/react_${args.tenantId}_${args.installationId.slice(0, 8)}`,
      data: {
        licenseId: args.licenseHash,
        tenantId: args.tenantId,
        type: 'REACTIVATED',
        actorId: args.uid,
        at: serverTimestamp(),
      },
    },
  ];
}
