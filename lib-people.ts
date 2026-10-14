import { serverTimestamp } from 'firebase/firestore';
import type { Gender, StudentStatus } from './types';

export const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
export const isValidPhone = (v: string) => v === '' || /^[+0-9][0-9 ()-]{5,19}$/.test(v);
export const isValidAdmissionNumber = (v: string) => /^[A-Za-z0-9-]{3,30}$/.test(v);

/** Real calendar date in YYYY-MM-DD form (rejects 2026-02-30). */
export function isValidIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function todayIso(now = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

export function isValidBirthDate(v: string, now = new Date()): boolean {
  if (!isValidIsoDate(v)) return false;
  const year = Number(v.slice(0, 4));
  return v <= todayIso(now) && year >= now.getFullYear() - 100;
}

/** "Royal Scholars Academy" -> "RSA"; falls back to "SCH". */
export function defaultAdmissionPrefix(schoolName: string): string {
  const initials = schoolName
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/['\u2019`]/g, '') // "Scholar's" is one word, not "Scholar" + "s"
    .split(/[^A-Za-z0-9]+/).filter(Boolean)
    .filter((w) => !['of', 'the', 'and', 'for'].includes(w.toLowerCase()))
    .map((w) => w[0]!.toUpperCase()).join('').slice(0, 5);
  return initials.length >= 2 ? initials : 'SCH';
}

export function formatAdmissionNumber(prefix: string, year: number, n: number): string {
  return `${prefix}-${year}-${String(n).padStart(4, '0')}`;
}

export const GENDERS: Gender[] = ['MALE', 'FEMALE'];
export const STUDENT_STATUSES: StudentStatus[] = ['ACTIVE', 'INACTIVE', 'GRADUATED', 'TRANSFERRED'];
const trim = (v: string) => v.trim().replace(/\s+/g, ' ');

// ------------------------------------------------------------------ students
export interface StudentInput {
  firstName: string; middleName: string; lastName: string;
  gender: string; dateOfBirth: string; classId: string;
  phone: string; email: string; address: string;
  admissionNumber: string; // '' = auto-generate
  admissionDate: string;
}

export type FieldErrors = Record<string, string>;

export function validateStudent(i: StudentInput, activeClassIds: ReadonlySet<string>, now = new Date()): FieldErrors {
  const e: FieldErrors = {};
  if (!trim(i.firstName)) e.firstName = 'Enter the first name.';
  else if (trim(i.firstName).length > 60) e.firstName = 'Too long (max 60).';
  if (trim(i.middleName).length > 60) e.middleName = 'Too long (max 60).';
  if (!trim(i.lastName)) e.lastName = 'Enter the last name.';
  else if (trim(i.lastName).length > 60) e.lastName = 'Too long (max 60).';
  if (!GENDERS.includes(i.gender as Gender)) e.gender = 'Choose a gender.';
  if (!isValidBirthDate(i.dateOfBirth, now)) e.dateOfBirth = 'Enter a valid date of birth (YYYY-MM-DD).';
  if (!activeClassIds.has(i.classId)) e.classId = 'Choose a class.';
  if (!isValidPhone(i.phone.trim())) e.phone = 'Enter a valid phone number.';
  if (i.email.trim() && !looksLikeEmail(i.email.trim())) e.email = 'Enter a valid email address.';
  if (i.address.trim().length > 300) e.address = 'Too long (max 300).';
  if (i.admissionNumber.trim() && !isValidAdmissionNumber(i.admissionNumber.trim())) {
    e.admissionNumber = 'Use 3-30 letters, numbers or dashes.';
  }
  if (!isValidIsoDate(i.admissionDate)) e.admissionDate = 'Enter a valid admission date (YYYY-MM-DD).';
  return e;
}

export function buildStudentDoc(
  i: StudentInput,
  c: { tenantId: string; admissionNumber: string; academicSession: string; photo: string | null; uid: string | null; createdBy: string },
): Record<string, unknown> {
  return {
    tenantId: c.tenantId,
    studentId: c.admissionNumber,
    admissionNumber: c.admissionNumber,
    firstName: trim(i.firstName),
    middleName: trim(i.middleName),
    lastName: trim(i.lastName),
    gender: i.gender,
    dateOfBirth: i.dateOfBirth,
    photo: c.photo,
    classId: i.classId,
    parentIds: [],
    phone: i.phone.trim(),
    email: i.email.trim(),
    address: i.address.trim(),
    admissionDate: i.admissionDate,
    status: 'ACTIVE',
    academicSession: c.academicSession,
    uid: c.uid,
    createdAt: serverTimestamp(),
    createdBy: c.createdBy,
  };
}

/** Fields an admin may change on an existing student (immutable ones are never sent). */
export function buildStudentUpdate(i: StudentInput, photo: string | null): Record<string, unknown> {
  return {
    firstName: trim(i.firstName), middleName: trim(i.middleName), lastName: trim(i.lastName),
    gender: i.gender, dateOfBirth: i.dateOfBirth, classId: i.classId, photo,
    phone: i.phone.trim(), email: i.email.trim(), address: i.address.trim(),
    admissionDate: i.admissionDate, updatedAt: serverTimestamp(),
  };
}

// ------------------------------------------------------------------ teachers
export interface TeacherInput { name: string; email: string; phone: string; subjects: string[]; classes: string[] }

export function validateTeacher(i: TeacherInput): FieldErrors {
  const e: FieldErrors = {};
  if (trim(i.name).length < 2) e.name = "Enter the teacher's name.";
  else if (trim(i.name).length > 120) e.name = 'Too long (max 120).';
  if (!looksLikeEmail(i.email.trim())) e.email = 'Enter a valid email address (it is the teacher\'s sign-in).';
  if (!isValidPhone(i.phone.trim())) e.phone = 'Enter a valid phone number.';
  if (i.subjects.length > 50) e.subjects = 'Too many subjects (max 50).';
  if (i.classes.length > 50) e.classes = 'Too many classes (max 50).';
  return e;
}

/** Editable teacher fields (email is the sign-in, so it is not editable here). */
export function buildTeacherUpdate(i: Pick<TeacherInput, 'name' | 'phone' | 'subjects' | 'classes'>, photo: string | null): Record<string, unknown> {
  return {
    name: trim(i.name), phone: i.phone.trim(), photo, subjects: i.subjects, classes: i.classes, updatedAt: serverTimestamp(),
  };
}

export function teacherCode(uid: string): string {
  return `TCH-${uid.slice(0, 6).toUpperCase()}`;
}

export function buildTeacherDoc(
  i: TeacherInput,
  c: { tenantId: string; uid: string; photo: string | null; createdBy: string },
): Record<string, unknown> {
  return {
    tenantId: c.tenantId, teacherId: teacherCode(c.uid), uid: c.uid, name: trim(i.name), photo: c.photo,
    phone: i.phone.trim(), email: i.email.trim(), loginId: i.email.trim(),
    subjects: i.subjects, classes: i.classes, status: 'ACTIVE',
    createdAt: serverTimestamp(), createdBy: c.createdBy,
  };
}

// ------------------------------------------------------------------- parents
export interface ParentInput { name: string; email: string; phone: string; childAdmissionNumbers: string[] }
export const MAX_CHILDREN_PER_SAVE = 4;

export function validateParent(i: ParentInput): FieldErrors {
  const e: FieldErrors = {};
  if (trim(i.name).length < 2) e.name = "Enter the parent's name.";
  if (i.email.trim() && !looksLikeEmail(i.email.trim())) e.email = 'Enter a valid email address.';
  if (!isValidPhone(i.phone.trim())) e.phone = 'Enter a valid phone number.';
  if (i.childAdmissionNumbers.length > MAX_CHILDREN_PER_SAVE) {
    e.children = `Link at most ${MAX_CHILDREN_PER_SAVE} children at a time.`;
  }
  const bad = i.childAdmissionNumbers.find((n) => !isValidAdmissionNumber(n));
  if (bad) e.children = `"${bad}" is not a valid admission number.`;
  return e;
}

export function buildParentDoc(
  i: ParentInput,
  c: { tenantId: string; uid: string; loginId: string; childIds: string[]; createdBy: string },
): Record<string, unknown> {
  return {
    tenantId: c.tenantId, uid: c.uid, name: trim(i.name), phone: i.phone.trim(), email: i.email.trim(),
    loginId: c.loginId, childIds: c.childIds, status: 'ACTIVE',
    createdAt: serverTimestamp(), createdBy: c.createdBy,
  };
}

/** Parses "SCA-2026-0001, SCA-2026-0002" (commas, semicolons, spaces, new lines). */
export function parseAdmissionList(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
}
