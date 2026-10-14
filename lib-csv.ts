import { isValidAdmissionNumber, isValidBirthDate, isValidIsoDate, isValidPhone, looksLikeEmail, todayIso, type StudentInput, type TeacherInput } from './lib-people';
import { parseList } from './lib-config';

export type ImportKind = 'students' | 'teachers' | 'subjects' | 'classes';
export const MAX_IMPORT_ROWS = 500;

/** Excel in many regions saves "CSV" with ; (or tabs). Pick whichever the header line uses most. */
export function sniffDelimiter(src: string): string {
  const header = src.split(/\r?\n/, 1)[0] ?? '';
  const count = (c: string) => header.split(c).length - 1;
  const best = [',', ';', '\t'].reduce((a, c) => (count(c) > count(a) ? c : a), ',');
  return count(best) > 0 ? best : ',';
}

/** RFC-4180-style parser: quotes, escaped quotes, CRLF, BOM. Blank lines are skipped. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const delim = sniffDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

/** Neutralise spreadsheet formula injection (=, +, -, @) in exported cells. */
export function safeCell(v: string | number): string {
  const s = String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}
export function toCsv(rows: (string | number)[][]): string {
  const q = (v: string | number) => {
    const s = safeCell(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
}

interface Spec { required: string[]; optional: string[]; example: string[] }
export const SPECS: Record<ImportKind, Spec> = {
  students: {
    required: ['firstName', 'lastName', 'gender', 'dateOfBirth', 'className'],
    optional: ['middleName', 'phone', 'email', 'address', 'admissionNumber', 'admissionDate'],
    example: ['Ada', 'Okafor', 'FEMALE', '2014-05-21', 'JSS 1', 'Chidi', '08012345678', '', '12 Example Street', '', ''],
  },
  teachers: {
    required: ['name', 'email'],
    optional: ['phone', 'subjects', 'classes'],
    example: ['Mrs Bello', 'bello@example.com', '08012345678', 'Mathematics;Physics', 'JSS 1;JSS 2'],
  },
  subjects: { required: ['name'], optional: [], example: ['Mathematics'] },
  classes: { required: ['name'], optional: [], example: ['JSS 1'] },
};
/** Template column order: required first, then optional (students example row lines up with this). */
export function templateHeaders(kind: ImportKind): string[] {
  const s = SPECS[kind];
  if (kind === 'students') {
    return ['firstName', 'lastName', 'gender', 'dateOfBirth', 'className', 'middleName', 'phone', 'email', 'address', 'admissionNumber', 'admissionDate'];
  }
  return [...s.required, ...s.optional];
}
export function templateCsv(kind: ImportKind): string {
  return toCsv([templateHeaders(kind), SPECS[kind].example]);
}

export interface ParsedRow<T> { line: number; value: T | null; errors: string[] }
export interface ImportResult<T> {
  headerErrors: string[];
  rows: ParsedRow<T>[];
  valid: number;
  invalid: number;
}

export interface ImportContext {
  classIdByName: ReadonlyMap<string, string>;     // lowercase name -> id (active classes)
  subjectIdByName: ReadonlyMap<string, string>;   // lowercase name -> id (active subjects)
  existingAdmissionNumbers: ReadonlySet<string>;  // lowercase
  existingEmails: ReadonlySet<string>;            // lowercase
  existingNames: ReadonlySet<string>;             // lowercase (subjects / classes)
  now?: Date;
}

type Parsed = StudentInput | (TeacherInput & { unknown: string[] }) | { name: string };

function toRecords(grid: string[][], spec: Spec): { records: { line: number; r: Record<string, string> }[]; headerErrors: string[] } {
  const headerErrors: string[] = [];
  if (grid.length === 0) return { records: [], headerErrors: ['The file is empty.'] };
  const header = (grid[0] as string[]).map((h) => h.trim());
  const lower = header.map((h) => h.toLowerCase());
  const known = [...spec.required, ...spec.optional];
  for (const req of spec.required) if (!lower.includes(req.toLowerCase())) headerErrors.push(`Missing required column "${req}".`);
  const unknownCols = header.filter((h) => h && !known.some((k) => k.toLowerCase() === h.toLowerCase()));
  if (unknownCols.length) headerErrors.push(`Unknown column(s) will be ignored: ${unknownCols.join(', ')}.`);
  if (grid.length - 1 > MAX_IMPORT_ROWS) headerErrors.push(`Too many rows (${grid.length - 1}). Import at most ${MAX_IMPORT_ROWS} at a time.`);
  const records = grid.slice(1).map((cells, idx) => {
    const r: Record<string, string> = {};
    known.forEach((k) => {
      const col = lower.indexOf(k.toLowerCase());
      r[k] = col >= 0 ? (cells[col] ?? '').trim() : '';
    });
    return { line: idx + 2, r };
  });
  return { records, headerErrors };
}
/** Blocking = anything except the "unknown column" notice. */
export const hasBlockingHeaderErrors = (errs: string[]) => errs.some((e) => !e.startsWith('Unknown column'));

export function parseImport(kind: 'students', text: string, ctx: ImportContext): ImportResult<StudentInput>;
export function parseImport(kind: 'teachers', text: string, ctx: ImportContext): ImportResult<TeacherInput>;
export function parseImport(kind: 'subjects' | 'classes', text: string, ctx: ImportContext): ImportResult<{ name: string }>;
export function parseImport(kind: ImportKind, text: string, ctx: ImportContext): ImportResult<Parsed> {
  const { records, headerErrors } = toRecords(parseCsv(text), SPECS[kind]);
  const blocked = hasBlockingHeaderErrors(headerErrors);
  const seen = new Set<string>();
  const rows: ParsedRow<Parsed>[] = [];
  if (!blocked) {
    for (const { line, r } of records.slice(0, MAX_IMPORT_ROWS)) {
      const errors: string[] = [];
      let value: Parsed | null = null;
      if (kind === 'students') value = student(r, ctx, errors, seen);
      else if (kind === 'teachers') value = teacher(r, ctx, errors, seen);
      else value = named(r, kind, ctx, errors, seen);
      rows.push({ line, value: errors.length ? null : value, errors });
    }
  }
  const valid = rows.filter((x) => x.value).length;
  return { headerErrors, rows, valid, invalid: rows.length - valid };
}

function dupe(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) return true;
  seen.add(key);
  return false;
}

function student(r: Record<string, string>, ctx: ImportContext, errors: string[], seen: Set<string>): StudentInput | null {
  const g = (r.gender ?? '').toUpperCase();
  const gender = g === 'M' ? 'MALE' : g === 'F' ? 'FEMALE' : g;
  if (!r.firstName) errors.push('firstName is required.');
  if (!r.lastName) errors.push('lastName is required.');
  if (gender !== 'MALE' && gender !== 'FEMALE') errors.push('gender must be MALE or FEMALE.');
  if (!isValidBirthDate(r.dateOfBirth ?? '', ctx.now)) errors.push('dateOfBirth must be a real past date as YYYY-MM-DD.');
  const classId = ctx.classIdByName.get((r.className ?? '').toLowerCase());
  if (!classId) errors.push(`Class "${r.className ?? ''}" does not exist (create it first).`);
  if (!isValidPhone(r.phone ?? '')) errors.push('phone is not valid.');
  if (r.email && !looksLikeEmail(r.email)) errors.push('email is not valid.');
  const adm = (r.admissionNumber ?? '').toUpperCase(); // stored upper-case so A-1 and a-1 can never be two students
  if (adm) {
    if (!isValidAdmissionNumber(adm)) errors.push('admissionNumber must be 3-30 letters, numbers or dashes.');
    else if (ctx.existingAdmissionNumbers.has(adm.toLowerCase())) errors.push(`Admission number ${adm} already exists.`);
    else if (dupe(seen, `adm:${adm.toLowerCase()}`)) errors.push(`Admission number ${adm} appears twice in this file.`);
  }
  const admDate = r.admissionDate || todayIso(ctx.now);
  if (!isValidIsoDate(admDate)) errors.push('admissionDate must be YYYY-MM-DD.');
  if ((r.address ?? '').length > 300) errors.push('address is too long.');
  if (errors.length) return null;
  return {
    firstName: r.firstName ?? '', middleName: r.middleName ?? '', lastName: r.lastName ?? '',
    gender, dateOfBirth: r.dateOfBirth ?? '', classId: classId as string, phone: r.phone ?? '',
    email: r.email ?? '', address: r.address ?? '', admissionNumber: adm, admissionDate: admDate,
  };
}

function teacher(r: Record<string, string>, ctx: ImportContext, errors: string[], seen: Set<string>): (TeacherInput & { unknown: string[] }) | null {
  if ((r.name ?? '').length < 2) errors.push('name is required.');
  const email = (r.email ?? '').toLowerCase();
  if (!looksLikeEmail(email)) errors.push('a valid email is required (it is the sign-in).');
  else if (ctx.existingEmails.has(email)) errors.push(`Email ${email} is already used.`);
  else if (dupe(seen, `em:${email}`)) errors.push(`Email ${email} appears twice in this file.`);
  if (!isValidPhone(r.phone ?? '')) errors.push('phone is not valid.');
  const unknown: string[] = [];
  const subjects: string[] = [];
  for (const n of parseList((r.subjects ?? '').replace(/;/g, ','))) {
    const id = ctx.subjectIdByName.get(n.toLowerCase());
    if (id) subjects.push(id); else unknown.push(`subject "${n}"`);
  }
  const classes: string[] = [];
  for (const n of parseList((r.classes ?? '').replace(/;/g, ','))) {
    const id = ctx.classIdByName.get(n.toLowerCase());
    if (id) classes.push(id); else unknown.push(`class "${n}"`);
  }
  if (unknown.length) errors.push(`Unknown ${unknown.join(', ')} (create first).`);
  if (errors.length) return null;
  return { name: r.name ?? '', email, phone: r.phone ?? '', subjects, classes, unknown };
}

function named(r: Record<string, string>, kind: 'subjects' | 'classes', ctx: ImportContext, errors: string[], seen: Set<string>): { name: string } | null {
  const name = (r.name ?? '').replace(/\s+/g, ' ');
  if (!name) errors.push('name is required.');
  else if (name.length > 100) errors.push('name is too long (max 100).');
  else if (ctx.existingNames.has(name.toLowerCase())) errors.push(`"${name}" already exists.`);
  else if (dupe(seen, `n:${name.toLowerCase()}`)) errors.push(`"${name}" appears twice in this file.`);
  void kind;
  return errors.length ? null : { name };
}

export function credentialsCsv(rows: { name: string; loginId: string; password: string }[]): string {
  return toCsv([['name', 'sign_in', 'temporary_password'], ...rows.map((r) => [r.name, r.loginId, r.password])]);
}
