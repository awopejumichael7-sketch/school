/**
 * Static checks on firestore.rules. These do NOT replace the emulator tests (rules.test.ts) —
 * they catch typos and drift between what the app writes and what the rules accept.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildActivationPlan, buildReactivationPlan, type ActivationInput } from './lib-activation';
import { generateLicenses, planLicenseAction } from './lib-licenseAdmin';
import { buildMemberOps, auditOp } from './lib-accounts';
import { buildStudentDoc, buildStudentUpdate, buildTeacherDoc, buildParentDoc, type StudentInput } from './lib-people';
import { DEFAULT_ASSESSMENT, DEFAULT_GRADING } from './lib-config';

const raw = readFileSync('firestore.rules', 'utf8');
const rules = raw.replace(/\/\/.*$/gm, ''); // strip comments

const BUILTINS = new Set(['get', 'exists', 'getAfter', 'existsAfter', 'hasOnly', 'hasAll', 'hasAny', 'matches', 'size', 'keys', 'diff', 'affectedKeys']);

function section(startMarker: string): string {
  const i = rules.indexOf(startMarker);
  if (i < 0) throw new Error(`marker not found: ${startMarker}`);
  const rest = rules.slice(i + startMarker.length);
  const next = rest.search(/\n\s{4}(function |match \/)/);
  return rest.slice(0, next < 0 ? undefined : next);
}
const fnBody = (name: string) => section(`function ${name}(`);
function list(body: string, kind: 'hasOnly' | 'hasAll', nth = 0): string[] {
  const all = [...body.matchAll(new RegExp(`${kind}\\(\\s*\\[([^\\]]*)\\]\\s*\\)`, 'g'))];
  const m = all[nth];
  if (!m) throw new Error(`no ${kind} #${nth}`);
  return [...(m[1] as string).matchAll(/'([^']+)'/g)].map((x) => x[1] as string);
}
const keysOf = (o: Record<string, unknown>) => Object.keys(o).sort();
const subset = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));

describe('firestore.rules static checks', () => {
  it('has balanced braces, parentheses and brackets', () => {
    const stripped = rules.replace(/'[^']*'/g, "''");
    for (const [o, c] of [['{', '}'], ['(', ')'], ['[', ']']] as const) {
      expect(stripped.split(o).length, `${o}${c}`).toBe(stripped.split(c).length);
    }
  });
  it('every called helper is defined, and none is defined twice', () => {
    const defined = [...rules.matchAll(/function\s+(\w+)\s*\(/g)].map((m) => m[1] as string);
    expect(new Set(defined).size).toBe(defined.length);
    const called = new Set([...rules.matchAll(/(?<![.\w])(\w+)\s*\(/g)].map((m) => m[1] as string));
    for (const c of called) {
      if (c === 'function' || c === 'allow' || c === 'if' || BUILTINS.has(c) || defined.includes(c)) continue;
      throw new Error(`undefined function used in rules: ${c}`);
    }
    // method-style builtins must also be known
    for (const m of rules.matchAll(/\.(\w+)\s*\(/g)) expect(BUILTINS.has(m[1] as string), `.${m[1]}()`).toBe(true);
  });
  it('every allow statement is terminated and uses a valid method list', () => {
    const stmts = [...rules.matchAll(/allow\s+([a-z, ]+):\s*if\b([^;]*);/g)];
    const count = [...rules.matchAll(/\ballow\b/g)].length;
    expect(stmts.length).toBe(count);
    for (const s of stmts) for (const m of (s[1] as string).split(',').map((x) => x.trim())) {
      expect(['read', 'write', 'get', 'list', 'create', 'update', 'delete']).toContain(m);
    }
  });
  it('default-deny catch-all is the last match block', () => {
    const last = rules.lastIndexOf('match /');
    expect(rules.slice(last)).toContain('{document=**}');
    expect(rules.slice(last)).toContain('if false');
  });
  it('temp-password accounts are blocked from data access inside hasRole', () => {
    expect(fnBody('hasRole')).toContain("mustChangePassword', false) == false");
  });
});

// ---------------------------------------------------------------- drift checks
const input: ActivationInput = {
  licenseHash: 'a'.repeat(64), license: { plan: 'p', expiresAt: null }, uid: 'u', adminName: 'A', adminEmail: 'a@x.com',
  tenantId: 't', installationId: 'install-1', slug: 'slug-1',
  profile: { name: 'N', motto: '', address: '', phone: '', email: '', website: '', footer: '', emailSenderName: '' },
  logoDataUrl: null, primaryColor: '#112233', secondaryColor: '#445566',
  settings: { academicSession: '2026', terms: ['T1'], currency: 'NGN', timezone: 'UTC', grading: DEFAULT_GRADING, assessment: DEFAULT_ASSESSMENT },
  classes: ['A'], subjects: ['B'],
};
const studentInput: StudentInput = {
  firstName: 'A', middleName: '', lastName: 'B', gender: 'MALE', dateOfBirth: '2014-01-01', classId: 'c', phone: '', email: '',
  address: '', admissionNumber: '', admissionDate: '2026-01-01',
};

describe('app writes match what the rules accept', () => {
  const plan = buildActivationPlan(input);
  const coreDoc = (path: string) => plan.core.find((o) => o.path === path)!.data;

  it('student create / update', () => {
    const doc = keysOf(buildStudentDoc(studentInput, { tenantId: 't', admissionNumber: 'AB-1', academicSession: 's', photo: null, uid: null, createdBy: 'a' }));
    const body = fnBody('validStudentCreate');
    expect(subset(doc, list(body, 'hasOnly'))).toEqual([]);   // nothing the rules would reject
    expect(subset(list(body, 'hasAll'), doc)).toEqual([]);    // nothing the rules require is missing
    expect(subset(keysOf(buildStudentUpdate(studentInput, null)), list(fnBody('validStudentUpdate'), 'hasOnly'))).toEqual([]);
  });
  it('teacher create', () => {
    const doc = keysOf(buildTeacherDoc({ name: 'Mr T', email: 't@x.com', phone: '', subjects: [], classes: [] }, { tenantId: 't', uid: 'u', photo: null, createdBy: 'a' }));
    const body = fnBody('validTeacherCreate');
    expect(subset(doc, list(body, 'hasOnly'))).toEqual([]);
    expect(subset(list(body, 'hasAll'), doc)).toEqual([]);
  });
  it('parent create', () => {
    const doc = keysOf(buildParentDoc({ name: 'Mr P', email: '', phone: '', childAdmissionNumbers: [] }, { tenantId: 't', uid: 'u', loginId: 'l', childIds: [], createdBy: 'a' }));
    const body = fnBody('validParentCreate');
    expect(subset(doc, list(body, 'hasOnly'))).toEqual([]);
    expect(subset(list(body, 'hasAll'), doc)).toEqual([]);
  });
  it('admin-created member (with and without assignments)', () => {
    for (const extra of [{}, { classIds: ['c'], subjectIds: ['s'] }]) {
      const doc = keysOf(buildMemberOps({ tenantId: 't', uid: 'u', role: 'TEACHER', displayName: 'T', email: '', loginId: 'x', ...extra })[0]!.data);
      const body = fnBody('adminCreatesMember');
      expect(subset(doc, list(body, 'hasOnly'))).toEqual([]);
      expect(subset(list(body, 'hasAll'), doc)).toEqual([]);
    }
  });
  it('activation: owner member, tenant, public profile, slug, audit and license event', () => {
    expect(subset(keysOf(coreDoc('tenants/t/members/u')), list(fnBody('ownerBootstrapMember'), 'hasOnly'))).toEqual([]);
    const tbody = fnBody('validTenantCreate');
    expect(subset(keysOf(coreDoc('tenants/t')), list(tbody, 'hasOnly'))).toEqual([]);
    expect(subset(keysOf(coreDoc('publicProfiles/t')), list(fnBody('validPublicProfile'), 'hasOnly'))).toEqual([]);
    expect(subset(keysOf(coreDoc('slugs/slug-1')), list(section("match /slugs/{slug}"), 'hasOnly'))).toEqual([]);
    const audit = plan.config.flat().find((o) => o.path.includes('/auditLogs/'))!.data;
    expect(subset(keysOf(audit), list(section('match /tenants/{t}/auditLogs/{id}'), 'hasOnly'))).toEqual([]);
    expect(keysOf(auditOp('t', 'u', 'x', 'a', 'b').data)).toEqual(keysOf(audit));
    const ev = plan.config.flat().find((o) => o.path.startsWith('licenseEvents/'))!.data;
    expect(subset(keysOf(ev), list(fnBody('validLicenseEvent'), 'hasOnly'))).toEqual([]);
  });
  it('license create matches the rules exactly; owner actions and events stay within allowed keys', async () => {
    const [g] = await generateLicenses({ count: 1, plan: 'p', billingCycle: 'LIFETIME', expiresAt: null, note: '', creatorUid: 'o' });
    const body = fnBody('validNewLicense');
    expect(keysOf(g!.op.data)).toEqual(list(body, 'hasOnly').sort());
    expect(keysOf(g!.op.data)).toEqual(list(body, 'hasAll').sort());
    const ownerAllowed = list(fnBody('ownerLicenseEdit'), 'hasOnly');
    for (const action of [{ type: 'DEACTIVATE' }, { type: 'RESET_INSTALLATION' }, { type: 'SET_EXPIRY', expiresAt: null }, { type: 'SET_PLAN', plan: 'x', billingCycle: 'ANNUAL' }] as const) {
      const ops = planLicenseAction('h'.repeat(64), { status: 'ACTIVE', tenantId: 't' }, action, 'o', () => 'e');
      for (const op of ops.filter((o) => o.path.startsWith('licenses/'))) expect(subset(keysOf(op.data), ownerAllowed)).toEqual([]);
      for (const op of ops.filter((o) => o.path.startsWith('tenants/'))) expect(subset(keysOf(op.data), list(fnBody('platformTenantEdit'), 'hasOnly'))).toEqual([]);
      for (const op of ops.filter((o) => o.path.startsWith('licenseEvents/'))) expect(subset(keysOf(op.data), list(fnBody('validLicenseEvent'), 'hasOnly'))).toEqual([]);
    }
    const react = buildReactivationPlan({ licenseHash: 'h'.repeat(64), tenantId: 't', uid: 'u', installationId: 'install-2' });
    expect(subset(keysOf(react[0]!.data), list(fnBody('isReactivation'), 'hasOnly'))).toEqual([]);
    expect(subset(keysOf(react[1]!.data), list(fnBody('tenantReactivation'), 'hasOnly'))).toEqual([]);
    expect(subset(keysOf(react[2]!.data), list(fnBody('validLicenseEvent'), 'hasOnly'))).toEqual([]);
    const first = keysOf(coreDoc(`licenses/${'a'.repeat(64)}`));
    expect(subset(first, list(fnBody('isFirstActivation'), 'hasOnly'))).toEqual([]);
  });
});
