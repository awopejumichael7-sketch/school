import { describe, it, expect } from 'vitest';
import { can, navFor, PERMISSIONS, NAV } from './lib-permissions';
import {
  loginIdToEmail, usernameToEmail, isSyntheticEmail, generatePassword, randomString, buildMemberOps, cleanLoginId,
} from './lib-accounts';
import {
  isValidIsoDate, isValidBirthDate, defaultAdmissionPrefix, formatAdmissionNumber, validateStudent, buildStudentDoc,
  validateTeacher, validateParent, parseAdmissionList, isValidPhone, buildStudentUpdate, buildTeacherDoc, buildParentDoc,
  type StudentInput,
} from './lib-people';
import { sniffDelimiter, parseCsv, toCsv, safeCell, parseImport, templateCsv, templateHeaders, SPECS, hasBlockingHeaderErrors, MAX_IMPORT_ROWS, type ImportContext, type ImportKind } from './lib-csv';

const NOW = new Date(2026, 9, 13);

describe('permissions', () => {
  it('only the school admin manages users, settings, import, parents and teachers', () => {
    for (const p of ['users.manage', 'settings.manage', 'import.run', 'parents.manage', 'teachers.manage', 'students.write'] as const) {
      expect(can('SCHOOL_ADMIN', p)).toBe(true);
      for (const r of ['PRINCIPAL', 'TEACHER', 'STUDENT', 'PARENT', 'ACCOUNTANT', 'STAFF'] as const) expect(can(r, p)).toBe(false);
    }
  });
  it('teachers cannot see admin screens or other schools\' management', () => {
    const labels = navFor('TEACHER').map((n) => n.label);
    expect(labels).toEqual(['Overview', 'Attendance', 'My classes']);
  });
  it('attendance and fees permissions', () => {
    expect(can('TEACHER', 'attendance.take')).toBe(true);
    expect(can('SCHOOL_ADMIN', 'attendance.take')).toBe(true);
    for (const r of ['PRINCIPAL', 'STAFF', 'ACCOUNTANT', 'STUDENT', 'PARENT'] as const) expect(can(r, 'attendance.take')).toBe(false);
    expect(can('PRINCIPAL', 'attendance.read')).toBe(true);
    expect(can('STAFF', 'attendance.read')).toBe(true);
    expect(can('ACCOUNTANT', 'attendance.read')).toBe(false);
    for (const r of ['SCHOOL_ADMIN', 'ACCOUNTANT'] as const) expect(can(r, 'fees.manage')).toBe(true);
    for (const r of ['PRINCIPAL', 'TEACHER', 'STAFF', 'STUDENT', 'PARENT'] as const) expect(can(r, 'fees.manage')).toBe(false);
    expect(can('PRINCIPAL', 'fees.read')).toBe(true);
    for (const r of ['TEACHER', 'STAFF', 'STUDENT', 'PARENT'] as const) expect(can(r, 'fees.read')).toBe(false);
    expect(navFor('ACCOUNTANT').map((n) => n.label)).toEqual(['Overview', 'Students', 'Fees']);
  });
  it('students and parents only get the overview for now', () => {
    expect(navFor('STUDENT').map((n) => n.label)).toEqual(['Overview']);
    expect(navFor('PARENT').map((n) => n.label)).toEqual(['Overview']);
    expect(navFor(undefined).map((n) => n.label)).toEqual(['Overview']);
  });
  it('every role is defined and nav entries are unique', () => {
    expect(Object.keys(PERMISSIONS).sort()).toEqual(['ACCOUNTANT', 'PARENT', 'PRINCIPAL', 'SCHOOL_ADMIN', 'STAFF', 'STUDENT', 'TEACHER']);
    expect(new Set(NAV.map((n) => n.to)).size).toBe(NAV.length);
  });
});

describe('accounts', () => {
  it('maps usernames to a private synthetic email, real emails untouched', () => {
    expect(usernameToEmail('SCA-2026-0001', 'royal')).toBe('sca-2026-0001@royal.login.invalid');
    expect(loginIdToEmail('  Ada@School.com ', 'royal')).toBe('Ada@School.com');
    expect(loginIdToEmail('SCA/2026 0001', 'royal')).toBe('sca-2026-0001@royal.login.invalid');
    expect(isSyntheticEmail('x@royal.login.invalid')).toBe(true);
    expect(isSyntheticEmail('x@gmail.com')).toBe(false);
    expect(cleanLoginId('  --Ab C--')).toBe('ab-c');
  });
  it('same username in two schools gives different identities', () => {
    expect(usernameToEmail('u1', 'school-a')).not.toBe(usernameToEmail('u1', 'school-b'));
  });
  it('passwords: 12 chars, no look-alikes, unique, unbiased sampler', () => {
    const set = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const p = generatePassword();
      expect(p).toMatch(/^[A-HJ-NP-Za-km-z2-9]{12}$/);
      set.add(p);
    }
    expect(set.size).toBe(500);
    // rejection sampling: bytes >= limit are skipped, never wrapped
    // 3 does not divide 256, so byte 255 must be skipped (wrapping it would give 'a' first)
    const only = randomString('abc', 4, () => new Uint8Array([255, 0, 1, 255, 2, 3, 255, 4]));
    expect(only).toBe('abca');
  });
  it('member ops always pair member + directory, force password change, never carry extra roles', () => {
    const ops = buildMemberOps({ tenantId: 't', uid: 'u', role: 'TEACHER', displayName: 'T', email: 't@x.com', loginId: 't@x.com', classIds: ['c'], subjectIds: ['s'] });
    expect(ops.map((o) => o.path)).toEqual(['tenants/t/members/u', 'userDirectory/u']);
    expect(ops[0]!.data).toMatchObject({ role: 'TEACHER', status: 'ACTIVE', mustChangePassword: true, classIds: ['c'] });
    expect(ops[1]!.data).toEqual({ tenantId: 't' });
  });
});

describe('people validation', () => {
  const ok: StudentInput = {
    firstName: 'Ada', middleName: '', lastName: 'Okafor', gender: 'FEMALE', dateOfBirth: '2014-05-21', classId: 'jss-1',
    phone: '08012345678', email: '', address: '', admissionNumber: '', admissionDate: '2026-09-14',
  };
  const classes = new Set(['jss-1']);
  it('accepts a valid student', () => expect(validateStudent(ok, classes, NOW)).toEqual({}));
  it('rejects bad fields with specific messages', () => {
    const e = validateStudent({ ...ok, firstName: ' ', gender: 'X', dateOfBirth: '2026-02-30', classId: 'nope', phone: 'abc', email: 'x', admissionNumber: 'a/b', admissionDate: '14/09/2026' }, classes, NOW);
    expect(Object.keys(e).sort()).toEqual(['admissionDate', 'admissionNumber', 'classId', 'dateOfBirth', 'email', 'firstName', 'gender', 'phone']);
  });
  it('dates: real calendar days, not future, not absurdly old', () => {
    expect(isValidIsoDate('2024-02-29')).toBe(true);
    expect(isValidIsoDate('2025-02-29')).toBe(false);
    expect(isValidIsoDate('2026-13-01')).toBe(false);
    expect(isValidBirthDate('2026-10-14', NOW)).toBe(false);
    expect(isValidBirthDate('2026-10-13', NOW)).toBe(true);
    expect(isValidBirthDate('1900-01-01', NOW)).toBe(false);
  });
  it('phones', () => {
    expect(isValidPhone('')).toBe(true);
    expect(isValidPhone('+234 801 234 5678')).toBe(true);
    expect(isValidPhone('12')).toBe(false);
  });
  it('admission numbers: prefix from school name and padded sequence', () => {
    expect(defaultAdmissionPrefix("Scholar's Camp")).toBe('SC');
    expect(defaultAdmissionPrefix('Royal Scholars Academy')).toBe('RSA');
    expect(defaultAdmissionPrefix('College of the Future')).toBe('CF');
    expect(defaultAdmissionPrefix('X')).toBe('SCH');
    expect(formatAdmissionNumber('RSA', 2026, 7)).toBe('RSA-2026-0007');
    expect(formatAdmissionNumber('RSA', 2026, 12345)).toBe('RSA-2026-12345');
  });
  it('student doc contains every spec field and starts with no parents', () => {
    const d = buildStudentDoc(ok, { tenantId: 't', admissionNumber: 'RSA-2026-0001', academicSession: '2026/2027', photo: null, uid: null, createdBy: 'a' });
    for (const k of ['studentId', 'firstName', 'middleName', 'lastName', 'gender', 'dateOfBirth', 'photo', 'classId', 'tenantId', 'parentIds', 'phone', 'email', 'address', 'admissionNumber', 'admissionDate', 'status', 'academicSession']) {
      expect(d).toHaveProperty(k);
    }
    expect(d.parentIds).toEqual([]);
    expect(d.status).toBe('ACTIVE');
    const u = buildStudentUpdate(ok, null);
    for (const immutable of ['tenantId', 'admissionNumber', 'studentId', 'parentIds', 'status', 'uid', 'createdAt']) expect(u).not.toHaveProperty(immutable);
  });
  it('teacher and parent validation + docs', () => {
    expect(validateTeacher({ name: 'A', email: 'bad', phone: '', subjects: [], classes: [] })).toHaveProperty('name');
    expect(validateTeacher({ name: 'Mrs Bello', email: 'b@x.com', phone: '', subjects: [], classes: [] })).toEqual({});
    expect(validateParent({ name: 'Mr Okafor', email: '', phone: '', childAdmissionNumbers: ['A-1', 'B-2', 'C-3', 'D-4', 'E-5'] })).toHaveProperty('children');
    expect(validateParent({ name: 'Mr Okafor', email: '', phone: '', childAdmissionNumbers: ['a/b'] })).toHaveProperty('children');
    expect(buildTeacherDoc({ name: ' Mrs  Bello ', email: 'b@x.com', phone: '', subjects: ['s'], classes: ['c'] }, { tenantId: 't', uid: 'abcdef123', photo: null, createdBy: 'a' })).toMatchObject({ name: 'Mrs Bello', teacherId: 'TCH-ABCDEF', uid: 'abcdef123', status: 'ACTIVE' });
    expect(buildParentDoc({ name: 'P', email: '', phone: '', childAdmissionNumbers: [] }, { tenantId: 't', uid: 'u', loginId: 'parent-x', childIds: ['S1'], createdBy: 'a' })).toMatchObject({ childIds: ['S1'], status: 'ACTIVE' });
    expect(parseAdmissionList('A-1, A-2;A-1\nA-3')).toEqual(['A-1', 'A-2', 'A-3']);
  });
});

describe('csv', () => {
  it('parses quotes, escaped quotes, CRLF, BOM and skips blank lines', () => {
    const rows = parseCsv('\uFEFFa,b\r\n"x, y","he said ""hi"""\r\n\r\n,\r\nlast,row');
    expect(rows).toEqual([['a', 'b'], ['x, y', 'he said "hi"'], ['last', 'row']]);
  });
  it('round-trips and neutralises formula injection on export', () => {
    expect(safeCell('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`);
    expect(safeCell('Ada')).toBe('Ada');
    const csv = toCsv([['n', 'v'], ['a,b', 'q"r'], ['=1+1', '@x']]);
    expect(parseCsv(csv)).toEqual([['n', 'v'], ['a,b', 'q"r'], [`'=1+1`, `'@x`]]);
  });
  const ctx: ImportContext = {
    classIdByName: new Map([['jss 1', 'jss-1'], ['jss 2', 'jss-2']]),
    subjectIdByName: new Map([['mathematics', 'mathematics'], ['physics', 'physics']]),
    existingAdmissionNumbers: new Set(['sc-2026-0001']),
    existingEmails: new Set(['taken@x.com']),
    existingNames: new Set(['english']),
    now: NOW,
  };
  const H = 'firstName,lastName,gender,dateOfBirth,className,admissionNumber\n';
  it('every downloadable template parses cleanly and its example row is valid', () => {
    for (const kind of Object.keys(SPECS) as ImportKind[]) {
      const grid = parseCsv(templateCsv(kind));
      expect(grid[0]).toEqual(templateHeaders(kind));
      expect(grid[1]!.length).toBe(grid[0]!.length);
    }
    const r = parseImport('students', templateCsv('students'), ctx);
    expect(r.headerErrors).toEqual([]); expect(r.invalid).toBe(0); expect(r.valid).toBe(1);
    expect(parseImport('teachers', templateCsv('teachers'), ctx).invalid).toBe(0);
    expect(parseImport('subjects', templateCsv('subjects'), ctx).invalid).toBe(0);
    expect(parseImport('classes', templateCsv('classes'), ctx).invalid).toBe(0);
  });
  it('students: valid and invalid rows are separated with line numbers and reasons', () => {
    const csv = H + [
      'Ada,Okafor,female,2014-05-21,JSS 1,',        // valid (gender case-insensitive)
      'Bola,Ade,M,2013-01-02,jss 2,SC-2026-0001',   // existing admission number
      'Cy,Dee,MALE,2013-02-30,JSS 1,',              // bad date
      'Eve,Foo,MALE,2013-03-03,SS 9,',              // unknown class
      ',Foo,MALE,2013-03-03,JSS 1,',                // missing first name
      'Gus,Hay,MALE,2013-03-03,JSS 1,NEW-1',        // valid custom number
      'Hal,Ivy,MALE,2013-03-03,JSS 1,new-1',        // duplicate in file (case-insensitive)
    ].join('\n');
    const r = parseImport('students', csv, ctx);
    expect(r.valid).toBe(2); expect(r.invalid).toBe(5);
    expect(r.rows.map((x) => x.line)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(r.rows[0]!.value).toMatchObject({ gender: 'FEMALE', classId: 'jss-1' });
    expect(r.rows[1]!.errors.join()).toMatch(/already exists/);
    expect(r.rows[2]!.errors.join()).toMatch(/dateOfBirth/);
    expect(r.rows[3]!.errors.join()).toMatch(/does not exist/);
    expect(r.rows[6]!.errors.join()).toMatch(/twice/);
  });
  it('blocks files with missing required columns or too many rows; unknown columns only warn', () => {
    expect(hasBlockingHeaderErrors(parseImport('students', 'firstName,lastName\nA,B', ctx).headerErrors)).toBe(true);
    const warn = parseImport('subjects', 'name,colour\nArt,red', ctx);
    expect(hasBlockingHeaderErrors(warn.headerErrors)).toBe(false);
    expect(warn.valid).toBe(1);
    const big = 'name\n' + Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `S${i}`).join('\n');
    const r = parseImport('subjects', big, ctx);
    expect(hasBlockingHeaderErrors(r.headerErrors)).toBe(true);
    expect(r.rows).toEqual([]);
    expect(parseImport('classes', '', ctx).headerErrors).toEqual(['The file is empty.']);
  });
  it('teachers: unknown subjects/classes, duplicate or taken emails are errors', () => {
    const csv = 'name,email,phone,subjects,classes\n' + [
      'Mrs Bello,bello@x.com,,Mathematics;Physics,JSS 1;JSS 2',
      'Mr Taken,TAKEN@x.com,,,',
      'Mr Odd,odd@x.com,,Chemistry,',
      'Mr Twin,Bello@x.com,,,',
      'X,notanemail,,,',
    ].join('\n');
    const r = parseImport('teachers', csv, ctx);
    expect(r.valid).toBe(1);
    expect(r.rows[0]!.value).toMatchObject({ email: 'bello@x.com', subjects: ['mathematics', 'physics'], classes: ['jss-1', 'jss-2'] });
    expect(r.rows[1]!.errors.join()).toMatch(/already used/);
    expect(r.rows[2]!.errors.join()).toMatch(/Unknown subject "Chemistry"/);
    expect(r.rows[3]!.errors.join()).toMatch(/twice/);
    expect(r.rows[4]!.errors.length).toBeGreaterThan(0);
  });
  it('subjects/classes: duplicates against existing data and within the file', () => {
    const r = parseImport('subjects', 'name\nEnglish\nArt\nart\n  Music  ', ctx);
    expect(r.rows.map((x) => !!x.value)).toEqual([false, true, false, true]);
    expect(r.rows[3]!.value).toEqual({ name: 'Music' });
  });

  it('detects semicolon- and tab-delimited files (Excel in many regions)', () => {
    expect(sniffDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(sniffDelimiter('a\tb\tc')).toBe('\t');
    expect(sniffDelimiter('a,b;c')).toBe(',');
    expect(sniffDelimiter('single')).toBe(',');
    expect(parseCsv('name;email\n"Bello; Mrs";b@x.com')).toEqual([['name', 'email'], ['Bello; Mrs', 'b@x.com']]);
    const ctx = { classIdByName: new Map(), subjectIdByName: new Map(), existingAdmissionNumbers: new Set<string>(), existingEmails: new Set<string>(), existingNames: new Set<string>() };
    const r = parseImport('subjects', 'name\nArt\nMusic', ctx);
    expect(r.valid).toBe(2);
    expect(parseImport('classes', 'name;extra\nJSS 1;x', ctx).valid).toBe(1);
  });
});
