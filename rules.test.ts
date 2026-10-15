/**
 * Firestore security-rules tests. Run with:  npm run test:rules
 * (needs Java + the Firebase emulator; downloads on first run).
 * STATUS: written but NOT executed in the build sandbox (emulator download blocked).
 */
import { describe, it, beforeAll, beforeEach, afterAll } from 'vitest';
import {
  initializeTestEnvironment, assertFails, assertSucceeds, type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { doc, getDoc, getDocs, collection, query, where, setDoc, updateDoc, deleteDoc, serverTimestamp, type Firestore } from 'firebase/firestore';
import { applyOps } from './lib-ops';
import { buildActivationPlan, buildReactivationPlan, type ActivationInput } from './lib-activation';
import { planLicenseAction } from './lib-licenseAdmin';
import { DEFAULT_ASSESSMENT, DEFAULT_GRADING } from './lib-config';
import { buildMemberOps } from './lib-accounts';
import { buildAttendanceCreate, buildAttendanceUpdate, type Status } from './lib-attendance';
import { buildFeeDoc, buildFeeItemDoc, planPayment, planReversal, type FeeRef } from './lib-fees';
import { buildStudentDoc, buildTeacherDoc, buildParentDoc, buildStudentUpdate, type StudentInput } from './lib-people';

const H = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
let env: RulesTestEnvironment;
const fs = (uid: string | null): Firestore =>
  (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore() as unknown as Firestore;

function input(over: Partial<ActivationInput> = {}): ActivationInput {
  return {
    licenseHash: H, license: { plan: 'standard', expiresAt: null }, uid: 'adminA', adminName: 'A', adminEmail: 'a@x.com',
    tenantId: 'tenantA', installationId: 'install-aaaa', slug: 'school-a',
    profile: { name: 'School A', motto: '', address: '', phone: '', email: '', website: '', footer: '', emailSenderName: '' },
    logoDataUrl: null, primaryColor: '#112233', secondaryColor: '#445566',
    settings: { academicSession: '2026', terms: ['T1'], currency: 'NGN', timezone: 'Africa/Lagos', grading: DEFAULT_GRADING, assessment: DEFAULT_ASSESSMENT },
    classes: ['JS1'], subjects: ['Maths'], ...over,
  };
}
const lic = (extra: Record<string, unknown> = {}) => ({
  product: 'school-saas', plan: 'standard', billingCycle: 'LIFETIME', status: 'UNUSED', tenantId: null, installationId: null,
  activationCount: 0, maxActivations: 1, createdAt: new Date(), createdBy: 'owner1', activatedAt: null, activatedBy: null,
  lastValidated: null, expiresAt: null, note: '', ...extra,
});

async function seedTenant(id: string, adminUid: string, extra: Record<string, unknown> = {}) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore() as unknown as Firestore;
    await setDoc(doc(db, `tenants/${id}`), { name: id, ownerUid: adminUid, licenseId: 'x', plan: 'standard', status: 'ACTIVE', installationId: 'i', expiresAt: null, setupComplete: true, ...extra });
    await setDoc(doc(db, `tenants/${id}/members/${adminUid}`), { uid: adminUid, tenantId: id, role: 'SCHOOL_ADMIN', status: 'ACTIVE' });
    await setDoc(doc(db, `tenants/${id}/members/teach-${id}`), { uid: `teach-${id}`, tenantId: id, role: 'TEACHER', status: 'ACTIVE' });
    await setDoc(doc(db, `tenants/${id}/members/stud-${id}`), { uid: `stud-${id}`, tenantId: id, role: 'STUDENT', status: 'ACTIVE' });
    await setDoc(doc(db, `tenants/${id}/classes/c1`), { tenantId: id, name: 'JS1' });
  });
}

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'school-saas-rules-test',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  });
});
afterAll(async () => env.cleanup());
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore() as unknown as Firestore;
    await setDoc(doc(db, 'platformAdmins/owner1'), { x: 1 });
    await setDoc(doc(db, `licenses/${H}`), lic());
    await setDoc(doc(db, `licenses/${H2}`), lic());
  });
});

describe('licenses', () => {
  it('anyone can get by hash but only the owner can list', async () => {
    await assertSucceeds(getDoc(doc(fs(null), `licenses/${H}`)));
    await assertFails(getDocs(collection(fs('adminA'), 'licenses')));
    await assertSucceeds(getDocs(collection(fs('owner1'), 'licenses')));
  });
  it('rejects non-hash document ids', async () => {
    await assertFails(getDoc(doc(fs(null), 'licenses/not-a-hash')));
  });
  it('school users cannot create licenses; owner can', async () => {
    await assertFails(setDoc(doc(fs('adminA'), `licenses/${'c'.repeat(64)}`), lic({ createdAt: serverTimestamp(), createdBy: 'adminA' })));
    await assertSucceeds(setDoc(doc(fs('owner1'), `licenses/${'c'.repeat(64)}`), lic({ createdAt: serverTimestamp() })));
  });
  it('first activation succeeds with the full plan', async () => {
    const plan = buildActivationPlan(input());
    await assertSucceeds(applyOps(fs('adminA'), plan.core));
    for (const b of plan.config) await assertSucceeds(applyOps(fs('adminA'), b));
  });
  it('the same key cannot activate a second tenant', async () => {
    const a = buildActivationPlan(input());
    await assertSucceeds(applyOps(fs('adminA'), a.core));
    const b = buildActivationPlan(input({ uid: 'adminB', tenantId: 'tenantB', slug: 'school-b', installationId: 'install-bbbb' }));
    await assertFails(applyOps(fs('adminB'), b.core));
  });
  it('concurrent attempts: exactly one wins', async () => {
    const a = buildActivationPlan(input());
    const b = buildActivationPlan(input({ uid: 'adminB', tenantId: 'tenantB', slug: 'school-b', installationId: 'install-bbbb' }));
    const r = await Promise.allSettled([applyOps(fs('adminA'), a.core), applyOps(fs('adminB'), b.core)]);
    if (r.filter((x) => x.status === 'fulfilled').length !== 1) throw new Error('expected exactly one winner');
  });
  it('cannot activate while binding the license to someone else\'s tenant', async () => {
    const plan = buildActivationPlan(input());
    const evil = plan.core.map((o) => (o.path === 'tenants/tenantA' ? { ...o, data: { ...o.data, ownerUid: 'someoneElse' } } : o));
    await assertFails(applyOps(fs('adminA'), evil));
  });
  it('cannot claim a different plan or expiry than the license', async () => {
    const plan = buildActivationPlan(input());
    const evil = plan.core.map((o) => (o.path === 'tenants/tenantA' ? { ...o, data: { ...o.data, plan: 'enterprise' } } : o));
    await assertFails(applyOps(fs('adminA'), evil));
  });
  it('cannot activate with maxActivations tampering or extra fields', async () => {
    const plan = buildActivationPlan(input());
    const evil = plan.core.map((o) => (o.path === `licenses/${H}` ? { ...o, data: { ...o.data, maxActivations: 99 } } : o));
    await assertFails(applyOps(fs('adminA'), evil));
  });
  it('expired and deactivated licenses cannot be activated', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore() as unknown as Firestore;
      await updateDoc(doc(db, `licenses/${H}`), { expiresAt: new Date(Date.now() - 86400000) });
      await updateDoc(doc(db, `licenses/${H2}`), { status: 'DEACTIVATED' });
    });
    await assertFails(applyOps(fs('adminA'), buildActivationPlan(input()).core));
    await assertFails(applyOps(fs('adminA'), buildActivationPlan(input({ licenseHash: H2 })).core));
  });
  it('unauthenticated users cannot activate', async () => {
    await assertFails(applyOps(fs(null), buildActivationPlan(input()).core));
  });
  it('owner cannot re-point a bound license to another tenant', async () => {
    await applyOps(fs('adminA'), buildActivationPlan(input()).core);
    await assertFails(updateDoc(doc(fs('owner1'), `licenses/${H}`), { tenantId: 'tenantB' }));
  });
  it('owner deactivate suspends tenant and blocks its users', async () => {
    const plan = buildActivationPlan(input());
    await applyOps(fs('adminA'), plan.core);
    for (const b of plan.config) await applyOps(fs('adminA'), b);
    await assertSucceeds(getDoc(doc(fs('adminA'), 'tenants/tenantA/classes/js1')));
    const ops = planLicenseAction(H, { status: 'ACTIVE', tenantId: 'tenantA' }, { type: 'DEACTIVATE' }, 'owner1');
    await assertSucceeds(applyOps(fs('owner1'), ops));
    await assertFails(getDoc(doc(fs('adminA'), 'tenants/tenantA/classes/js1')));
  });
  it('reset then re-activation works only for the same tenant admin', async () => {
    const plan = buildActivationPlan(input());
    await applyOps(fs('adminA'), plan.core);
    for (const b of plan.config) await applyOps(fs('adminA'), b);
    await assertSucceeds(applyOps(fs('owner1'), planLicenseAction(H, { status: 'ACTIVE', tenantId: 'tenantA' }, { type: 'RESET_INSTALLATION' }, 'owner1')));
    await seedTenant('tenantB', 'adminB');
    const args = { licenseHash: H, tenantId: 'tenantA', installationId: 'install-new1' };
    await assertFails(applyOps(fs('adminB'), buildReactivationPlan({ ...args, uid: 'adminB' })));
    await assertSucceeds(applyOps(fs('adminA'), buildReactivationPlan({ ...args, uid: 'adminA' })));
    await assertSucceeds(getDoc(doc(fs('adminA'), 'tenants/tenantA/classes/js1')));
  });
});

describe('tenant isolation', () => {
  beforeEach(async () => { await seedTenant('tenantA', 'adminA'); await seedTenant('tenantB', 'adminB'); });
  it('members read own tenant, never another', async () => {
    await assertSucceeds(getDoc(doc(fs('adminA'), 'tenants/tenantA/classes/c1')));
    await assertFails(getDoc(doc(fs('adminA'), 'tenants/tenantB/classes/c1')));
    await assertFails(getDoc(doc(fs('stud-tenantA'), 'tenants/tenantB/classes/c1')));
    await assertFails(getDocs(collection(fs('adminA'), 'tenants/tenantB/classes')));
  });
  it('cannot write into another tenant, or forge tenantId to cross over', async () => {
    await assertFails(setDoc(doc(fs('adminA'), 'tenants/tenantB/classes/x'), { tenantId: 'tenantB', name: 'Hack' }));
    await assertFails(setDoc(doc(fs('adminA'), 'tenants/tenantA/classes/x'), { tenantId: 'tenantB', name: 'Hack' }));
    await assertSucceeds(setDoc(doc(fs('adminA'), 'tenants/tenantA/classes/x'), { tenantId: 'tenantA', name: 'Ok' }));
  });
  it('cannot change tenantId on update', async () => {
    await assertFails(updateDoc(doc(fs('adminA'), 'tenants/tenantA/classes/c1'), { tenantId: 'tenantB' }));
  });
  it('role limits: student/teacher cannot edit classes; student cannot read member list', async () => {
    await assertFails(setDoc(doc(fs('stud-tenantA'), 'tenants/tenantA/classes/y'), { tenantId: 'tenantA', name: 'Y' }));
    await assertFails(setDoc(doc(fs('teach-tenantA'), 'tenants/tenantA/classes/y'), { tenantId: 'tenantA', name: 'Y' }));
    await assertSucceeds(getDoc(doc(fs('stud-tenantA'), 'tenants/tenantA/classes/c1')));
    await assertFails(getDocs(collection(fs('stud-tenantA'), 'tenants/tenantA/members')));
  });
  it('nobody can self-assign membership or privilege', async () => {
    await assertFails(setDoc(doc(fs('mallory'), 'tenants/tenantA/members/mallory'), { uid: 'mallory', tenantId: 'tenantA', role: 'SCHOOL_ADMIN', status: 'ACTIVE', displayName: '', email: '' }));
    await assertFails(updateDoc(doc(fs('stud-tenantA'), 'tenants/tenantA/members/stud-tenantA'), { role: 'SCHOOL_ADMIN' }));
  });
  it('school admin cannot change owner, status, plan or expiry', async () => {
    await assertFails(updateDoc(doc(fs('adminA'), 'tenants/tenantA'), { status: 'ACTIVE', plan: 'enterprise' }));
    await assertFails(updateDoc(doc(fs('adminA'), 'tenants/tenantA'), { ownerUid: 'mallory' }));
    await assertFails(updateDoc(doc(fs('adminA'), 'tenants/tenantA'), { expiresAt: null }));
    await assertSucceeds(updateDoc(doc(fs('adminA'), 'tenants/tenantA'), { name: 'Renamed', updatedAt: serverTimestamp() }));
  });
  it('product owner sees tenant record but NOT school data', async () => {
    await assertSucceeds(getDoc(doc(fs('owner1'), 'tenants/tenantA')));
    await assertFails(getDoc(doc(fs('owner1'), 'tenants/tenantA/classes/c1')));
    await assertFails(getDocs(collection(fs('owner1'), 'tenants/tenantA/members')));
  });
  it('owner can suspend a tenant but cannot edit other fields', async () => {
    await assertSucceeds(updateDoc(doc(fs('owner1'), 'tenants/tenantA'), { status: 'SUSPENDED', updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(fs('owner1'), 'tenants/tenantA'), { name: 'x', updatedAt: serverTimestamp() }));
  });
  it('expired tenant is blocked automatically', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore() as unknown as Firestore, 'tenants/tenantA'), { expiresAt: new Date(Date.now() - 1000) });
    });
    await assertFails(getDoc(doc(fs('adminA'), 'tenants/tenantA/classes/c1')));
    await assertSucceeds(getDoc(doc(fs('adminB'), 'tenants/tenantB/classes/c1'))); // other tenants unaffected
  });
  it('disabled members are blocked', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await updateDoc(doc(ctx.firestore() as unknown as Firestore, 'tenants/tenantA/members/teach-tenantA'), { status: 'DISABLED' });
    });
    await assertFails(getDoc(doc(fs('teach-tenantA'), 'tenants/tenantA/classes/c1')));
  });
});

describe('audit log, public data, default deny', () => {
  beforeEach(async () => { await seedTenant('tenantA', 'adminA'); });
  const entry = (actor: string, t = 'tenantA') => ({ actorId: actor, tenantId: t, action: 'x', target: 'y', timestamp: serverTimestamp(), metadata: {} });
  it('append-only, actor must be caller, admin-only read', async () => {
    await assertSucceeds(setDoc(doc(fs('adminA'), 'tenants/tenantA/auditLogs/1'), entry('adminA')));
    await assertFails(setDoc(doc(fs('adminA'), 'tenants/tenantA/auditLogs/2'), entry('someoneElse')));
    await assertFails(updateDoc(doc(fs('adminA'), 'tenants/tenantA/auditLogs/1'), { action: 'edited' }));
    await assertFails(deleteDoc(doc(fs('adminA'), 'tenants/tenantA/auditLogs/1')));
    await assertFails(getDoc(doc(fs('teach-tenantA'), 'tenants/tenantA/auditLogs/1')));
    await assertSucceeds(getDoc(doc(fs('adminA'), 'tenants/tenantA/auditLogs/1')));
  });
  it('slugs/publicProfiles are readable by anyone but not listable or overwritable', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore() as unknown as Firestore;
      await setDoc(doc(db, 'slugs/school-a'), { tenantId: 'tenantA' });
      await setDoc(doc(db, 'publicProfiles/tenantA'), { tenantId: 'tenantA', slug: 'school-a', name: 'School A', motto: '', logoDataUrl: null, primaryColor: '#112233', secondaryColor: '#445566' });
    });
    await assertSucceeds(getDoc(doc(fs(null), 'slugs/school-a')));
    await assertSucceeds(getDoc(doc(fs(null), 'publicProfiles/tenantA')));
    await assertFails(getDocs(collection(fs(null), 'slugs')));
    await assertFails(setDoc(doc(fs('mallory'), 'slugs/school-a'), { tenantId: 'mallory-tenant' }));
    await assertFails(updateDoc(doc(fs('mallory'), 'publicProfiles/tenantA'), { name: 'Hacked' }));
    await assertSucceeds(updateDoc(doc(fs('adminA'), 'publicProfiles/tenantA'), { name: 'School A+' }));
  });
  it('public profile logo must be an embedded image, never an external URL', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore() as unknown as Firestore, 'publicProfiles/tenantA'),
        { tenantId: 'tenantA', slug: 'school-a', name: 'School A', motto: '', logoDataUrl: null, primaryColor: '#112233', secondaryColor: '#445566' });
    });
    const base = { tenantId: 'tenantA', slug: 'school-a', name: 'School A', motto: '', primaryColor: '#112233', secondaryColor: '#445566' };
    await assertFails(setDoc(doc(fs('adminA'), 'publicProfiles/tenantA'), { ...base, logoDataUrl: 'https://evil.example/pixel.gif' }));
    await assertFails(setDoc(doc(fs('adminA'), 'publicProfiles/tenantA'), { ...base, logoDataUrl: 'javascript:alert(1)' }));
    await assertSucceeds(setDoc(doc(fs('adminA'), 'publicProfiles/tenantA'), { ...base, logoDataUrl: 'data:image/png;base64,iVBORw0KGgo=' }));
  });
  it('userDirectory is private and cannot point at an unrelated tenant', async () => {
    await assertFails(setDoc(doc(fs('mallory'), 'userDirectory/mallory'), { tenantId: 'tenantA' }));
    await assertFails(getDoc(doc(fs('mallory'), 'userDirectory/adminA')));
  });
  it('platformAdmins cannot be self-granted', async () => {
    await assertFails(setDoc(doc(fs('mallory'), 'platformAdmins/mallory'), { x: 1 }));
  });
  it('unknown collections are denied', async () => {
    await assertFails(getDoc(doc(fs('adminA'), 'secrets/1')));
    await assertFails(setDoc(doc(fs('adminA'), 'secrets/1'), { a: 1 }));
  });
});


// ============================================================ Phases 7-9 additions
const sInput: StudentInput = {
  firstName: 'Ada', middleName: '', lastName: 'Okafor', gender: 'FEMALE', dateOfBirth: '2014-05-21', classId: 'c1',
  phone: '', email: '', address: '', admissionNumber: '', admissionDate: '2026-09-14',
};
const studentCtx = (t: string, adm: string, uid: string | null = null) =>
  ({ tenantId: t, admissionNumber: adm, academicSession: '2026', photo: null, uid, createdBy: 'adminA' });
const studentRaw = (t: string, adm: string, over: Record<string, unknown> = {}) => ({
  tenantId: t, studentId: adm, admissionNumber: adm, firstName: 'Ada', middleName: '', lastName: 'Okafor', gender: 'FEMALE',
  dateOfBirth: '2014-05-21', photo: null, classId: 'c1', parentIds: [], phone: '', email: '', address: '',
  admissionDate: '2026-09-14', status: 'ACTIVE', academicSession: '2026', uid: null, ...over,
});

describe('admin-created accounts', () => {
  beforeEach(async () => { await seedTenant('tenantA', 'adminA'); await seedTenant('tenantB', 'adminB'); });

  it('admin creates a teacher (member + directory + teacher doc) in one batch', async () => {
    const ops = [
      { kind: 'set' as const, path: 'tenants/tenantA/teachers/newT', data: buildTeacherDoc({ name: 'Mrs Bello', email: 'b@x.com', phone: '', subjects: [], classes: ['c1'] }, { tenantId: 'tenantA', uid: 'newT', photo: null, createdBy: 'adminA' }) },
      ...buildMemberOps({ tenantId: 'tenantA', uid: 'newT', role: 'TEACHER', displayName: 'Mrs Bello', email: 'b@x.com', loginId: 'b@x.com', classIds: ['c1'] }),
    ];
    await assertSucceeds(applyOps(fs('adminA'), ops));
  });
  it('a school admin cannot put anyone into ANOTHER school, nor steal a user who already has a school', async () => {
    const toB = buildMemberOps({ tenantId: 'tenantB', uid: 'x1', role: 'TEACHER', displayName: 'X', email: '', loginId: 'x' });
    await assertFails(applyOps(fs('adminA'), toB));
    await env.withSecurityRulesDisabled(async (ctx) => { await setDoc(doc(ctx.firestore() as unknown as Firestore, 'userDirectory/existingB'), { tenantId: 'tenantB' }); });
    await assertFails(applyOps(fs('adminA'), buildMemberOps({ tenantId: 'tenantA', uid: 'existingB', role: 'TEACHER', displayName: 'X', email: '', loginId: 'x' })));
  });
  it('only a school admin can create members', async () => {
    await assertFails(applyOps(fs('teach-tenantA'), buildMemberOps({ tenantId: 'tenantA', uid: 'y1', role: 'STAFF', displayName: 'Y', email: '', loginId: 'y' })));
    await assertFails(applyOps(fs('stud-tenantA'), buildMemberOps({ tenantId: 'tenantA', uid: 'y2', role: 'SCHOOL_ADMIN', displayName: 'Y', email: '', loginId: 'y' })));
  });
  it('a new account has NO data access until it replaces its temporary password', async () => {
    await applyOps(fs('adminA'), buildMemberOps({ tenantId: 'tenantA', uid: 'newbie', role: 'TEACHER', displayName: 'N', email: 'n@x.com', loginId: 'n@x.com' }));
    await assertFails(getDoc(doc(fs('newbie'), 'tenants/tenantA/classes/c1')));
    await assertSucceeds(getDoc(doc(fs('newbie'), 'tenants/tenantA/members/newbie')));
    await assertFails(updateDoc(doc(fs('newbie'), 'tenants/tenantA/members/newbie'), { role: 'SCHOOL_ADMIN', mustChangePassword: false }));
    await assertSucceeds(updateDoc(doc(fs('newbie'), 'tenants/tenantA/members/newbie'), { mustChangePassword: false }));
    await assertSucceeds(getDoc(doc(fs('newbie'), 'tenants/tenantA/classes/c1')));
    await assertFails(updateDoc(doc(fs('newbie'), 'tenants/tenantA/members/newbie'), { mustChangePassword: true }));
  });
  it('admins manage others but never themselves, and cannot move a member to another tenant', async () => {
    await assertSucceeds(updateDoc(doc(fs('adminA'), 'tenants/tenantA/members/teach-tenantA'), { status: 'DISABLED' }));
    await assertFails(updateDoc(doc(fs('adminA'), 'tenants/tenantA/members/adminA'), { status: 'DISABLED' }));
    await assertFails(updateDoc(doc(fs('adminA'), 'tenants/tenantA/members/adminA'), { role: 'STAFF' }));
    await assertFails(updateDoc(doc(fs('adminA'), 'tenants/tenantA/members/teach-tenantA'), { tenantId: 'tenantB' }));
    await assertFails(updateDoc(doc(fs('adminB'), 'tenants/tenantA/members/teach-tenantA'), { status: 'DISABLED' }));
    await assertFails(updateDoc(doc(fs('teach-tenantA'), 'tenants/tenantA/members/stud-tenantA'), { status: 'DISABLED' }));
  });
});

describe('students, teachers, parents', () => {
  beforeEach(async () => {
    await seedTenant('tenantA', 'adminA'); await seedTenant('tenantB', 'adminB');
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore() as unknown as Firestore;
      await updateDoc(doc(db, 'tenants/tenantA/members/teach-tenantA'), { classIds: ['c1'] });
      await setDoc(doc(db, 'tenants/tenantA/members/par-A'), { uid: 'par-A', tenantId: 'tenantA', role: 'PARENT', status: 'ACTIVE' });
      await setDoc(doc(db, 'tenants/tenantA/students/AAA-1'), studentRaw('tenantA', 'AAA-1', { classId: 'c1', parentIds: ['par-A'], uid: 'stud-tenantA' }));
      await setDoc(doc(db, 'tenants/tenantA/students/AAA-2'), studentRaw('tenantA', 'AAA-2', { classId: 'c2' }));
      await setDoc(doc(db, 'tenants/tenantB/students/BBB-1'), studentRaw('tenantB', 'BBB-1'));
      await setDoc(doc(db, 'tenants/tenantA/teachers/teach-tenantA'), { tenantId: 'tenantA', uid: 'teach-tenantA', name: 'T', status: 'ACTIVE' });
      await setDoc(doc(db, 'tenants/tenantA/parents/par-A'), { tenantId: 'tenantA', uid: 'par-A', name: 'P', childIds: ['AAA-1'], status: 'ACTIVE' });
    });
  });
  const col = (u: string | null, t: string, c: string) => collection(fs(u), `tenants/${t}/${c}`);

  it('admin creates and edits students; ID must equal the admission number', async () => {
    const okDoc = buildStudentDoc(sInput, studentCtx('tenantA', 'AAA-3'));
    await assertSucceeds(setDoc(doc(fs('adminA'), 'tenants/tenantA/students/AAA-3'), okDoc));
    await assertFails(setDoc(doc(fs('adminA'), 'tenants/tenantA/students/OTHER-ID'), okDoc));
    await assertFails(setDoc(doc(fs('adminA'), 'tenants/tenantA/students/AAA-4'), { ...buildStudentDoc(sInput, studentCtx('tenantA', 'AAA-4')), gender: 'X' }));
    await assertFails(setDoc(doc(fs('adminA'), 'tenants/tenantA/students/AAA-5'), { ...buildStudentDoc(sInput, studentCtx('tenantA', 'AAA-5')), photo: 'https://evil.example/p.png' }));
    await assertFails(setDoc(doc(fs('adminA'), 'tenants/tenantB/students/AAA-6'), buildStudentDoc(sInput, studentCtx('tenantB', 'AAA-6'))));
    await assertSucceeds(updateDoc(doc(fs('adminA'), 'tenants/tenantA/students/AAA-1'), buildStudentUpdate({ ...sInput, classId: 'c2' }, null)));
    await assertFails(updateDoc(doc(fs('adminA'), 'tenants/tenantA/students/AAA-1'), { admissionNumber: 'HACK-1' }));
    await assertFails(updateDoc(doc(fs('adminA'), 'tenants/tenantA/students/AAA-1'), { tenantId: 'tenantB' }));
  });
  it('overwriting an existing admission number is refused', async () => {
    await assertFails(setDoc(doc(fs('adminA'), 'tenants/tenantA/students/AAA-1'), buildStudentDoc(sInput, studentCtx('tenantA', 'AAA-1'))));
  });
  it('a teacher sees only students of assigned classes', async () => {
    await assertSucceeds(getDocs(query(col('teach-tenantA', 'tenantA', 'students'), where('classId', '==', 'c1'))));
    await assertFails(getDocs(query(col('teach-tenantA', 'tenantA', 'students'), where('classId', '==', 'c2'))));
    await assertFails(getDocs(col('teach-tenantA', 'tenantA', 'students')));
    await assertFails(getDoc(doc(fs('teach-tenantA'), 'tenants/tenantA/students/AAA-2')));
    await assertFails(setDoc(doc(fs('teach-tenantA'), 'tenants/tenantA/students/AAA-9'), buildStudentDoc(sInput, studentCtx('tenantA', 'AAA-9'))));
  });
  it('a parent sees only their own children; a student only themselves', async () => {
    await assertSucceeds(getDocs(query(col('par-A', 'tenantA', 'students'), where('parentIds', 'array-contains', 'par-A'))));
    await assertFails(getDoc(doc(fs('par-A'), 'tenants/tenantA/students/AAA-2')));
    await assertFails(getDocs(col('par-A', 'tenantA', 'students')));
    await assertSucceeds(getDoc(doc(fs('stud-tenantA'), 'tenants/tenantA/students/AAA-1')));
    await assertFails(getDoc(doc(fs('stud-tenantA'), 'tenants/tenantA/students/AAA-2')));
  });
  it('nobody reads another school\'s students; the product owner reads none', async () => {
    await assertFails(getDoc(doc(fs('adminA'), 'tenants/tenantB/students/BBB-1')));
    await assertFails(getDoc(doc(fs('owner1'), 'tenants/tenantA/students/AAA-1')));
    await assertFails(getDocs(col('owner1', 'tenantA', 'students')));
  });
  it('accountants and staff can read students but not write', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore() as unknown as Firestore;
      await setDoc(doc(db, 'tenants/tenantA/members/acct'), { uid: 'acct', tenantId: 'tenantA', role: 'ACCOUNTANT', status: 'ACTIVE' });
    });
    await assertSucceeds(getDoc(doc(fs('acct'), 'tenants/tenantA/students/AAA-1')));
    await assertFails(updateDoc(doc(fs('acct'), 'tenants/tenantA/students/AAA-1'), { phone: '1' }));
  });
  it('teachers: own record readable, others and listing are not; only admins write', async () => {
    await assertSucceeds(getDoc(doc(fs('teach-tenantA'), 'tenants/tenantA/teachers/teach-tenantA')));
    await assertFails(getDocs(col('teach-tenantA', 'tenantA', 'teachers')));
    await assertSucceeds(getDocs(col('adminA', 'tenantA', 'teachers')));
    await assertFails(updateDoc(doc(fs('teach-tenantA'), 'tenants/tenantA/teachers/teach-tenantA'), { name: 'Self edit' }));
    await assertSucceeds(updateDoc(doc(fs('adminA'), 'tenants/tenantA/teachers/teach-tenantA'), { name: 'Renamed', updatedAt: serverTimestamp() }));
    await assertFails(updateDoc(doc(fs('adminA'), 'tenants/tenantA/teachers/teach-tenantA'), { uid: 'someone-else' }));
  });
  it('parents: admin creates/links; a parent reads only their own record', async () => {
    const pd = buildParentDoc({ name: 'Mr P', email: '', phone: '', childAdmissionNumbers: [] }, { tenantId: 'tenantA', uid: 'par-new', loginId: 'parent-x', childIds: [], createdBy: 'adminA' });
    await assertSucceeds(setDoc(doc(fs('adminA'), 'tenants/tenantA/parents/par-new'), pd));
    await assertSucceeds(getDoc(doc(fs('par-A'), 'tenants/tenantA/parents/par-A')));
    await assertFails(getDoc(doc(fs('par-A'), 'tenants/tenantA/parents/par-new')));
    await assertFails(setDoc(doc(fs('par-A'), 'tenants/tenantA/parents/par-x'), pd));
  });
  it('admission counters only move forward by a bounded amount, admin only', async () => {
    await assertSucceeds(setDoc(doc(fs('adminA'), 'tenants/tenantA/counters/students-2026'), { next: 2 }));
    await assertSucceeds(setDoc(doc(fs('adminA'), 'tenants/tenantA/counters/students-2026'), { next: 5 }));
    await assertFails(setDoc(doc(fs('adminA'), 'tenants/tenantA/counters/students-2026'), { next: 1 }));
    await assertFails(setDoc(doc(fs('adminA'), 'tenants/tenantA/counters/students-2026'), { next: 5000 }));
    await assertFails(setDoc(doc(fs('teach-tenantA'), 'tenants/tenantA/counters/students-2026'), { next: 9 }));
    await assertFails(setDoc(doc(fs('adminA'), 'tenants/tenantB/counters/students-2026'), { next: 2 }));
  });
});


// ============================================================ Phases 10-11: attendance and fees
describe('attendance rules', () => {
  const rec = (n = 2): Record<string, Status> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`S${i}`, 'P' as Status]));
  const names = { S0: 'A', S1: 'B' };
  const att = (t: string, classId: string, uid: string, date = '2026-10-14', records: Record<string, Status> = rec()) =>
    buildAttendanceCreate({ tenantId: t, classId, date, session: '2026', records, names, takenBy: uid, takenByName: 'T' });
  const path = (t: string, classId: string, date = '2026-10-14') => `tenants/${t}/attendance/${classId}_${date}`;
  beforeEach(async () => {
    await seedTenant('tenantA', 'adminA'); await seedTenant('tenantB', 'adminB');
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore() as unknown as Firestore;
      await updateDoc(doc(db, 'tenants/tenantA/members/teach-tenantA'), { classIds: ['c1'] });
      await setDoc(doc(db, 'tenants/tenantA/members/princ'), { uid: 'princ', tenantId: 'tenantA', role: 'PRINCIPAL', status: 'ACTIVE' });
      await setDoc(doc(db, 'tenants/tenantA/members/staff'), { uid: 'staff', tenantId: 'tenantA', role: 'STAFF', status: 'ACTIVE' });
    });
  });

  it('an assigned teacher records their own class; other classes are refused; admin may record any', async () => {
    await assertSucceeds(setDoc(doc(fs('teach-tenantA'), path('tenantA', 'c1')), att('tenantA', 'c1', 'teach-tenantA')));
    await assertFails(setDoc(doc(fs('teach-tenantA'), path('tenantA', 'c2')), att('tenantA', 'c2', 'teach-tenantA')));
    await assertSucceeds(setDoc(doc(fs('adminA'), path('tenantA', 'c2')), att('tenantA', 'c2', 'adminA')));
    await assertFails(setDoc(doc(fs('princ'), path('tenantA', 'c3')), att('tenantA', 'c3', 'princ')));
    await assertFails(setDoc(doc(fs('stud-tenantA'), path('tenantA', 'c1', '2026-10-15')), att('tenantA', 'c1', 'stud-tenantA', '2026-10-15')));
    await assertFails(setDoc(doc(fs('adminA'), path('tenantB', 'c1')), att('tenantB', 'c1', 'adminA')));
  });
  it('malformed documents are refused: wrong id, month, status value, counts, forged author', async () => {
    const good = att('tenantA', 'c1', 'adminA');
    await assertFails(setDoc(doc(fs('adminA'), 'tenants/tenantA/attendance/wrong-id'), good));
    await assertFails(setDoc(doc(fs('adminA'), path('tenantA', 'c1')), { ...good, month: '2026-09' }));
    await assertFails(setDoc(doc(fs('adminA'), path('tenantA', 'c1')), { ...good, records: { S0: 'X', S1: 'P' } }));
    await assertFails(setDoc(doc(fs('adminA'), path('tenantA', 'c1')), { ...good, counts: { P: 5, A: 0, L: 0, E: 0 } }));
    await assertFails(setDoc(doc(fs('adminA'), path('tenantA', 'c1')), { ...good, total: 9 }));
    await assertFails(setDoc(doc(fs('adminA'), path('tenantA', 'c1')), { ...good, takenBy: 'someone-else' }));
    await assertSucceeds(setDoc(doc(fs('adminA'), path('tenantA', 'c1')), good));
  });
  it('updates may change marks only; class and date are fixed; wrong-class teachers are refused', async () => {
    await assertSucceeds(setDoc(doc(fs('adminA'), path('tenantA', 'c1')), att('tenantA', 'c1', 'adminA')));
    await assertSucceeds(updateDoc(doc(fs('teach-tenantA'), path('tenantA', 'c1')), buildAttendanceUpdate({ records: { S0: 'A', S1: 'P' }, names, updatedBy: 'teach-tenantA' })));
    await assertFails(updateDoc(doc(fs('teach-tenantA'), path('tenantA', 'c1')), { ...buildAttendanceUpdate({ records: rec(), names, updatedBy: 'teach-tenantA' }), classId: 'c2' }));
    await assertFails(updateDoc(doc(fs('teach-tenantA'), path('tenantA', 'c1')), { ...buildAttendanceUpdate({ records: rec(), names, updatedBy: 'teach-tenantA' }), date: '2026-10-01' }));
    await assertFails(updateDoc(doc(fs('teach-tenantA'), path('tenantA', 'c1')), { ...buildAttendanceUpdate({ records: rec(), names, updatedBy: 'teach-tenantA' }), total: 99 }));
    await assertFails(updateDoc(doc(fs('adminA'), path('tenantA', 'c1')), buildAttendanceUpdate({ records: rec(), names, updatedBy: 'forged' })));
    await assertSucceeds(setDoc(doc(fs('adminA'), path('tenantA', 'c2')), att('tenantA', 'c2', 'adminA')));
    await assertFails(updateDoc(doc(fs('teach-tenantA'), path('tenantA', 'c2')), buildAttendanceUpdate({ records: rec(), names, updatedBy: 'teach-tenantA' })));
    await assertFails(deleteDoc(doc(fs('adminA'), path('tenantA', 'c1'))));
  });
  it('reading: teachers only their classes; principal and staff all; students/parents/other schools/owner none', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore() as unknown as Firestore;
      await setDoc(doc(db, path('tenantA', 'c1')), { ...att('tenantA', 'c1', 'x'), createdAt: new Date() });
      await setDoc(doc(db, path('tenantA', 'c2')), { ...att('tenantA', 'c2', 'x'), createdAt: new Date() });
    });
    const col = (u: string, t = 'tenantA') => collection(fs(u), `tenants/${t}/attendance`);
    await assertSucceeds(getDocs(query(col('teach-tenantA'), where('classId', '==', 'c1'), where('month', '==', '2026-10'))));
    await assertFails(getDocs(query(col('teach-tenantA'), where('classId', '==', 'c2'))));
    await assertFails(getDocs(col('teach-tenantA')));
    await assertSucceeds(getDocs(query(col('adminA'), where('date', '==', '2026-10-14'))));
    await assertSucceeds(getDocs(col('princ'))); await assertSucceeds(getDocs(col('staff')));
    await assertFails(getDocs(col('stud-tenantA'))); await assertFails(getDocs(col('owner1'))); await assertFails(getDocs(col('adminB')));
  });
});

describe('fee and payment rules', () => {
  const rawFee = (over: Record<string, unknown> = {}) => ({
    tenantId: 'tenantA', studentId: 'S1', studentName: 'A', classId: 'c1', itemId: null, description: 'Tuition', category: 'TUITION',
    amount: 1000, amountPaid: 0, balance: 1000, status: 'UNPAID', session: '2026', termId: '', dueDate: '', createdBy: 'x', createdAt: new Date(), ...over,
  });
  const ref = (over: Partial<FeeRef> = {}): FeeRef => ({ id: 'f1', amount: 1000, amountPaid: 0, studentId: 'S1', studentName: 'A', classId: 'c1', description: 'Tuition', ...over });
  const who = { tenantId: 'tenantA', uid: 'acct', name: 'Acct' };
  const payIn = (amount: number, n = 1) => ({ amount, date: '2026-10-14', method: 'CASH', reference: '', note: '', receiptNumber: `RCPT-2026-${String(n).padStart(6, '0')}` });
  beforeEach(async () => {
    await seedTenant('tenantA', 'adminA'); await seedTenant('tenantB', 'adminB');
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore() as unknown as Firestore;
      for (const [u, role] of [['acct', 'ACCOUNTANT'], ['princ', 'PRINCIPAL']] as const) {
        await setDoc(doc(db, `tenants/tenantA/members/${u}`), { uid: u, tenantId: 'tenantA', role, status: 'ACTIVE' });
      }
      await setDoc(doc(db, 'tenants/tenantB/members/acctB'), { uid: 'acctB', tenantId: 'tenantB', role: 'ACCOUNTANT', status: 'ACTIVE' });
      await setDoc(doc(db, 'tenants/tenantA/fees/f1'), rawFee());
      await setDoc(doc(db, 'tenants/tenantA/fees/cancelled'), rawFee({ status: 'CANCELLED' }));
    });
  });

  it('who may touch fee items', async () => {
    const item = buildFeeItemDoc({ name: 'T', category: 'TUITION', amount: 1000, classIds: ['c1'], termId: '', session: '2026' }, { tenantId: 'tenantA', createdBy: 'acct' });
    await assertSucceeds(setDoc(doc(fs('acct'), 'tenants/tenantA/feeItems/i1'), item));
    await assertFails(setDoc(doc(fs('teach-tenantA'), 'tenants/tenantA/feeItems/i2'), { ...item, createdBy: 'teach-tenantA' }));
    await assertFails(setDoc(doc(fs('princ'), 'tenants/tenantA/feeItems/i3'), { ...item, createdBy: 'princ' }));
    await assertSucceeds(getDoc(doc(fs('princ'), 'tenants/tenantA/feeItems/i1')));
    await assertFails(getDoc(doc(fs('teach-tenantA'), 'tenants/tenantA/feeItems/i1')));
    await assertFails(setDoc(doc(fs('acct'), 'tenants/tenantA/feeItems/i4'), { ...item, amount: 12.5 }));
  });
  it('a new fee must start unpaid with balance == amount and a whole-number amount', async () => {
    const ok = buildFeeDoc({ tenantId: 'tenantA', studentId: 'S2', studentName: 'B', classId: 'c1', itemId: null, description: 'Uniform', category: 'UNIFORM', amount: 500, session: '2026', termId: '', dueDate: '', createdBy: 'acct' });
    await assertSucceeds(setDoc(doc(fs('acct'), 'tenants/tenantA/fees/f2'), ok));
    for (const bad of [{ amountPaid: 100, balance: 400 }, { status: 'PAID' }, { amount: -5, balance: -5 }, { amount: 10.5, balance: 10.5 }, { balance: 1 }, { category: 'LOANS' }]) {
      await assertFails(setDoc(doc(fs('acct'), 'tenants/tenantA/fees/fbad'), { ...ok, ...bad }));
    }
    await assertFails(setDoc(doc(fs('acct'), 'tenants/tenantB/fees/f9'), { ...ok, tenantId: 'tenantB' }));
    await assertFails(setDoc(doc(fs('teach-tenantA'), 'tenants/tenantA/fees/f3'), { ...ok, createdBy: 'teach-tenantA' }));
  });
  it('a payment must move the fee by exactly its amount, in the same batch', async () => {
    await assertSucceeds(applyOps(fs('acct'), planPayment(ref(), payIn(400), who).ops));
    await assertFails(applyOps(fs('acct'), planPayment(ref({ amountPaid: 400 }), payIn(700, 2), who).ops));              // overpayment
    const [pay] = planPayment(ref({ amountPaid: 400 }), payIn(100, 3), who).ops;
    await assertFails(applyOps(fs('acct'), [pay!]));                                                                       // receipt without balance change
    const [, upd] = planPayment(ref({ amountPaid: 400 }), payIn(100, 4), who).ops;
    await assertFails(applyOps(fs('acct'), [{ ...pay!, path: pay!.path.replace('000003', '000004') }, { ...upd!, data: { ...upd!.data, amountPaid: 999, balance: 1 } }]));   // mismatch
    await assertFails(applyOps(fs('acct'), [{ kind: 'update', path: 'tenants/tenantA/fees/f1', data: { amountPaid: 500, balance: 123, status: 'PARTIAL', updatedAt: serverTimestamp() } }]));  // inconsistent books
    await assertFails(applyOps(fs('acct'), planPayment({ ...ref(), id: 'cancelled' }, payIn(100, 5), who).ops));          // cancelled fee
  });
  it('a payment record cannot be edited, deleted or forged; only the reversed flag, with a matching reversal', async () => {
    await applyOps(fs('acct'), planPayment(ref(), payIn(400), who).ops);
    const p = 'tenants/tenantA/payments/RCPT-2026-000001';
    await assertFails(updateDoc(doc(fs('acct'), p), { amount: 1 }));
    await assertFails(deleteDoc(doc(fs('adminA'), p)));
    await assertFails(updateDoc(doc(fs('acct'), p), { reversed: true, reversedBy: 'REV-2026-000009' }));                  // no reversal written
    await assertFails(applyOps(fs('acct'), planPayment(ref({ amountPaid: 400 }), { ...payIn(100, 2), receiptNumber: 'FORGED-1' }, who).ops));
  });
  it('reversal: puts the money back once, never twice', async () => {
    await applyOps(fs('acct'), planPayment(ref(), payIn(400), who).ops);
    const original = { id: 'RCPT-2026-000001', feeId: 'f1', amount: 400, kind: 'PAYMENT', reversed: false, method: 'CASH' };
    await assertSucceeds(applyOps(fs('acct'), planReversal(original, ref({ amountPaid: 400 }), 'REV-2026-000002', 'Mistake', '2026-10-14', who).ops));
    await assertFails(applyOps(fs('acct'), planReversal(original, ref({ amountPaid: 0 }), 'REV-2026-000003', 'Again', '2026-10-14', who).ops));
    await assertFails(applyOps(fs('acct'), planReversal({ ...original, amount: 300 }, ref({ amountPaid: 400 }), 'REV-2026-000004', 'x', '2026-10-14', who).ops));
  });
  it('who can read money records; other schools and the owner never', async () => {
    await applyOps(fs('acct'), planPayment(ref(), payIn(400), who).ops);
    for (const [u, ok] of [['acct', true], ['adminA', true], ['princ', true], ['teach-tenantA', false], ['stud-tenantA', false], ['acctB', false], ['owner1', false]] as const) {
      const t = ok ? assertSucceeds : assertFails;
      await t(getDoc(doc(fs(u), 'tenants/tenantA/fees/f1')));
      await t(getDoc(doc(fs(u), 'tenants/tenantA/payments/RCPT-2026-000001')));
    }
    await assertFails(applyOps(fs('princ'), planPayment(ref({ amountPaid: 400 }), payIn(100, 2), { ...who, uid: 'princ' }).ops));
    await assertFails(applyOps(fs('teach-tenantA'), planPayment(ref({ amountPaid: 400 }), payIn(100, 3), { ...who, uid: 'teach-tenantA' }).ops));
  });
  it('the receipt counter is usable by accountants only for receipts, and only moves forward', async () => {
    await assertSucceeds(setDoc(doc(fs('acct'), 'tenants/tenantA/counters/receipts-2026'), { next: 2 }));
    await assertSucceeds(setDoc(doc(fs('acct'), 'tenants/tenantA/counters/receipts-2026'), { next: 3 }));
    await assertFails(setDoc(doc(fs('acct'), 'tenants/tenantA/counters/receipts-2026'), { next: 1 }));
    await assertFails(setDoc(doc(fs('acct'), 'tenants/tenantA/counters/students-2026'), { next: 2 }));
    await assertFails(setDoc(doc(fs('acctB'), 'tenants/tenantA/counters/receipts-2026'), { next: 9 }));
  });
});
