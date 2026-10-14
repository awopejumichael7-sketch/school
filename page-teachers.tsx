import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { collection, getDocs, limit, query, serverTimestamp, startAfter, type DocumentData, type QueryDocumentSnapshot } from 'firebase/firestore';
import { sendPasswordResetEmail } from 'firebase/auth';
import { firebase } from './lib-firebase';
import { isActiveItem, useTenant } from './ctx-tenant';
import { Alert, Badge, Button, Card, Field, Spinner } from './ui';
import { CheckGroup, Credentials, PhotoInput, type Cred } from './ui-editors';
import { useAction } from './use-action';
import { applyOps, newId, type Op } from './lib-ops';
import { auditOp, buildMemberOps, generatePassword } from './lib-accounts';
import { withNewAccount } from './lib-newuser';
import { buildTeacherDoc, buildTeacherUpdate, validateTeacher, type FieldErrors } from './lib-people';
import { can } from './lib-permissions';
import type { TeacherDoc } from './types';

type Row = TeacherDoc & { id: string };
const PAGE = 50;

export default function Teachers() {
  const { tenantId, member, classes, subjects } = useTenant();
  const canManage = can(member.role, 'teachers.manage');
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<'new' | Row | null>(null);
  const [creds, setCreds] = useState<Cred[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { busy, error, setError, run } = useAction();

  const load = useCallback(async (after: QueryDocumentSnapshot<DocumentData> | null) => {
    setLoading(true);
    await run('teachers', async () => {
      const base = collection(firebase().db, `tenants/${tenantId}/teachers`);
      const snap = await getDocs(after ? query(base, startAfter(after), limit(PAGE)) : query(base, limit(PAGE)));
      const next = snap.docs.map((d) => ({ ...(d.data() as TeacherDoc), id: d.id }));
      setRows((p) => (after ? [...p, ...next] : next));
      setCursor(snap.docs[snap.docs.length - 1] ?? null);
      setMore(snap.docs.length === PAGE);
    });
    setLoading(false);
  }, [tenantId, run]);
  useEffect(() => { void load(null); }, [load]);

  const names = (ids: string[], list: { id: string; name: string }[]) => ids.map((i) => list.find((x) => x.id === i)?.name ?? i);

  async function toggle(t: Row) {
    const status = t.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    if (status === 'INACTIVE' && !window.confirm(`Deactivate ${t.name}? They will lose access to all school data.`)) return;
    await run('toggleTeacher', async () => {
      const ops: Op[] = [
        { kind: 'update', path: `tenants/${tenantId}/teachers/${t.id}`, data: { status, updatedAt: serverTimestamp() } },
        { kind: 'update', path: `tenants/${tenantId}/members/${t.uid}`, data: { status: status === 'ACTIVE' ? 'ACTIVE' : 'DISABLED' } },
        auditOp(tenantId, member.uid, newId(), status === 'ACTIVE' ? 'teacher.reactivated' : 'teacher.deactivated', `teachers/${t.id}`),
      ];
      await applyOps(firebase().db, ops);
      setRows((p) => p.map((x) => (x.id === t.id ? { ...x, status } : x)));
    });
  }

  async function reset(t: Row) {
    await run('resetTeacher', async () => {
      await sendPasswordResetEmail(firebase().auth, t.email);
      setNotice(`A password reset email was sent to ${t.email}.`);
    });
  }

  return (
    <>
      <h1>Teachers</h1>
      {error && <Alert>{error}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      {creds && <Credentials creds={creds} onClose={() => setCreds(null)} />}
      {editing ? (
        <TeacherForm initial={editing === 'new' ? null : editing} onCancel={() => setEditing(null)}
          onSaved={(c) => { setEditing(null); if (c) setCreds([c]); void load(null); }} />
      ) : (
        <Card actions={canManage ? <Button onClick={() => { setError(null); setNotice(null); setEditing('new'); }}>Add teacher</Button> : undefined}>
          <div className="table-wrap">
            <table>
              <thead><tr><th></th><th>Name</th><th>Email</th><th>Classes</th><th>Subjects</th><th>Status</th>{canManage && <th>Actions</th>}</tr></thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td>{t.photo ? <img className="photo" src={t.photo} alt="" /> : null}</td>
                    <td>{t.name}<br /><small className="muted">{t.teacherId}</small></td>
                    <td>{t.email}</td>
                    <td>{names(t.classes, classes).join(', ') || '—'}</td>
                    <td>{names(t.subjects, subjects).join(', ') || '—'}</td>
                    <td><Badge tone={t.status === 'ACTIVE' ? 'ok' : 'muted'}>{t.status}</Badge></td>
                    {canManage && (
                      <td className="actions">
                        <Button variant="ghost" onClick={() => { setError(null); setNotice(null); setEditing(t); }} aria-label={`Edit ${t.name}`}>Edit</Button>
                        <Button variant="ghost" busy={busy} onClick={() => void toggle(t)} aria-label={`${t.status === 'ACTIVE' ? 'Deactivate' : 'Activate'} ${t.name}`}>{t.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}</Button>
                        <Button variant="ghost" busy={busy} onClick={() => void reset(t)} aria-label={`Send password reset to ${t.name}`}>Reset password</Button>
                      </td>
                    )}
                  </tr>
                ))}
                {rows.length === 0 && !loading && <tr><td colSpan={7} className="muted">No teachers yet.</td></tr>}
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

function TeacherForm({ initial, onCancel, onSaved }: { initial: Row | null; onCancel: () => void; onSaved: (c: Cred | null) => void }) {
  const { tenantId, uid, classes, subjects } = useTenant();
  const { busy, error, run } = useAction();
  const [name, setName] = useState(initial?.name ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [photo, setPhoto] = useState<string | null>(initial?.photo ?? null);
  const [cls, setCls] = useState<string[]>(initial?.classes ?? []);
  const [subs, setSubs] = useState<string[]>(initial?.subjects ?? []);
  const [errs, setErrs] = useState<FieldErrors>({});

  async function submit(e: FormEvent) {
    e.preventDefault();
    const input = { name, email, phone, subjects: subs, classes: cls };
    const found = validateTeacher(input);
    setErrs(found);
    if (Object.keys(found).length) return;
    const { db } = firebase();
    const result = await run('saveTeacher', async (): Promise<Cred | null> => {
      if (initial) {
        await applyOps(db, [
          { kind: 'update', path: `tenants/${tenantId}/teachers/${initial.id}`, data: buildTeacherUpdate(input, photo) },
          { kind: 'update', path: `tenants/${tenantId}/members/${initial.uid}`, data: { displayName: name.trim(), classIds: cls, subjectIds: subs } },
          auditOp(tenantId, uid, newId(), 'teacher.updated', `teachers/${initial.id}`),
        ]);
        return null;
      }
      const password = generatePassword();
      const loginEmail = email.trim();
      await withNewAccount(loginEmail, password, async (newUid) => {
        await applyOps(db, [
          { kind: 'set', path: `tenants/${tenantId}/teachers/${newUid}`, data: buildTeacherDoc(input, { tenantId, uid: newUid, photo, createdBy: uid }) },
          ...buildMemberOps({ tenantId, uid: newUid, role: 'TEACHER', displayName: name.trim(), email: loginEmail, loginId: loginEmail, classIds: cls, subjectIds: subs }),
          auditOp(tenantId, uid, newId(), 'teacher.created', `teachers/${newUid}`),
        ]);
      });
      return { name: name.trim(), loginId: loginEmail, password };
    });
    if (result !== undefined) onSaved(result);
  }

  return (
    <Card title={initial ? `Edit ${initial.name}` : 'Add teacher'}>
      <form onSubmit={submit} noValidate>
        {error && <Alert>{error}</Alert>}
        <Field label="Full name" value={name} onChange={(e) => setName(e.target.value)} error={errs.name} required />
        <div className="grid2">
          <Field label="Email (their sign-in)" type="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errs.email}
            disabled={!!initial} hint={initial ? 'The sign-in email cannot be changed.' : 'A temporary password is generated for them.'} required />
          <Field label="Phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} error={errs.phone} />
        </div>
        <CheckGroup legend="Classes taught" options={classes.filter((c) => isActiveItem(c) || cls.includes(c.id))} value={cls} onChange={setCls} />
        <CheckGroup legend="Subjects taught" options={subjects.filter((c) => isActiveItem(c) || subs.includes(c.id))} value={subs} onChange={setSubs} />
        <PhotoInput value={photo} onChange={setPhoto} />
        <div className="row">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button type="submit" busy={busy}>{initial ? 'Save changes' : 'Add teacher'}</Button>
        </div>
      </form>
    </Card>
  );
}
