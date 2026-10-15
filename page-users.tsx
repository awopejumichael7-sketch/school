import { useCallback, useEffect, useState } from 'react';
import { collection, getDocs, limit, orderBy, query, startAfter, type DocumentData, type QueryDocumentSnapshot } from 'firebase/firestore';
import { sendPasswordResetEmail } from 'firebase/auth';
import { firebase } from './lib-firebase';
import { useTenant } from './ctx-tenant';
import { Alert, Badge, Button, Card, Field, Select, Spinner } from './ui';
import { Credentials, type Cred } from './ui-editors';
import { useAction } from './use-action';
import { applyOps, newId } from './lib-ops';
import { auditOp, buildMemberOps, generatePassword, isSyntheticEmail } from './lib-accounts';
import { withNewAccount } from './lib-newuser';
import { looksLikeEmail } from './lib-people';
import { friendlyError, logTechnical } from './lib-errors';
import type { MemberDoc, Role } from './types';

const ROLES: Role[] = ['SCHOOL_ADMIN', 'PRINCIPAL', 'TEACHER', 'STUDENT', 'PARENT', 'ACCOUNTANT', 'STAFF'];
const PAGE = 50;
const STAFF_ROLES: Role[] = ['ACCOUNTANT', 'PRINCIPAL', 'STAFF', 'SCHOOL_ADMIN'];

export default function Users() {
  const { tenantId, uid } = useTenant();
  const [rows, setRows] = useState<MemberDoc[]>([]);
  const [cursor, setCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [creds, setCreds] = useState<Cred[] | null>(null);
  const { busy, error, run } = useAction();

  const load = useCallback(async (after: QueryDocumentSnapshot<DocumentData> | null) => {
    setLoading(true); setLoadError(null);
    try {
      const base = collection(firebase().db, `tenants/${tenantId}/members`);
      const snap = await getDocs(after ? query(base, orderBy('displayName'), startAfter(after), limit(PAGE)) : query(base, orderBy('displayName'), limit(PAGE)));
      const next = snap.docs.map((d) => d.data() as MemberDoc);
      setRows((p) => (after ? [...p, ...next] : next));
      setCursor(snap.docs[snap.docs.length - 1] ?? null);
      setMore(snap.docs.length === PAGE);
    } catch (e) { logTechnical('users', e); setLoadError(friendlyError(e)); }
    finally { setLoading(false); }
  }, [tenantId]);
  useEffect(() => { void load(null); }, [load]);

  const patch = (m: MemberDoc, data: Record<string, unknown>, action: string) => run(action, async () => {
    setNotice(null);
    await applyOps(firebase().db, [
      { kind: 'update', path: `tenants/${tenantId}/members/${m.uid}`, data },
      auditOp(tenantId, uid, newId(), action, `members/${m.uid}`, Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v === 'string')) as Record<string, string>),
    ]);
    setRows((p) => p.map((x) => (x.uid === m.uid ? { ...x, ...data } as MemberDoc : x)));
  });

  const reset = (m: MemberDoc) => run('resetEmail', async () => {
    await sendPasswordResetEmail(firebase().auth, m.email);
    setNotice(`A password reset email was sent to ${m.email}.`);
  });

  return (
    <>
      <h1>Users</h1>
      {creds && <Credentials creds={creds} onClose={() => setCreds(null)} />}
      {adding ? (
        <AddUser onCancel={() => setAdding(false)} onCreated={(c) => { setAdding(false); setCreds([c]); void load(null); }} />
      ) : (
        <p><Button onClick={() => { setNotice(null); setAdding(true); }}>Add staff user</Button></p>
      )}
      <p className="muted">Everyone who can sign in to this school. You cannot change your own role or status, so the school can never lock itself out.</p>
      {(error || loadError) && <Alert>{error ?? loadError}</Alert>}
      {notice && <Alert kind="success">{notice}</Alert>}
      <Card>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Sign-in</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {rows.map((m) => {
                const self = m.uid === uid;
                const realEmail = m.email !== '' && !isSyntheticEmail(m.email);
                return (
                  <tr key={m.uid}>
                    <td>{m.displayName}{self && <> <Badge tone="muted">you</Badge></>}{m.mustChangePassword && <> <Badge tone="warn">new</Badge></>}</td>
                    <td><code>{m.loginId ?? m.email}</code></td>
                    <td>
                      {self ? m.role.replace('_', ' ') : (
                        <Select label={`Role for ${m.displayName}`} value={m.role} disabled={busy} onChange={(e) => void patch(m, { role: e.target.value }, 'user.role_changed')}>
                          {ROLES.map((r) => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}
                        </Select>
                      )}
                    </td>
                    <td><Badge tone={m.status === 'ACTIVE' ? 'ok' : 'bad'}>{m.status}</Badge></td>
                    <td className="actions">
                      {!self && (m.status === 'ACTIVE'
                        ? <Button variant="danger" busy={busy} onClick={() => { if (window.confirm(`Disable ${m.displayName}? They will be signed out of all school data.`)) void patch(m, { status: 'DISABLED' }, 'user.disabled'); }}>Disable</Button>
                        : <Button busy={busy} onClick={() => void patch(m, { status: 'ACTIVE' }, 'user.enabled')}>Enable</Button>)}
                      {realEmail && <Button variant="ghost" busy={busy} onClick={() => void reset(m)}>Send password reset</Button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {loading && <Spinner />}
        {more && !loading && <Button variant="secondary" onClick={() => void load(cursor)}>Load more</Button>}
      </Card>
      <p className="muted">Password resets by email only work for people with a real email address. For username-only accounts (students), create a new account if a password is lost.</p>
    </>
  );
}

/** Accountants, principals, other staff and extra administrators. (Teachers, parents and students have their own screens.) */
function AddUser({ onCancel, onCreated }: { onCancel: () => void; onCreated: (c: Cred) => void }) {
  const { tenantId, uid } = useTenant();
  const { busy, error, setError, run } = useAction();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('ACCOUNTANT');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const n = name.replace(/\s+/g, ' ').trim();
    if (n.length < 2) return setError('Enter the full name.');
    if (!looksLikeEmail(email.trim())) return setError('Enter a valid email address (it is their sign-in).');
    const loginEmail = email.trim();
    const cred = await run('addUser', async () => {
      const password = generatePassword();
      await withNewAccount(loginEmail, password, async (newUid) => {
        await applyOps(firebase().db, [
          ...buildMemberOps({ tenantId, uid: newUid, role, displayName: n, email: loginEmail, loginId: loginEmail }),
          auditOp(tenantId, uid, newId(), 'user.created', `members/${newUid}`, { role }),
        ]);
      });
      return { name: n, loginId: loginEmail, password };
    });
    if (cred) onCreated(cred);
  }
  return (
    <Card title="Add staff user">
      <form onSubmit={submit} noValidate>
        {error && <Alert>{error}</Alert>}
        <div className="grid3">
          <Field label="Full name" value={name} onChange={(e) => setName(e.target.value)} required />
          <Field label="Email (their sign-in)" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <Select label="Role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {STAFF_ROLES.map((r) => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}
          </Select>
        </div>
        <p className="muted">A temporary password is generated and shown once. They must choose their own on first sign-in.</p>
        <div className="row">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button type="submit" busy={busy}>Create user</Button>
        </div>
      </form>
    </Card>
  );
}
