import type { Role } from './types';

/**
 * Role -> permission matrix. This drives what the UI shows. The authoritative
 * enforcement is firestore.rules; a test keeps the two aligned.
 */
export type Permission =
  | 'academics.manage' | 'students.read' | 'students.write' | 'teachers.read' | 'teachers.manage'
  | 'parents.manage' | 'users.manage' | 'settings.manage' | 'import.run' | 'classes.viewAssigned';

const ADMIN: Permission[] = [
  'academics.manage', 'students.read', 'students.write', 'teachers.read', 'teachers.manage',
  'parents.manage', 'users.manage', 'settings.manage', 'import.run',
];

export const PERMISSIONS: Record<Role, Permission[]> = {
  SCHOOL_ADMIN: ADMIN,
  PRINCIPAL: ['academics.manage', 'students.read', 'teachers.read'],
  TEACHER: ['classes.viewAssigned'],
  ACCOUNTANT: ['students.read'],
  STAFF: ['students.read', 'teachers.read'],
  STUDENT: [],
  PARENT: [],
};

export function can(role: Role | undefined | null, p: Permission): boolean {
  return role ? PERMISSIONS[role].includes(p) : false;
}

export interface NavItem { to: string; label: string; perm: Permission | null }

/** perm === null means every signed-in member sees it. */
export const NAV: NavItem[] = [
  { to: '', label: 'Overview', perm: null },
  { to: 'academics', label: 'Academics', perm: 'academics.manage' },
  { to: 'students', label: 'Students', perm: 'students.read' },
  { to: 'teachers', label: 'Teachers', perm: 'teachers.read' },
  { to: 'parents', label: 'Parents', perm: 'parents.manage' },
  { to: 'my-classes', label: 'My classes', perm: 'classes.viewAssigned' },
  { to: 'users', label: 'Users', perm: 'users.manage' },
  { to: 'import', label: 'Import', perm: 'import.run' },
  { to: 'settings', label: 'Settings', perm: 'settings.manage' },
];

export function navFor(role: Role | undefined | null): NavItem[] {
  return NAV.filter((n) => n.perm === null || can(role, n.perm));
}
