import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { collection, limit, query, serverTimestamp, where } from 'firebase/firestore';
import { getDocs } from 'firebase/firestore';
import { firebase } from './lib-firebase';
import { isActiveItem, useTenant } from './ctx-tenant';
import { Alert, Badge, Button, Card, Field, Select, Spinner } from './ui';
import { CheckGroup } from './ui-editors';
import { useAction } from './use-action';
import { applyOps, chunkOps, newId, type Op } from './lib-ops';
import { auditOp } from './lib-accounts';
import { formatMoney, parseMoney, toPlain } from './lib-money';
import { buildFeeItemDoc, buildFeeItemUpdate, FEE_CATEGORIES, planInvoices, validateFeeItem, type BillableStudent } from './lib-fees';
import { getAllDocs } from './lib-query';
import type { FieldErrors } from './lib-people';
import type { FeeItemDoc } from './types';

type Item = FeeItemDoc & { id: string };
const BATCH = 8; // 2 rules-access calls per write; the limit is 20 per batch

export default function FeeItems({ canManage }: { canManage: boolean }) {
  const { tenantId, uid, tenant, classes, terms } = useTenant();
  const fmt = (n: number) => formatMoney(n, tenant.settings.currency);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<'new' | Item | null>(null);
  const [plan, setPlan] = useState<{ item: Item; students: BillableStudent[]; already: Set<string> } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: number; failed: number } | null>(null);
  const { busy, error, setError, run } = useAction();

  const load = useCallback(async () => {
    setLoading(true);
    await run('feeItems', async () => {
      const snap = await getDocs(query(collection(firebase().db, `tenants/${tenantId}/feeItems`), limit(100)));
      setItems(snap.docs.map((d) => ({ ...(d.data() as FeeItemDoc), id: d.id })));
    });
    setLoading(false);
  }, [tenantId, run]);
  useEffect(() => { void load(); }, [load]);

  const className = (id: string) => classes.find((c) => c.id === id)?.name ?? id;
  const termName = (id: string) => terms.find((t) => t.id === id)?.name ?? '';

  async function setStatus(it: Item, status: 'ACTIVE' | 'ARCHIVED') {
    await run('feeItemStatus', async () => {
      await applyOps(firebase().db, [
        { kind: 'update', path: `tenants/${tenantId}/feeItems/${it.id}`, data: { status, updatedAt: serverTimestamp() } },
        auditOp(tenantId, uid, newId(), status === 'ARCHIVED' ? 'feeItem.archived' : 'feeItem.restored', `feeItems/${it.id}`),
      ]);
      await load();
    });
  }

  /** Step 1: show exactly who would be billed. Nothing is written yet. */
  async function prepare(it: Item) {
    setResult(null); setPlan(null);
    await run('prepareInvoices', async () => {
      const { db } = firebase();
      const students: BillableStudent[] = [];
      for (const classId of it.classIds) {
        const docs = await getAllDocs(collection(db, `tenants/${tenantId}/students`), [where('classId', '==', classId), where('status', '==', 'ACTIVE')]);
        for (const d of docs) {
          students.push({ id: d.id, classId, name: [d.get('firstName'), d.get('middleName'), d.get('lastName')].filter(Boolean).join(' ') });
        }
      }
      const billed = await getAllDocs(collection(db, `tenants/${tenantId}/fees`), [where('itemId', '==', it.id)]);
      setPlan({ item: it, students, already: new Set(billed.map((d) => String(d.get('studentId')))) });
    });
  }

  /** Step 2: write the invoices in small batches; a failed batch is reported, the rest still go through. */
  async function generate() {
    if (!plan) return;
    const { item, students, already } = plan;
    setResult(null);
    const ops = planInvoices({ id: item.id, name: item.name, category: item.category, amount: item.amount, termId: item.termId, session: item.session },
      students, already, { tenantId, createdBy: uid });
    await run('generateInvoices', async () => {
      const chunks = chunkOps(ops, BATCH);
      let ok = 0; let failed = 0;
      for (let i = 0; i < chunks.length; i++) {
        setProgress(`Creating invoices… ${Math.min((i + 1) * BATCH, ops.length)} of ${ops.length}`);
        try { await applyOps(firebase().db, chunks[i] as Op[]); ok += (chunks[i] as Op[]).length; } catch { failed += (chunks[i] as Op[]).length; }
      }
      if (ok > 0) {
        await applyOps(firebase().db, [auditOp(tenantId, uid, newId(), 'fees.generated', `feeItems/${item.id}`, { count: ok, failed })]).catch(() => undefined);
      }
      setResult({ ok, failed });
      setProgress(null);
      setPlan(null);
    });
    setProgress(null);
  }

  return (
    <>
      {error && <Alert>{error}</Alert>}
      {result && (
        <Alert kind={result.failed ? 'error' : 'success'}>
          {result.ok} invoice{result.ok === 1 ? '' : 's'} created.{result.failed > 0 && ` ${result.failed} could not be saved: run "Generate invoices" again to retry them.`}
        </Alert>
      )}
      {progress && <Alert kind="info">{progress}</Alert>}
      {plan && (
        <Card title={`Generate invoices: ${plan.item.name}`}>
          {(() => {
            const todo = plan.students.filter((s) => !plan.already.has(s.id)).length;
            return (
              <>
                <p><strong>{todo}</strong> student{todo === 1 ? '' : 's'} will be billed {fmt(plan.item.amount)} each ({fmt(todo * plan.item.amount)} in total).
                  {plan.already.size > 0 && ` ${plan.already.size} already have this invoice and are skipped.`}</p>
                <div className="row">
                  <Button busy={busy} disabled={todo === 0} onClick={() => void generate()}>Create {todo} invoice{todo === 1 ? '' : 's'}</Button>
                  <Button variant="ghost" onClick={() => setPlan(null)}>Cancel</Button>
                </div>
              </>
            );
          })()}
        </Card>
      )}
      {editing ? (
        <ItemForm initial={editing === 'new' ? null : editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />
      ) : (
        <Card title="Fee items" actions={canManage ? <Button onClick={() => { setError(null); setEditing('new'); }}>Add fee item</Button> : undefined}>
          <p className="muted">A fee item is a fee that applies to one or more classes (for example "Tuition, Term 1"). Generate invoices to bill every student in those classes.</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Category</th><th className="money">Amount</th><th>Classes</th><th>Term</th><th>Status</th>{canManage && <th>Actions</th>}</tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td>{i.name}<br /><small className="muted">{i.session}</small></td>
                    <td>{FEE_CATEGORIES.find((c) => c.id === i.category)?.label ?? i.category}</td>
                    <td className="money">{fmt(i.amount)}</td>
                    <td>{i.classIds.map(className).join(', ')}</td>
                    <td>{termName(i.termId) || '—'}</td>
                    <td><Badge tone={i.status === 'ACTIVE' ? 'ok' : 'muted'}>{i.status}</Badge></td>
                    {canManage && (
                      <td className="actions">
                        {i.status === 'ACTIVE' && <Button busy={busy} onClick={() => void prepare(i)} aria-label={`Generate invoices for ${i.name}`}>Generate invoices</Button>}
                        <Button variant="ghost" onClick={() => { setError(null); setEditing(i); }} aria-label={`Edit ${i.name}`}>Edit</Button>
                        {i.status === 'ACTIVE'
                          ? <Button variant="ghost" busy={busy} onClick={() => void setStatus(i, 'ARCHIVED')} aria-label={`Archive ${i.name}`}>Archive</Button>
                          : <Button variant="ghost" busy={busy} onClick={() => void setStatus(i, 'ACTIVE')} aria-label={`Restore ${i.name}`}>Restore</Button>}
                      </td>
                    )}
                  </tr>
                ))}
                {items.length === 0 && !loading && <tr><td colSpan={7} className="muted">No fee items yet.</td></tr>}
              </tbody>
            </table>
          </div>
          {loading && <Spinner />}
        </Card>
      )}
    </>
  );
}

function ItemForm({ initial, onCancel, onSaved }: { initial: Item | null; onCancel: () => void; onSaved: () => void }) {
  const { tenantId, uid, tenant, classes, terms } = useTenant();
  const { busy, error, run } = useAction();
  const [name, setName] = useState(initial?.name ?? '');
  const [category, setCategory] = useState<string>(initial?.category ?? 'TUITION');
  const [amountText, setAmountText] = useState(initial ? toPlain(initial.amount) : '');
  const [classIds, setClassIds] = useState<string[]>(initial?.classIds ?? []);
  const [termId, setTermId] = useState(initial?.termId ?? '');
  const [session, setSession] = useState(initial?.session ?? tenant.settings.academicSession);
  const [errs, setErrs] = useState<FieldErrors>({});
  const options = classes.filter((c) => isActiveItem(c) || classIds.includes(c.id));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const input = { name, category, amount: parseMoney(amountText), classIds, termId, session };
    const found = validateFeeItem(input, new Set(options.map((c) => c.id)));
    setErrs(found);
    if (Object.keys(found).length) return;
    const ok = await run('saveFeeItem', async () => {
      const id = initial?.id ?? (name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'fee') + '-' + newId().slice(0, 6);
      const path = `tenants/${tenantId}/feeItems/${id}`;
      await applyOps(firebase().db, [
        initial
          ? { kind: 'update', path, data: buildFeeItemUpdate(input) }
          : { kind: 'set', path, data: buildFeeItemDoc(input, { tenantId, createdBy: uid }) },
        auditOp(tenantId, uid, newId(), initial ? 'feeItem.updated' : 'feeItem.created', path),
      ]);
      return true;
    });
    if (ok) onSaved();
  }

  return (
    <Card title={initial ? `Edit ${initial.name}` : 'Add fee item'}>
      <form onSubmit={submit} noValidate>
        {error && <Alert>{error}</Alert>}
        <div className="grid2">
          <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} error={errs.name} required />
          <Select label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
            {FEE_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </Select>
        </div>
        <div className="grid3">
          <Field label={`Amount per student (${tenant.settings.currency})`} inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} error={errs.amount} required />
          <Select label="Term (optional)" value={termId} onChange={(e) => setTermId(e.target.value)}>
            <option value="">Not term-specific</option>
            {terms.filter(isActiveItem).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
          <Field label="Session" value={session} onChange={(e) => setSession(e.target.value)} error={errs.session} disabled={!!initial} />
        </div>
        <CheckGroup legend="Applies to these classes" options={options} value={classIds} onChange={setClassIds} />
        {errs.classIds && <small className="err">{errs.classIds}</small>}
        {initial && <p className="muted">Changing the amount does not change invoices that were already generated.</p>}
        <div className="row">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button type="submit" busy={busy}>{initial ? 'Save changes' : 'Add fee item'}</Button>
        </div>
      </form>
    </Card>
  );
}
