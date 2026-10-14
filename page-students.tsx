import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  collection, doc, getDoc, getDocs, limit, query, serverTimestamp, startAfter, where,
  type DocumentData, type QueryConstraint, type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { firebase } from './lib-firebase';
import { isActiveItem, useTenant } from './ctx-tenant';
import { Alert, Badge, Button, Card, Field, Select, Spinner } from './ui';
import { Credentials, PhotoInput, type Cred } from './ui-editors';
import { useAction } from './use-action';
import { applyOps, newId, type Op } from './lib-ops';
import { auditOp, buildMemberOps, generatePassword, usernameToEmail } from './lib-accounts';
import { withNewAccount } from './lib-newuser';
import { reserveAdmissionNumbers } from './lib-numbers';
import {
  buildStudentDoc, buildStudentUpdate, defaultAdmissionPrefix, isValidAdmissionNumber, STUDENT_STATUSES, todayIso, validateStudent,
  type FieldErrors, type StudentInput,
} from './lib-people';
import { UserFacingError } from './lib-errors';
import { can } from './lib-permissions';
import type { StudentDoc, StudentStatus } from './types';

type Row = StudentDoc & { id: string };
const PAGE = 25;
const fullName = (s: Pick<StudentDoc, 'firstName' | 'middleName' | 'lastName'>) => [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ');

const blank = (): StudentInput => ({
  firstName: '', middleName: '', lastName: '', gender: '', dateOfBirth: '', classId: '',
  phone: '', email: '', address: '', admissionNumber: '', admissionDate: todayIso(),
});

export default function Students() {
  const { tenantId, classes, member } = useTenant();
  const canWrite = can(member.role, 'students.write');
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fClass, setFClass] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [find, setFind] = useState('');
  const [editing, setEditing] = useState<'new' | Row | null>(null);
  const [creds, setCreds] = useState<Cred[] | null>(null);
  const { busy, error, setError, run } = useAction();

  const load = useCallback(async (after: QueryDocumentSnapshot<DocumentData> | null) => {
    setLoading(true);
    await run('students', async () => {
      const cs: QueryConstraint[] = [];
      if (fClass) cs.push(where('classId', '==', fClass));
      if (fStatus) cs.push(where('status', '==', fStatus));
      if (after) cs.push(startAfter(after));
      cs.push(limit(PAGE));
      const snap = await getDocs(query(collection(firebase().db, `tenants/${tenantId}/students`), ...cs));
      const next = snap.docs.map((d) => ({ ...(d.data() as StudentDoc), id: d.id }));
      setRows((p) => (after ? [...p, ...next] : next));
      setCursor(snap.docs[snap.docs.length - 1] ?? null);
      setMore(snap.docs.length === PAGE);
    });
    setLoading(false);
  }, [tenantId, fClass, fStatus, run]);
  useEffect(() => { void load(null); }, [load]);

  async function lookup(e: FormEvent) {
    e.preventDefault();
    const n = find.trim().toUpperCase();
    if (!n) return void load(null);
    await run('findStudent', async () => {
      if (!isValidAdmissionNumber(n)) throw new UserFacingError('No student with that admission number.');
      const s = await getDoc(doc(firebase().db, `tenants/${tenantId}/students/${n}`));
      if (!s.exists()) throw new UserFacingError('No student with that admission number.');
      setRows([{ ...(s.data() as StudentDoc), id: s.id }]); setMore(false);
    });
  }

  const className = (id: string) => classes.find((c) => c.id === id)?.name ?? id;

  async function toggle(s: Row) {
    const status: StudentStatus = s.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    if (status === 'INACTIVE' && !window.confirm(`Deactivate ${fullName(s)}? They keep their records but lose access.`)) return;
    await run('toggleStudent', async () => {
      const ops: Op[] = [{ kind: 'update', path: `tenants/${tenantId}/students/${s.id}`, data: { status, updatedAt: serverTimestamp() } }];
      if (s.uid) ops.push({ kind: 'update', path: `tenants/${tenantId}/members/${s.uid}`, data: { status: status === 'ACTIVE' ? 'ACTIVE' : 'DISABLED' } });
      ops.push(auditOp(tenantId, member.uid, newId(), status === 'ACTIVE' ? 'student.reactivated' : 'student.deactivated', `students/${s.id}`));
      await applyOps(firebase().db, ops);
      setRows((p) => p.map((x) => (x.id === s.id ? { ...x, status } : x)));
    });
  }

  return (
    <>
      <h1>Students</h1>
      {error && <Alert>{error}</Alert>}
      {creds && <Credentials creds={creds} onClose={() => setCreds(null)} />}
      {editing ? (
        <StudentForm
          initial={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={(c) => { setEditing(null); if (c) setCreds([c]); void load(null); }}
        />
      ) : (
        <Card>
          <div className="toolbar">
            <Select label="Class" value={fClass} onChange={(e) => setFClass(e.target.value)}>
              <option value="">All classes</option>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.name}{isActiveItem(c) ? '' : ' (archived)'}</option>)}
            </Select>
            <Select label="Status" value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
              <option value="">All</option>
              {STUDENT_STATUSES.map((s) => <option key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</option>)}
            </Select>
            <form className="row" onSubmit={lookup} noValidate>
              <Field label="Find by admission number" value={find} onChange={(e) => setFind(e.target.value)} />
              <Button type="submit" variant="secondary">Find</Button>
            </form>
            {canWrite && <Button onClick={() => { setError(null); setEditing('new'); }}>Add student</Button>}
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th></th><th>Admission no.</th><th>Name</th><th>Class</th><th>Gender</th><th>Status</th>{canWrite && <th>Actions</th>}</tr></thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td>{s.photo ? <img className="photo" src={s.photo} alt="" /> : null}</td>
                    <td>{s.admissionNumber}</td>
                    <td>{fullName(s)}</td>
                    <td>{className(s.classId)}</td>
                    <td>{s.gender === 'MALE' ? 'Male' : 'Female'}</td>
                    <td><Badge tone={s.status === 'ACTIVE' ? 'ok' : 'muted'}>{s.status}</Badge></td>
                    {canWrite && (
                      <td className="actions">
                        <Button variant="ghost" onClick={() => { setError(null); setEditing(s); }} aria-label={`Edit ${fullName(s)}`}>Edit</Button>
                        {(s.status === 'ACTIVE' || s.status === 'INACTIVE') && (
                          <Button variant="ghost" busy={busy} onClick={() => void toggle(s)} aria-label={`${s.status === 'ACTIVE' ? 'Deactivate' : 'Activate'} ${fullName(s)}`}>
                            {s.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
                          </Button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
                {rows.length === 0 && !loading && <tr><td colSpan={7} className="muted">No students found.</td></tr>}
              </tbody>
            </table>
          </div>
          {loading && <Spinner />}
          {more && !loading && <Button variant="secondary" onClick={() => void load(cursor)}>Load more</Button>}
        </Card>
      )}
    </>
  );
}

function StudentForm({ initial, onCancel, onSaved }: { initial: Row | null; onCancel: () => void; onSaved: (c: Cred | null) => void }) {
  const { tenantId, uid, tenant, classes, slug } = useTenant();
  const { busy, error, run } = useAction();
  const [f, setF] = useState<StudentInput>(initial ? {
    firstName: initial.firstName, middleName: initial.middleName, lastName: initial.lastName, gender: initial.gender,
    dateOfBirth: initial.dateOfBirth, classId: initial.classId, phone: initial.phone, email: initial.email,
    address: initial.address, admissionNumber: initial.admissionNumber, admissionDate: initial.admissionDate,
  } : blank());
  const [photo, setPhoto] = useState<string | null>(initial?.photo ?? null);
  const [status, setStatus] = useState<StudentStatus>(initial?.status ?? 'ACTIVE');
  const [createLogin, setCreateLogin] = useState(false);
  const [errs, setErrs] = useState<FieldErrors>({});
  const options = classes.filter((c) => isActiveItem(c) || c.id === initial?.classId);
  const set = (k: keyof StudentInput) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const base = `tenants/${tenantId}/students`;
  const prefix = tenant.settings.admissionPrefix ?? defaultAdmissionPrefix(tenant.name);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found = validateStudent(f, new Set(options.map((c) => c.id)));
    setErrs(found);
    if (Object.keys(found).length) return;
    const { db } = firebase();
    const result = await run('saveStudent', async (): Promise<Cred | null | undefined> => {
      if (initial) {
        const ops: Op[] = [{ kind: 'update', path: `${base}/${initial.id}`, data: { ...buildStudentUpdate(f, photo), status } }];
        if (initial.uid && status !== initial.status) {
          ops.push({ kind: 'update', path: `tenants/${tenantId}/members/${initial.uid}`, data: { status: status === 'ACTIVE' ? 'ACTIVE' : 'DISABLED' } });
        }
        ops.push(auditOp(tenantId, uid, newId(), 'student.updated', `students/${initial.id}`));
        await applyOps(db, ops);
        return null;
      }
      let adm = f.admissionNumber.trim().toUpperCase();
      if (adm) {
        if ((await getDoc(doc(db, `${base}/${adm}`))).exists()) throw new UserFacingError(`Admission number ${adm} already exists.`);
      } else {
        const year = Number(f.admissionDate.slice(0, 4));
        adm = (await reserveAdmissionNumbers(db, tenantId, year, prefix, 1))[0] as string;
      }
      const studentOp = (studentUid: string | null): Op => ({
        kind: 'set', path: `${base}/${adm}`,
        data: buildStudentDoc(f, { tenantId, admissionNumber: adm, academicSession: tenant.settings.academicSession, photo, uid: studentUid, createdBy: uid }),
      });
      const audit = auditOp(tenantId, uid, newId(), 'student.created', `students/${adm}`);
      if (!createLogin) { await applyOps(db, [studentOp(null), audit]); return null; }
      if (!slug) throw new UserFacingError('The school address has not loaded yet. Please try again in a moment.');
      const password = generatePassword();
      const name = [f.firstName, f.lastName].join(' ').replace(/\s+/g, ' ').trim();
      await withNewAccount(usernameToEmail(adm, slug), password, async (newUid) => {
        await applyOps(db, [
          studentOp(newUid),
          ...buildMemberOps({ tenantId, uid: newUid, role: 'STUDENT', displayName: name, email: '', loginId: adm }),
          audit,
        ]);
      });
      return { name, loginId: adm, password };
    });
    if (result !== undefined) onSaved(result);
  }

  return (
    <Card title={initial ? `Edit ${initial.admissionNumber}` : 'Add student'}>
      <form onSubmit={submit} noValidate>
        {error && <Alert>{error}</Alert>}
        <div className="grid3">
          <Field label="First name" value={f.firstName} onChange={set('firstName')} error={errs.firstName} required />
          <Field label="Middle name" value={f.middleName} onChange={set('middleName')} error={errs.middleName} />
          <Field label="Last name" value={f.lastName} onChange={set('lastName')} error={errs.lastName} required />
        </div>
        <div className="grid3">
          <div className="field">
            <label htmlFor="gender">Gender</label>
            <select id="gender" value={f.gender} onChange={set('gender')} aria-invalid={errs.gender ? true : undefined}>
              <option value="">Choose…</option><option value="MALE">Male</option><option value="FEMALE">Female</option>
            </select>
            {errs.gender && <small className="err">{errs.gender}</small>}
          </div>
          <Field label="Date of birth" type="date" value={f.dateOfBirth} onChange={set('dateOfBirth')} error={errs.dateOfBirth} required />
          <div className="field">
            <label htmlFor="classId">Class</label>
            <select id="classId" value={f.classId} onChange={set('classId')} aria-invalid={errs.classId ? true : undefined}>
              <option value="">Choose…</option>
              {options.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {errs.classId && <small className="err">{errs.classId}</small>}
          </div>
        </div>
        <div className="grid2">
          <Field label="Phone" type="tel" value={f.phone} onChange={set('phone')} error={errs.phone} />
          <Field label="Email" type="email" value={f.email} onChange={set('email')} error={errs.email} />
        </div>
        <Field label="Address" value={f.address} onChange={set('address')} error={errs.address} />
        <div className="grid2">
          <Field label="Admission date" type="date" value={f.admissionDate} onChange={set('admissionDate')} error={errs.admissionDate} />
          {!initial && <Field label="Admission number" value={f.admissionNumber} onChange={set('admissionNumber')} error={errs.admissionNumber}
            hint={`Leave empty to generate one automatically (e.g. ${prefix}-${new Date().getFullYear()}-0001).`} />}
          {initial && (
            <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value as StudentStatus)}>
              {STUDENT_STATUSES.map((s) => <option key={s} value={s}>{s.charAt(0) + s.slice(1).toLowerCase()}</option>)}
            </Select>
          )}
        </div>
        <PhotoInput value={photo} onChange={setPhoto} />
        {!initial && (
          <label className="inline">
            <input type="checkbox" checked={createLogin} onChange={(e) => setCreateLogin(e.target.checked)} /> Also create a sign-in for this student
            <small> (username = admission number; a temporary password is shown once)</small>
          </label>
        )}
        <div className="row">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button type="submit" busy={busy}>{initial ? 'Save changes' : 'Add student'}</Button>
        </div>
      </form>
    </Card>
  );
}
