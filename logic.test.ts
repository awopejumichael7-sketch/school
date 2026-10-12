import { describe, it, expect } from 'vitest';
import {
  generateLicenseKey, normalizeLicenseKey, hashLicenseKey, isLicenseHash, maskKey, KEY_ALPHABET,
} from './lib-license';
import {
  slugify, isValidSlug, parseList, validateGrading, validateAssessment, gradeFor, percentage,
  DEFAULT_GRADING, DEFAULT_ASSESSMENT,
} from './lib-config';
import { friendlyError, GENERIC_ERROR, UserFacingError } from './lib-errors';
import { chunkOps, MAX_OPS_PER_BATCH, type Op } from './lib-ops';
import { buildActivationPlan, buildReactivationPlan, uniqueIds, type ActivationInput } from './lib-activation';
import { generateLicenses, planLicenseAction } from './lib-licenseAdmin';
import { readableTextOn, contrastRatio } from './lib-theme';

describe('license keys', () => {
  it('generates the SC-XXXX-XXXX-XXXX-XXXX format from the safe alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const k = generateLicenseKey();
      expect(k).toMatch(/^SC-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    }
  });
  it('uses all 32 symbols roughly uniformly (no modulo bias)', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 2000; i++) {
      for (const ch of generateLicenseKey().slice(3).replace(/-/g, '')) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    expect(counts.size).toBe(32);
    const expected = (2000 * 16) / 32;
    for (const c of counts.values()) expect(Math.abs(c - expected) / expected).toBeLessThan(0.15);
  });
  it('produces no duplicates in 5000 keys', () => {
    const s = new Set(Array.from({ length: 5000 }, () => generateLicenseKey()));
    expect(s.size).toBe(5000);
  });
  it('rejects RNGs that return too few bytes', () => {
    expect(() => generateLicenseKey(() => new Uint8Array(3))).toThrow();
  });
  it('normalises case, spacing, dashes and look-alike characters', () => {
    const k = generateLicenseKey();
    expect(normalizeLicenseKey(k.toLowerCase())).toBe(k);
    expect(normalizeLicenseKey(k.replace(/-/g, ' '))).toBe(k);
    expect(normalizeLicenseKey('sc-oooo-iiii-llll-0000')).toBe('SC-0000-1111-1111-0000');
  });
  it('rejects malformed keys', () => {
    for (const bad of ['', 'SC', 'XX-0000-0000-0000-0000', 'SC-0000-0000-0000', 'SC-0000-0000-0000-000U',
      'SC-0000-0000-0000-00000', 'SC-0000-0000-0000-000!']) {
      expect(normalizeLicenseKey(bad)).toBeNull();
    }
  });
  it('hashes deterministically to 64 hex chars and differs per key', async () => {
    const a = await hashLicenseKey('SC-0000-0000-0000-0000');
    const b = await hashLicenseKey('SC-0000-0000-0000-0001');
    expect(isLicenseHash(a)).toBe(true);
    expect(a).toBe(await hashLicenseKey('SC-0000-0000-0000-0000'));
    expect(a).not.toBe(b);
    expect(a).not.toContain('0000-0000');
  });
  it('masks keys', () => {
    expect(maskKey('SC-ABCD-EFGH-JKMN-PQRS')).toBe('SC-••••-••••-••••-PQRS');
  });
  it('alphabet has exactly 32 unique symbols', () => {
    expect(new Set(KEY_ALPHABET).size).toBe(32);
  });
});

describe('config helpers', () => {
  it('slugify', () => {
    expect(slugify("Scholar's Camp")).toBe('scholar-s-camp');
    expect(slugify('  Éxcellent Future College! ')).toBe('excellent-future-college');
    expect(isValidSlug('abc')).toBe(true);
    expect(isValidSlug('ab')).toBe(false);
    expect(isValidSlug('-abc')).toBe(false);
    expect(isValidSlug('ABC')).toBe(false);
  });
  it('parseList dedupes case-insensitively and trims', () => {
    expect(parseList('Maths, english\nMATHS ;  Physics ,, ')).toEqual(['Maths', 'english', 'Physics']);
  });
  it('default grading and assessment are valid', () => {
    expect(validateGrading(DEFAULT_GRADING)).toEqual({ ok: true, errors: [] });
    expect(validateAssessment(DEFAULT_ASSESSMENT)).toEqual({ ok: true, errors: [] });
  });
  it('detects grading gaps, overlaps and bad coverage', () => {
    const gap = [{ min: 0, max: 40, grade: 'F', remark: '' }, { min: 50, max: 100, grade: 'A', remark: '' }];
    expect(validateGrading(gap).ok).toBe(false);
    const overlap = [{ min: 0, max: 60, grade: 'F', remark: '' }, { min: 50, max: 100, grade: 'A', remark: '' }];
    expect(validateGrading(overlap).ok).toBe(false);
    const noZero = [{ min: 10, max: 50, grade: 'F', remark: '' }, { min: 50.01, max: 100, grade: 'A', remark: '' }];
    expect(validateGrading(noZero).errors.join()).toContain('start at 0');
  });
  it('assessment weights must total 100', () => {
    expect(validateAssessment([{ key: 'a', label: 'A', weight: 30 }, { key: 'b', label: 'B', weight: 60 }]).ok).toBe(false);
    expect(validateAssessment([{ key: 'a', label: 'A', weight: 33.3 }, { key: 'b', label: 'B', weight: 66.7 }]).ok).toBe(true);
  });
  it('gradeFor uses school bands and clamps', () => {
    expect(gradeFor(85, DEFAULT_GRADING)?.grade).toBe('A');
    expect(gradeFor(64.99, DEFAULT_GRADING)?.grade).toBe('C');
    expect(gradeFor(150, DEFAULT_GRADING)?.grade).toBe('A');
    expect(gradeFor(-5, DEFAULT_GRADING)?.grade).toBe('F');
    expect(gradeFor(NaN, DEFAULT_GRADING)).toBeNull();
  });
  it('percentage matches the spec example (42/45 = 93.33)', () => {
    expect(percentage(42, 45)).toBe(93.33);
    expect(percentage(1, 0)).toBe(0);
  });
});

describe('errors', () => {
  it('never leaks technical text', () => {
    const msg = friendlyError({ code: 'permission-denied', message: 'FirebaseError: PERMISSION_DENIED' });
    expect(msg).toBe("You don't have permission to perform this action.");
    expect(friendlyError({ code: 'firestore/unavailable' })).toContain('temporarily unavailable');
    expect(friendlyError(new Error('FirebaseError: boom'))).toBe(GENERIC_ERROR);
    expect(friendlyError('weird')).toBe(GENERIC_ERROR);
    expect(friendlyError(new UserFacingError('Custom'))).toBe('Custom');
  });
});

describe('theme', () => {
  it('chooses readable text colour', () => {
    expect(readableTextOn('#ffffff')).toBe('#111827');
    expect(readableTextOn('#000000')).toBe('#ffffff');
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
  });
});

describe('ops', () => {
  it('chunks', () => {
    const ops: Op[] = Array.from({ length: 20 }, (_, i) => ({ kind: 'set', path: `x/${i}`, data: {} }));
    const c = chunkOps(ops);
    expect(c.map((x) => x.length)).toEqual([9, 9, 2]);
    expect(() => chunkOps(ops, 0)).toThrow();
  });
});

const base: ActivationInput = {
  licenseHash: 'a'.repeat(64),
  license: { plan: 'standard', expiresAt: null },
  uid: 'u1', adminName: 'Ada', adminEmail: 'ada@x.com',
  tenantId: 'tenant1', installationId: 'inst1', slug: 'royal-scholars',
  profile: { name: 'Royal Scholars Academy', motto: '', address: '', phone: '', email: '', website: '', footer: '', emailSenderName: '' },
  logoDataUrl: null, primaryColor: '#112233', secondaryColor: '#445566',
  settings: { academicSession: '2026/2027', terms: ['Term 1', 'Term 2', 'Term 3'], currency: 'NGN', timezone: 'Africa/Lagos', grading: DEFAULT_GRADING, assessment: DEFAULT_ASSESSMENT },
  classes: Array.from({ length: 14 }, (_, i) => `Class ${i + 1}`),
  subjects: ['Maths', 'English', 'Maths'],
};

describe('activation plan', () => {
  const plan = buildActivationPlan(base);
  it('core batch binds license to the tenant being created and stays within rule limits', () => {
    expect(plan.core.length).toBeLessThanOrEqual(20);
    const lic = plan.core.find((o) => o.path === `licenses/${base.licenseHash}`)!;
    expect(lic.kind).toBe('update');
    expect(lic.data).toMatchObject({ status: 'ACTIVE', tenantId: 'tenant1', activationCount: 1, activatedBy: 'u1' });
    expect(plan.core.map((o) => o.path)).toEqual(expect.arrayContaining([
      'tenants/tenant1', 'tenants/tenant1/members/u1', 'userDirectory/u1', 'publicProfiles/tenant1', 'slugs/royal-scholars',
    ]));
    expect((plan.core.find((o) => o.path === 'tenants/tenant1/members/u1')!.data as { role: string }).role).toBe('SCHOOL_ADMIN');
  });
  it('config batches never exceed the per-batch limit and end with setupComplete', () => {
    for (const b of plan.config) expect(b.length).toBeLessThanOrEqual(MAX_OPS_PER_BATCH);
    const lastBatch = plan.config[plan.config.length - 1]!;
    const last = lastBatch[lastBatch.length - 1]!;
    expect(last.path).toBe('tenants/tenant1');
    expect(last.data).toMatchObject({ setupComplete: true });
  });
  it('every config op stays inside the tenant', () => {
    for (const op of plan.config.flat()) {
      if (op.path.startsWith('licenseEvents/')) continue; // global, platform-readable history
      expect(op.path.startsWith('tenants/tenant1')).toBe(true);
    }
    expect(plan.config[0]!.map((o) => o.path)).toEqual(['licenseEvents/act_tenant1']);
  });
  it('de-duplicates document IDs', () => {
    expect(uniqueIds(['Maths', 'maths', 'Maths!'], 's')).toEqual(['maths', 'maths-2', 'maths-3']);
    expect(uniqueIds(['!!!'], 'class')).toEqual(['class1']);
    const subj = plan.config.flat().filter((o) => o.path.includes('/subjects/')).map((o) => o.path);
    expect(new Set(subj).size).toBe(subj.length);
  });
  it('copies expiry from the license', () => {
    const p = buildActivationPlan({ ...base, license: { plan: 'x', expiresAt: null } });
    expect(p.core.find((o) => o.path === 'tenants/tenant1')!.data.expiresAt).toBeNull();
  });
  it('reactivation plan never changes tenantId', () => {
    const ops = buildReactivationPlan({ licenseHash: 'h', tenantId: 't', uid: 'u', installationId: 'newinstallation' });
    expect(Object.keys(ops[0]!.data)).not.toContain('tenantId');
  });
});

describe('license admin', () => {
  it('generates unique licenses with hashed IDs and unbound state', async () => {
    const g = await generateLicenses({ count: 25, plan: 'standard', billingCycle: 'LIFETIME', expiresAt: null, note: '', creatorUid: 'o' });
    expect(new Set(g.map((x) => x.hash)).size).toBe(25);
    for (const x of g) {
      expect(x.op.path).toBe(`licenses/${x.hash}`);
      expect(JSON.stringify(x.op.data)).not.toContain(x.key);
      expect(x.op.data).toMatchObject({ status: 'UNUSED', tenantId: null, activationCount: 0, maxActivations: 1 });
    }
  });
  it('validates count', async () => {
    await expect(generateLicenses({ count: 0, plan: 'p', billingCycle: 'LIFETIME', expiresAt: null, note: '', creatorUid: 'o' })).rejects.toThrow();
    await expect(generateLicenses({ count: 101, plan: 'p', billingCycle: 'LIFETIME', expiresAt: null, note: '', creatorUid: 'o' })).rejects.toThrow();
  });
  it('actions keep license and tenant in sync', () => {
    const id = () => 'ev1';
    const act = { status: 'ACTIVE' as const, tenantId: 't1' };
    const d = planLicenseAction('h', act, { type: 'DEACTIVATE' }, 'o', id);
    expect(d.map((o) => o.path)).toEqual(['licenses/h', 'tenants/t1', 'licenseEvents/ev1']);
    expect(d[1]!.data).toMatchObject({ status: 'SUSPENDED' });
    const r = planLicenseAction('h', { status: 'ACTIVE', tenantId: 't1' }, { type: 'RESET_INSTALLATION' }, 'o', id);
    expect(r[0]!.data).toMatchObject({ status: 'RESET', activationCount: 0, installationId: null });
    expect(Object.keys(r[0]!.data)).not.toContain('tenantId');
    expect(() => planLicenseAction('h', { status: 'UNUSED', tenantId: null }, { type: 'RESET_INSTALLATION' }, 'o', id)).toThrow();
    expect(() => planLicenseAction('h', act, { type: 'REACTIVATE' }, 'o', id)).toThrow();
    const ru = planLicenseAction('h', { status: 'DEACTIVATED', tenantId: null }, { type: 'REACTIVATE' }, 'o', id);
    expect(ru[0]!.data).toMatchObject({ status: 'UNUSED' });
    const e = planLicenseAction('h', { status: 'UNUSED', tenantId: null }, { type: 'SET_EXPIRY', expiresAt: null }, 'o', id);
    expect(e.length).toBe(2);
  });
});
