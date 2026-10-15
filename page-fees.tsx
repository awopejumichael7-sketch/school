import { useCallback, useEffect, useState } from 'react';
import {
  collection, count, getAggregateFromServer, getDocs, limit, query, startAfter, sum, where,
  type DocumentData, type QueryConstraint, type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { firebase } from './lib-firebase';
import { isActiveItem, useTenant } from './ctx-tenant';
import { Alert, Badge, Button, Card, Select, Spinner } from './ui';
import { useAction } from './use-action';
import { can } from './lib-permissions';
import { formatMoney, toPlain } from './lib-money';
import { toCsv } from './lib-csv';
import { downloadText } from './lib-download';
import { FEE_CATEGORIES } from './lib-fees';
import FeeItems from './fees-items';
import StudentAccount from './fees-student';
import type { FeeDoc } from './types';

type Tab = 'summary' | 'items' | 'student';
const PAGE = 25;

export default function Fees() {
  const { member } = useTenant();
  const canManage = can(member.role, 'fees.manage');
  const [tab, setTab] = useState<Tab>('summary');
  const [open, setOpen] = useState('');
  return (
    <>
      <h1>Fees</h1>
      <nav className="tabs" aria-label="Fee sections">
        <button className={tab === 'summary' ? 'on' : ''} aria-pressed={tab === 'summary'} onClick={() => setTab('summary')}>Summary &amp; outstanding</button>
        <button className={tab === 'items' ? 'on' : ''} aria-pressed={tab === 'items'} onClick={() => setTab('items')}>Fee items</button>
        <button className={tab === 'student' ? 'on' : ''} aria-pressed={tab === 'student'} onClick={() => setTab('student')}>Student accounts</button>
      </nav>
      {tab === 'summary' && <Summary onOpen={(adm) => { setOpen(adm); setTab('student'); }} />}
      {tab === 'items' && <FeeItems canManage={canManage} />}
      {tab === 'student' && <StudentAccount canManage={canManage} initial={open} />}
    </>
  );
}

type Row = FeeDoc & { id: string };

function Summary({ onOpen }: { onOpen: (admission: string) => void }) {
  const { tenantId, tenant, classes, terms } = useTenant();
  const currency = tenant.settings.currency;
  const fmt = (n: number) => formatMoney(n, currency);
  const [session, setSession] = useState(tenant.settings.academicSession);
  const [termId, setTermId] = useState('');
  const [classId, setClassId] = useState('');
  const [totals, setTotals] = useState<{ billed: number; paid: number; n: number } | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const { busy, error, run } = useAction();

  const filters = useCallback((statuses: string[]): QueryConstraint[] => {
    const f: QueryConstraint[] = [where('session', '==', session.trim()), where('status', 'in', statuses)];
    if (termId) f.push(where('termId', '==', termId));
    if (classId) f.push(where('classId', '==', classId));
    return f;
  }, [session, termId, classId]);

  const loadTotals = useCallback(async () => {
    setTotals(null);
    await run('feeTotals', async () => {
      // Server-side sum(): one billed read per ~1000 invoices instead of reading every invoice.
      const agg = await getAggregateFromServer(
        query(collection(firebase().db, `tenants/${tenantId}/fees`), ...filters(['UNPAID', 'PARTIAL', 'PAID'])),
        { billed: sum('amount'), paid: sum('amountPaid'), n: count() },
      );
      const d = agg.data();
      setTotals({ billed: Number(d.billed), paid: Number(d.paid), n: Number(d.n) });
    });
  }, [tenantId, filters, run]);

  const loadRows = useCallback(async (after: QueryDocumentSnapshot<DocumentData> | null) => {
    setLoading(true);
    await run('outstanding', async () => {
      const cs = [...filters(['UNPAID', 'PARTIAL']), ...(after ? [startAfter(after)] : []), limit(PAGE)];
      const snap = await getDocs(query(collection(firebase().db, `tenants/${tenantId}/fees`), ...cs));
      const next = snap.docs.map((d) => ({ ...(d.data() as FeeDoc), id: d.id }));
      setRows((p) => (after ? [...p, ...next] : next));
      setCursor(snap.docs[snap.docs.length - 1] ?? null);
      setMore(snap.docs.length === PAGE);
    });
    setLoading(false);
  }, [tenantId, filters, run]);

  useEffect(() => { void loadTotals(); void loadRows(null); }, [loadTotals, loadRows]);

  const className = (id: string) => classes.find((c) => c.id === id)?.name ?? id;
  const cat = (id: string) => FEE_CATEGORIES.find((c) => c.id === id)?.label ?? id;
  const outstanding = totals ? totals.billed - totals.paid : 0;
  const rate = totals && totals.billed > 0 ? Math.round((totals.paid / totals.billed) * 10000) / 100 : null;

  function exportCsv() {
    downloadText(`outstanding-fees-${session.replace(/\W+/g, '-')}.csv`, toCsv([
      ['Admission no.', 'Student', 'Class', 'Fee', 'Category', 'Due date', 'Amount', 'Paid', 'Balance', 'Status'],
      ...rows.map((r) => [r.studentId, r.studentName, className(r.classId), r.description, cat(r.category), r.dueDate, toPlain(r.amount), toPlain(r.amountPaid), toPlain(r.balance), r.status]),
    ]));
  }

  return (
    <>
      <Card title="Filters">
        <div className="toolbar">
          <div className="field"><label htmlFor="sess">Session</label><input id="sess" value={session} onChange={(e) => setSession(e.target.value)} /></div>
          <Select label="Term" value={termId} onChange={(e) => setTermId(e.target.value)}>
            <option value="">All terms</option>
            {terms.filter(isActiveItem).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
          <Select label="Class" value={classId} onChange={(e) => setClassId(e.target.value)}>
            <option value="">All classes</option>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </div>
      </Card>
      {error && <Alert>{error}</Alert>}
      <div className="cards">
        <Card title="Billed"><p className="big money">{totals ? fmt(totals.billed) : '…'}</p><p className="muted">{totals ? `${totals.n} invoice${totals.n === 1 ? '' : 's'}` : ''}</p></Card>
        <Card title="Collected"><p className="big money">{totals ? fmt(totals.paid) : '…'}</p><p className="muted">{rate === null ? '' : `${rate}% of billed`}</p></Card>
        <Card title="Outstanding"><p className="big money">{totals ? fmt(outstanding) : '…'}</p></Card>
      </div>
      <Card title="Outstanding balances" actions={<Button variant="secondary" busy={busy} disabled={rows.length === 0} onClick={exportCsv}>Download CSV</Button>}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Student</th><th>Class</th><th>Fee</th><th>Due</th><th className="money">Amount</th><th className="money">Balance</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.studentName}<br /><small className="muted">{r.studentId}</small></td>
                  <td>{className(r.classId)}</td>
                  <td>{r.description}</td>
                  <td>{r.dueDate || '—'}</td>
                  <td className="money">{fmt(r.amount)}</td>
                  <td className="money">{fmt(r.balance)}</td>
                  <td><Badge tone={r.status === 'PARTIAL' ? 'warn' : 'bad'}>{r.status}</Badge></td>
                  <td><Button variant="ghost" onClick={() => onOpen(r.studentId)} aria-label={`Open account of ${r.studentName}`}>Open account</Button></td>
                </tr>
              ))}
              {rows.length === 0 && !loading && <tr><td colSpan={8} className="muted">Nothing outstanding for these filters.</td></tr>}
            </tbody>
          </table>
        </div>
        {loading && <Spinner />}
        {more && !loading && <Button variant="secondary" onClick={() => void loadRows(cursor)}>Load more</Button>}
      </Card>
    </>
  );
}
