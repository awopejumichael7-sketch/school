import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  collection, doc, getDoc, getDocs, limit, orderBy, query, startAfter, where, Timestamp,
  type DocumentData, type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { firebase } from './lib-firebase';
import { useAuth } from './ctx-auth';
import { Alert, Badge, Button, Card, Field, Select, Spinner, formatDate, toDateInput } from './ui';
import { friendlyError, logTechnical } from './lib-errors';
import { generateLicenses, planLicenseAction, type GeneratedLicense, type LicenseAction } from './lib-licenseAdmin';
import { applyOps, chunkOps } from './lib-ops';
import { hashLicenseKey, normalizeLicenseKey } from './lib-license';
import type { BillingCycle, LicenseDoc, LicenseStatus, TenantDoc } from './types';

const PAGE = 25;
type Row = { id: string; data: LicenseDoc };
const tone = (s: LicenseStatus) => (s === 'ACTIVE' ? 'ok' : s === 'UNUSED' ? 'muted' : 'bad') as 'ok' | 'muted' | 'bad';

export default function Platform() {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<'licenses' | 'tenants'>('licenses');

  if (auth.status === 'loading') return <main className="center"><Spinner /></main>;

  if (!auth.user) {
    return (
      <main className="login">
        <div className="login-card">
          <h1>Product owner sign-in</h1>
          <form noValidate onSubmit={async (e: FormEvent) => {
            e.preventDefault(); setError(null); setBusy(true);
            try { await auth.signIn(email, password); setPassword(''); }
            catch (err) { logTechnical('platformLogin', err); setError(friendlyError(err)); }
            finally { setBusy(false); }
          }}>
            {error && <Alert>{error}</Alert>}
            <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
            <Field label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            <Button type="submit" busy={busy}>Sign in</Button>
          </form>
          <p><Link to="/">Back</Link></p>
        </div>
      </main>
    );
  }

  if (!auth.isPlatformAdmin) {
    return (
      <main className="center narrow">
        <Alert>You don't have permission to view this page.</Alert>
        <Button variant="secondary" onClick={() => void auth.signOut()}>Sign out</Button>
      </main>
    );
  }

  return (
    <main className="console">
      <header className="topbar">
        <h1>Platform console</h1>
        <div className="row">
          <span className="muted">{auth.user.email}</span>
          <Button variant="secondary" onClick={() => void auth.signOut()}>Sign out</Button>
        </div>
      </header>
      <nav className="tabs" aria-label="Sections">
        <button className={tab === 'licenses' ? 'on' : ''} aria-pressed={tab === 'licenses'} onClick={() => setTab('licenses')}>Licenses</button>
        <button className={tab === 'tenants' ? 'on' : ''} aria-pressed={tab === 'tenants'} onClick={() => setTab('tenants')}>Schools</button>
      </nav>
      <Alert kind="info">Privacy: this console shows licenses and school records only. Student, teacher, fee and result data is blocked from the product owner by design.</Alert>
      {tab === 'licenses' ? <Licenses uid={auth.user.uid} /> : <Tenants />}
    </main>
  );
}

// ------------------------------------------------------------------ licenses
function Licenses({ uid }: { uid: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<GeneratedLicense[] | null>(null);
  const [lookup, setLookup] = useState('');

  const loadPage = useCallback(async (after: QueryDocumentSnapshot<DocumentData> | null) => {
    setLoading(true); setError(null);
    try {
      const base = collection(firebase().db, 'licenses');
      const q = after ? query(base, orderBy('createdAt', 'desc'), startAfter(after), limit(PAGE))
                      : query(base, orderBy('createdAt', 'desc'), limit(PAGE));
      const snap = await getDocs(q);
      const next = snap.docs.map((d) => ({ id: d.id, data: d.data() as LicenseDoc }));
      setRows((prev) => (after ? [...prev, ...next] : next));
      setCursor(snap.docs[snap.docs.length - 1] ?? null);
      setMore(snap.docs.length === PAGE);
    } catch (e) { logTechnical('licenses', e); setError(friendlyError(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void loadPage(null); }, [loadPage]);

  const replaceRow = (r: Row) => setRows((prev) => prev.map((x) => (x.id === r.id ? r : x)));

  async function find(e: FormEvent) {
    e.preventDefault(); setError(null);
    const k = normalizeLicenseKey(lookup);
    if (!k) return setError('That is not a valid license key format.');
    try {
      const id = await hashLicenseKey(k);
      const snap = await getDoc(doc(firebase().db, `licenses/${id}`));
      if (!snap.exists()) return setError('No license found for that key.');
      const r = { id, data: snap.data() as LicenseDoc };
      setRows((prev) => [r, ...prev.filter((x) => x.id !== id)]);
      setLookup('');
    } catch (err) { logTechnical('find', err); setError(friendlyError(err)); }
  }

  return (
    <>
      <Generator uid={uid} onDone={(g) => { setGenerated(g); void loadPage(null); }} />
      {generated && <Keys items={generated} onClose={() => setGenerated(null)} />}
      <Card title="Licenses">
        {error && <Alert>{error}</Alert>}
        <form className="row" onSubmit={find} noValidate>
          <Field label="Find by key" value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="SC-XXXX-XXXX-XXXX-XXXX" autoComplete="off" />
          <Button type="submit" variant="secondary">Find</Button>
        </form>
        <div className="table-wrap">
          <table>
            <thead><tr><th>ID</th><th>Plan</th><th>Status</th><th>School</th><th>Activated</th><th>Expires</th><th>Actions</th></tr></thead>
            <tbody>
              {rows.map((r) => <LicenseRow key={r.id} row={r} uid={uid} onChange={replaceRow} />)}
              {rows.length === 0 && !loading && <tr><td colSpan={7} className="muted">No licenses yet.</td></tr>}
            </tbody>
          </table>
        </div>
        {loading && <Spinner />}
        {more && !loading && <Button variant="secondary" onClick={() => void loadPage(cursor)}>Load more</Button>}
      </Card>
    </>
  );
}

function Generator({ uid, onDone }: { uid: string; onDone: (g: GeneratedLicense[]) => void }) {
  const [count, setCount] = useState(1);
  const [plan, setPlan] = useState('standard');
  const [cycle, setCycle] = useState<BillingCycle>('LIFETIME');
  const [expires, setExpires] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!plan.trim()) return setError('Enter a plan name.');
    setBusy(true);
    const made: GeneratedLicense[] = [];
    try {
      const gen = await generateLicenses({
        count, plan: plan.trim(), billingCycle: cycle, note: note.trim(), creatorUid: uid,
        expiresAt: expires ? new Date(`${expires}T23:59:59`) : null,
      });
      // Small chunks keep each batch under the rules' 20 access-call limit.
      for (const chunk of chunkOps(gen.map((g) => g.op), 10)) {
        await applyOps(firebase().db, chunk);
        const paths = new Set(chunk.map((c) => c.path));
        made.push(...gen.filter((g) => paths.has(g.op.path)));
      }
      onDone(made);
    } catch (err) {
      logTechnical('generate', err);
      setError(friendlyError(err));
      if (made.length) onDone(made); // show only the keys that were really saved
    } finally { setBusy(false); }
  }

  return (
    <Card title="Generate licenses">
      <form onSubmit={submit} noValidate>
        {error && <Alert>{error}</Alert>}
        <div className="grid3">
          <Field label="How many (1-100)" type="number" min={1} max={100} value={count} onChange={(e) => setCount(Number(e.target.value))} />
          <Field label="Plan" value={plan} onChange={(e) => setPlan(e.target.value)} />
          <Select label="Billing cycle" value={cycle} onChange={(e) => setCycle(e.target.value as BillingCycle)}>
            <option value="LIFETIME">Lifetime</option><option value="ANNUAL">Annual</option>
            <option value="QUARTERLY">Quarterly</option><option value="MONTHLY">Monthly</option>
          </Select>
        </div>
        <div className="grid2">
          <Field label="Expiry date (optional)" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} hint="Leave empty for no expiry." />
          <Field label="Note (customer name)" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
        </div>
        <Button type="submit" busy={busy}>Generate</Button>
      </form>
    </Card>
  );
}

function Keys({ items, onClose }: { items: GeneratedLicense[]; onClose: () => void }) {
  const text = items.map((i) => i.key).join('\n');
  const [copied, setCopied] = useState(false);
  return (
    <Card title="New license keys">
      <Alert kind="info">Copy or download these now. Only a hash is stored, so the keys can never be shown again.</Alert>
      <pre className="keys" tabIndex={0}>{text}</pre>
      <div className="row">
        <Button onClick={() => { void navigator.clipboard.writeText(text).then(() => setCopied(true)); }}>{copied ? 'Copied' : 'Copy all'}</Button>
        <Button variant="secondary" onClick={() => {
          const url = URL.createObjectURL(new Blob([`license_key\n${text}\n`], { type: 'text/csv' }));
          const a = document.createElement('a'); a.href = url; a.download = 'license-keys.csv'; a.click();
          URL.revokeObjectURL(url);
        }}>Download CSV</Button>
        <Button variant="ghost" onClick={onClose}>I've saved them — hide</Button>
      </div>
    </Card>
  );
}

function LicenseRow({ row, uid, onChange }: { row: Row; uid: string; onChange: (r: Row) => void }) {
  const { id, data } = row;
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [plan, setPlan] = useState(data.plan);
  const [expires, setExpires] = useState(data.expiresAt ? toDateInput(data.expiresAt.toDate()) : '');
  const [history, setHistory] = useState<{ id: string; type: string; at: Timestamp | null }[] | null>(null);

  async function run(action: LicenseAction, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true); setMsg(null);
    try {
      const { db } = firebase();
      await applyOps(db, planLicenseAction(id, data, action, uid));
      const snap = await getDoc(doc(db, `licenses/${id}`));
      if (snap.exists()) onChange({ id, data: snap.data() as LicenseDoc });
      setEditing(false); setHistory(null);
    } catch (e) { logTechnical('licenseAction', e); setMsg(friendlyError(e)); }
    finally { setBusy(false); }
  }

  async function loadHistory() {
    try {
      const snap = await getDocs(query(collection(firebase().db, 'licenseEvents'),
        where('licenseId', '==', id), orderBy('at', 'desc'), limit(20)));
      setHistory(snap.docs.map((d) => ({ id: d.id, type: d.get('type') as string, at: d.get('at') as Timestamp | null })));
    } catch (e) { logTechnical('history', e); setMsg(friendlyError(e)); }
  }

  return (
    <>
      <tr>
        <td><code>{id.slice(0, 8)}</code></td>
        <td>{data.plan}<br /><small className="muted">{data.billingCycle.toLowerCase()}</small></td>
        <td><Badge tone={tone(data.status)}>{data.status}</Badge></td>
        <td>{data.tenantId ? <code>{data.tenantId.slice(0, 8)}</code> : '—'}</td>
        <td>{formatDate(data.activatedAt)}</td>
        <td>{formatDate(data.expiresAt)}</td>
        <td className="actions">
          {data.status !== 'DEACTIVATED' && <Button variant="danger" busy={busy} onClick={() => void run({ type: 'DEACTIVATE' }, 'Deactivate this license? The school (if any) will be locked out immediately.')}>Deactivate</Button>}
          {data.status === 'DEACTIVATED' && <Button busy={busy} onClick={() => void run({ type: 'REACTIVATE' })}>Reactivate</Button>}
          {data.status === 'ACTIVE' && <Button variant="secondary" busy={busy} onClick={() => void run({ type: 'RESET_INSTALLATION' }, 'Reset this installation? The school is locked out until its administrator restores it with the key.')}>Reset</Button>}
          <Button variant="ghost" onClick={() => setEditing(!editing)}>Edit</Button>
          <Button variant="ghost" onClick={() => void loadHistory()}>History</Button>
        </td>
      </tr>
      {(editing || msg || history) && (
        <tr>
          <td colSpan={7}>
            {msg && <Alert>{msg}</Alert>}
            {editing && (
              <div className="grid3">
                <Field label="Plan" value={plan} onChange={(e) => setPlan(e.target.value)} />
                <Field label="Expiry" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
                <div className="row">
                  <Button busy={busy} onClick={() => {
                    const exp = expires ? new Date(`${expires}T23:59:59`) : null;
                    void (async () => {
                      if (plan.trim() && plan.trim() !== data.plan) await run({ type: 'SET_PLAN', plan: plan.trim(), billingCycle: data.billingCycle });
                      const cur = data.expiresAt ? toDateInput(data.expiresAt.toDate()) : '';
                      if (expires !== cur) await run({ type: 'SET_EXPIRY', expiresAt: exp });
                    })();
                  }}>Save</Button>
                </div>
              </div>
            )}
            {history && (
              <ul className="history">
                {history.length === 0 && <li className="muted">No events recorded.</li>}
                {history.map((h) => <li key={h.id}>{h.type} — {h.at ? h.at.toDate().toLocaleString() : ''}</li>)}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ------------------------------------------------------------------- tenants
function Tenants() {
  const [rows, setRows] = useState<{ id: string; data: TenantDoc }[]>([]);
  const [cursor, setCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(async (after: QueryDocumentSnapshot<DocumentData> | null) => {
    setLoading(true); setError(null);
    try {
      const base = collection(firebase().db, 'tenants');
      const q = after ? query(base, orderBy('createdAt', 'desc'), startAfter(after), limit(PAGE))
                      : query(base, orderBy('createdAt', 'desc'), limit(PAGE));
      const snap = await getDocs(q);
      const next = snap.docs.map((d) => ({ id: d.id, data: d.data() as TenantDoc }));
      setRows((p) => (after ? [...p, ...next] : next));
      setCursor(snap.docs[snap.docs.length - 1] ?? null);
      setMore(snap.docs.length === PAGE);
    } catch (e) { logTechnical('tenants', e); setError(friendlyError(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void loadPage(null); }, [loadPage]);

  const expired = (t: TenantDoc) => t.expiresAt !== null && t.expiresAt.toDate().getTime() < Date.now();
  return (
    <Card title="Schools">
      {error && <Alert>{error}</Alert>}
      <div className="table-wrap">
        <table>
          <thead><tr><th>School</th><th>Status</th><th>Plan</th><th>Expires</th><th>Setup</th><th>Created</th></tr></thead>
          <tbody>
            {rows.map(({ id, data }) => (
              <tr key={id}>
                <td>{data.name}<br /><small className="muted"><code>{id.slice(0, 8)}</code></small></td>
                <td><Badge tone={data.status === 'ACTIVE' && !expired(data) ? 'ok' : 'bad'}>{expired(data) ? 'EXPIRED' : data.status}</Badge></td>
                <td>{data.plan}</td>
                <td>{formatDate(data.expiresAt)}</td>
                <td>{data.setupComplete ? 'Complete' : 'Incomplete'}</td>
                <td>{formatDate(data.createdAt)}</td>
              </tr>
            ))}
            {rows.length === 0 && !loading && <tr><td colSpan={6} className="muted">No schools yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {loading && <Spinner />}
      {more && !loading && <Button variant="secondary" onClick={() => void loadPage(cursor)}>Load more</Button>}
    </Card>
  );
}
