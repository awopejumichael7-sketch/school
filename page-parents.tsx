import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  arrayRemove, arrayUnion, collection, doc, getDoc, getDocs, limit, query, serverTimestamp, startAfter,
  type DocumentData, type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { firebase } from './lib-firebase';
import { useTenant } from './ctx-tenant';
import { Alert, Badge, Button, Card, Field, Spinner } from './ui';
import { Credentials, type Cred } from './ui-editors';
import { useAction } from './use-action';
import { applyOps, newId, type Op } from './lib-ops';
import { auditOp, buildMemberOps, generatePassword, randomString, usernameToEmail } from './lib-accounts';
import { withNewAccount } from './lib-newuser';
import { buildParentDoc, isValidAdmissionNumber, parseAdmissionList, validateParent, type FieldErrors } from './lib-people';
import { UserFacingError } from './lib-errors';
import type { ParentDoc, StudentDoc } from './types';

type Row = ParentDoc & { id: string };
const PAGE = 50;
const MAX_LINK_CHANGES = 6; // keeps one batch under the rules' access-call limit

async function loadStudents(tenantId: string, numbers: string[]): Promise<Map<string, StudentDoc>> {
  const out = new Map<string, StudentDoc>();
  for (const n of numbers) {
    const s = await getDoc(doc(firebase().db, `tenants/${tenantId}/students/${n}`));
    if (!s.exists()) throw new UserFacingError(`No student with admission number ${n}.`);
    out.set(n, s.data() as StudentDoc);
  }
  return out;
}

export default function Parents() {
  const { tenantId, member } = useTenant();
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<'new' | Row | null>(null);
  const [creds, setCreds] = useState<Cred[] | null>(null);
  const { busy, error, setError, run } = useAction();

  const load = useCallback(async (after: QueryDocumentSnapshot<DocumentData> | null) => {
    setLoading(true);
    await run('parents', async () => {
      const base = collection(firebase().db, `tenants/${tenantId}/parents`);
      const snap = await getDocs(after ? query(base, startAfter(after), limit(PAGE)) : query(base, limit(PAGE)));
      const next = snap.docs.map((d) => ({ ...(d.data() as ParentDoc), id: d.id }));
      setRows((p) => (after ? [...p, ...next] : next));
      setCursor(snap.docs[snap.docs.length - 1] ?? null);
      setMore(snap.docs.length === PAGE);
    });
    setLoading(false);
  }, [tenantId, run]);
  useEffect(() => { void load(null); }, [load]);

  async function toggle(p: Row) {
    const status = p.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    if (status === 'INACTIVE' && !window.confirm(`Deactivate ${p.name}? They will lose access.`)) return;
    await run('toggleParent', async () => {
      await applyOps(firebase().db, [
        { kind: 'update', path: `tenants/${tenantId}/parents/${p.id}`, data: { status, updatedAt: serverTimestamp() } },
        { kind: 'update', path: `tenants/${tenantId}/members/${p.uid}`, data: { status: status === 'ACTIVE' ? 'ACTIVE' : 'DISABLED' } },
        auditOp(tenantId, member.uid, newId(), status === 'ACTIVE' ? 'parent.reactivated' : 'parent.deactivated', `parents/${p.id}`),
      ]);
      setRows((r) => r.map((x) => (x.id === p.id ? { ...x, status } : x)));
    });
  }

  return (
    <>
      <h1>Parents</h1>
      {error && <Alert>{error}</Alert>}
      {creds && <Credentials creds={creds} onClose={() => setCreds(null)} />}
      {editing ? (
        <ParentForm initial={editing === 'new' ? null : editing} onCancel={() => setEditing(null)}
          onSaved={(c) => { setEditing(null); if (c) setCreds([c]); void load(null); }} />
      ) : (
        <Card actions={<Button onClick={() => { setError(null); setEditing('new'); }}>Add parent</Button>}>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Sign-in</th><th>Phone</th><th>Children</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td><code>{p.loginId}</code></td>
                    <td>{p.phone || '—'}</td>
                    <td>{p.childIds.join(', ') || '—'}</td>
                    <td><Badge tone={p.status === 'ACTIVE' ? 'ok' : 'muted'}>{p.status}</Badge></td>
                    <td className="actions">
                      <Button variant="ghost" onClick={() => { setError(null); setEditing(p); }} aria-label={`Edit ${p.name}`}>Edit</Button>
                      <Button variant="ghost" busy={busy} onClick={() => void toggle(p)} aria-label={`${p.status === 'ACTIVE' ? 'Deactivate' : 'Activate'} ${p.name}`}>{p.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}</Button>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && !loading && <tr><td colSpan={6} className="muted">No parents yet.</td></tr>}
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

function ParentForm({ initial, onCancel, onSaved }: { initial: Row | null; onCancel: () => void; onSaved: (c: Cred | null) => void }) {
  const { tenantId, uid, slug } = useTenant();
  const { busy, error, run } = useAction();
  const [name, setName] = useState(initial?.name ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [kids, setKids] = useState(initial?.childIds.join(', ') ?? '');
  const [errs, setErrs] = useState<FieldErrors>({});

  async function submit(e: FormEvent) {
    e.preventDefault();
    const numbers = parseAdmissionList(kids).map((n) => n.toUpperCase());
    const input = { name, email, phone, childAdmissionNumbers: initial ? [] : numbers };
    const found = validateParent(input);
    if (initial) {
      if (numbers.length > 20) found.children = 'Too many children (max 20).';
      const bad = numbers.find((n) => !isValidAdmissionNumber(n));
      if (bad) found.children = `"${bad}" is not a valid admission number.`;
    }
    setErrs(found);
    if (Object.keys(found).length) return;
    const { db } = firebase();

    const result = await run('saveParent', async (): Promise<Cred | null> => {
      const check = await loadStudents(tenantId, initial ? numbers.filter((n) => !initial.childIds.includes(n)) : numbers);
      for (const [n, s] of check) if (s.parentIds.length >= 6) throw new UserFacingError(`Student ${n} already has the maximum number of parents.`);

      if (initial) {
        const added = numbers.filter((n) => !initial.childIds.includes(n));
        const removed = initial.childIds.filter((n) => !numbers.includes(n));
        if (added.length + removed.length > MAX_LINK_CHANGES) throw new UserFacingError(`Change at most ${MAX_LINK_CHANGES} children at a time.`);
        const ops: Op[] = [
          { kind: 'update', path: `tenants/${tenantId}/parents/${initial.id}`, data: { name: name.trim(), phone: phone.trim(), email: email.trim(), childIds: numbers, updatedAt: serverTimestamp() } },
          ...added.map((n): Op => ({ kind: 'update', path: `tenants/${tenantId}/students/${n}`, data: { parentIds: arrayUnion(initial.uid), updatedAt: serverTimestamp() } })),
          ...removed.map((n): Op => ({ kind: 'update', path: `tenants/${tenantId}/students/${n}`, data: { parentIds: arrayRemove(initial.uid), updatedAt: serverTimestamp() } })),
        ];
        if (name.trim() !== initial.name) ops.push({ kind: 'update', path: `tenants/${tenantId}/members/${initial.uid}`, data: { displayName: name.trim() } });
        ops.push(auditOp(tenantId, uid, newId(), 'parent.updated', `parents/${initial.id}`));
        await applyOps(db, ops);
        return null;
      }

      const realEmail = email.trim();
      const loginId = realEmail || `parent-${randomString('abcdefghjkmnpqrstvwxyz23456789', 6)}`;
      if (!realEmail && !slug) throw new UserFacingError('The school address has not loaded yet. Please try again in a moment.');
      const authEmail = realEmail || usernameToEmail(loginId, slug as string);
      const password = generatePassword();
      await withNewAccount(authEmail, password, async (newUid) => {
        await applyOps(db, [
          { kind: 'set', path: `tenants/${tenantId}/parents/${newUid}`, data: buildParentDoc(input, { tenantId, uid: newUid, loginId, childIds: numbers, createdBy: uid }) },
          ...buildMemberOps({ tenantId, uid: newUid, role: 'PARENT', displayName: name.trim(), email: realEmail, loginId }),
          ...numbers.map((n): Op => ({ kind: 'update', path: `tenants/${tenantId}/students/${n}`, data: { parentIds: arrayUnion(newUid), updatedAt: serverTimestamp() } })),
          auditOp(tenantId, uid, newId(), 'parent.created', `parents/${newUid}`),
        ]);
      });
      return { name: name.trim(), loginId, password };
    });
    if (result !== undefined) onSaved(result);
  }

  return (
    <Card title={initial ? `Edit ${initial.name}` : 'Add parent'}>
      <form onSubmit={submit} noValidate>
        {error && <Alert>{error}</Alert>}
        <Field label="Full name" value={name} onChange={(e) => setName(e.target.value)} error={errs.name} required />
        <div className="grid2">
          <Field label="Email (their sign-in)" type="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errs.email}
            disabled={!!initial} hint={initial ? 'The sign-in cannot be changed.' : 'Optional. Without an email a username is generated.'} />
          <Field label="Phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} error={errs.phone} />
        </div>
        <Field label="Children (admission numbers)" value={kids} onChange={(e) => setKids(e.target.value)} error={errs.children}
          hint="Separate with commas. One parent account can have several children." />
        <div className="row">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button type="submit" busy={busy}>{initial ? 'Save changes' : 'Add parent'}</Button>
        </div>
      </form>
    </Card>
  );
}
