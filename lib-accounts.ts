import { serverTimestamp } from 'firebase/firestore';
import { secureRandomBytes, type RandomBytes } from './lib-license';
import type { Op } from './lib-ops';
import type { Role } from './types';

/** `.invalid` is reserved (RFC 2606): these addresses can never collide with a real mailbox. */
export const SYNTHETIC_SUFFIX = 'login.invalid';

export function cleanLoginId(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/** Maps a username (no '@') to the school's private synthetic email. */
export function usernameToEmail(username: string, slug: string): string {
  return `${cleanLoginId(username)}@${slug}.${SYNTHETIC_SUFFIX}`;
}

/** Real email addresses are used as typed; anything else is treated as a username. */
export function loginIdToEmail(input: string, slug: string): string {
  const v = input.trim();
  return v.includes('@') ? v : usernameToEmail(v, slug);
}

export function isSyntheticEmail(email: string): boolean {
  return email.toLowerCase().endsWith(`.${SYNTHETIC_SUFFIX}`);
}

// 56 symbols, no look-alikes (0/O, 1/l/I).
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';

/** Unbiased random string via rejection sampling. */
export function randomString(alphabet: string, length: number, rng: RandomBytes = secureRandomBytes): string {
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    for (const b of rng(length * 2)) {
      if (b < limit) {
        out += alphabet[b % alphabet.length];
        if (out.length === length) break;
      }
    }
  }
  return out;
}

export function generatePassword(rng: RandomBytes = secureRandomBytes): string {
  return randomString(PASSWORD_ALPHABET, 12, rng);
}

export interface MemberSpec {
  tenantId: string;
  uid: string;
  role: Role;
  displayName: string;
  email: string; // real email or '' when username-only
  loginId: string; // what the person types to sign in
  classIds?: string[];
  subjectIds?: string[];
}

/**
 * Member + directory MUST be in the same batch: the directory rule requires the member to exist
 * "after" the write, and a user already placed in another school makes the whole batch fail.
 */
export function buildMemberOps(m: MemberSpec): Op[] {
  const member: Record<string, unknown> = {
    uid: m.uid,
    tenantId: m.tenantId,
    role: m.role,
    status: 'ACTIVE',
    displayName: m.displayName,
    email: m.email,
    loginId: m.loginId,
    mustChangePassword: true,
  };
  if (m.classIds) member.classIds = m.classIds;
  if (m.subjectIds) member.subjectIds = m.subjectIds;
  return [
    { kind: 'set', path: `tenants/${m.tenantId}/members/${m.uid}`, data: member },
    { kind: 'set', path: `userDirectory/${m.uid}`, data: { tenantId: m.tenantId } },
  ];
}

export function auditOp(
  tenantId: string, actorId: string, id: string, action: string, target: string,
  metadata: Record<string, string | number | boolean | null> = {},
): Op {
  return {
    kind: 'set',
    path: `tenants/${tenantId}/auditLogs/${id}`,
    data: { actorId, tenantId, action, target, timestamp: serverTimestamp(), metadata },
  };
}
