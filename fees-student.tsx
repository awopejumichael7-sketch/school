import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { collection, doc, getDoc, where } from 'firebase/firestore';
import { firebase } from './lib-firebase';
import { useTenant } from './ctx-tenant';
import { Alert, Badge, Button, Card, Field, Select } from './ui';
import { useAction } from './use-action';
import { applyOps, newId } from './lib-ops';
import { auditOp } from './lib-accounts';
import { allMethods, findMethod, formatMoney, parseMoney, toPlain } from './lib-money';
import {
  buildFeeDoc, FEE_CATEGORIES, planCancel, planPayment, planReversal, validateCustomFee, validatePayment, type FeeRef,
} from './lib-fees';
import { reserveReceiptNumber } from './lib-numbers';
import { getAllDocs } from './lib-query';
import { isValidAdmissionNumber, type FieldErrors } from './lib-people';
import { todayInZone } from './lib-attendance';
import { errorCode, UserFacingError } from './lib-errors';
import type { FeeDoc, PaymentDoc } from './types';

type FeeRow = FeeDoc & { id: string };
type PayRow = PaymentDoc & { id: string };
interface Student { id: string; name: string; classId: string }
const STALE = 'This account changed while you were working, or you do not have permission. The latest figures were reloaded. Please check them and try again.';

export default function StudentAccount({ canManage, initial }: { canManage: boolean; initial: string }) {
  const { tenantId, uid, tenant, member, classes } = useTenant();
  const fmt = (n: number) => formatMoney(n, tenant.settings.currency);
  const today = todayInZone(tenant.settings.timezone);
  const who = { tenantId, uid, name: member.displayName || 'Staff' };
  const [adm, setAdm] = useState(initial);
  const [student, setStudent] = useState<Student | null>(null);
  const [fees, setFees] = useState<FeeRow[]>([]);
  const [payments, setPayments] = useState<PayRow[]>([]);
  const [paying, setPaying] = useState<FeeRow | null>(null);
  const [reversing, setReversing] = useState<PayRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [receipt, setReceipt] = useState<PayRow | null>(null);
  const { busy, error, setError, run } = useAction();

  const fetchAccount = useCallback(async (raw: string) => {
    const id = raw.trim().toUpperCase();
    if (!isValidAdmissionNumber(id)) throw new UserFacingError('No student with that admission number.');
    const { db } = firebase();
    const s = await getDoc(doc(db, `tenants/${tenantId}/students/${id}`));
    if (!s.exists()) throw new UserFacingError('No student with that admission number.');
    const [f, p] = await Promise.all([
      getAllDocs(collection(db, `tenants/${tenantId}/fees`), [where('studentId', '==', id)], 100, 5),
      getAllDocs(collection(db, `tenants/${tenantId}/payments`), [where('studentId', '==', id)], 100, 5),
    ]);
    const stu: Student = { id, name: [s.get('firstName'), s.get('middleName'), s.get('lastName')].filter(Boolean).join(' '), classId: String(s.get('classId')) };
    return {
      stu,
      fees: f.map((d) => ({ ...(d.data() as FeeDoc), id: d.id })),
      payments: p.map((d) => ({ ...(d.data() as PaymentDoc), id: d.id })).sort((a, b) => b.id.localeCompare(a.id)),
    };
  }, [tenantId]);

  const load = useCallback(async (raw: string) => {
    setReceipt(null); setPaying(null); setReversing(null); setAdding(false);
    await run('studentAccount', async () => {
      const a = await fetchAccount(raw);
      setStudent(a.stu); setFees(a.fees); setPayments(a.payments);
    });
  }, [fetchAccount, run]);
  useEffect(() => { if (initial) void load(initial); }, [initial, load]);

  /** Reload after a failed write: someone else may have changed the balance in the meantime. */
  async function refreshAfterConflict(id: string) {
    try { const a = await fetchAccount(id); setFees(a.fees); setPayments(a.payments); } catch { /* the error shown is enough */ }
  }

  const live = fees.filter((f) => f.status !== 'CANCELLED');
  const billed = live.reduce((t, f) => t + f.amount, 0);
  const paid = live.reduce((t, f) => t + f.amountPaid, 0);
  const cat = (id: string) => FEE_CATEGORIES.find((c) => c.id === id)?.label ?? id;
  const refOf = (f: FeeRow): FeeRef => ({ id: f.id, amount: f.amount, amountPaid: f.amountPaid, studentId: f.studentId, studentName: f.studentName, classId: f.classId, description: f.description, status: f.status });

  async function cancel(f: FeeRow, cancelIt: boolean) {
    if (cancelIt && !window.confirm(`Cancel "${f.description}"? The student will no longer owe it.`)) return;
    await run('cancelFee', async () => {
      await applyOps(firebase().db, [...planCancel(refOf(f), who, cancelIt), auditOp(tenantId, uid, newId(), cancelIt ? 'fee.cancelled' : 'fee.restored', `fees/${f.id}`)]);
      const a = await fetchAccount(student!.id); setFees(a.fees); setPayments(a.payments);
    });
  }

  return (
    <>
      <Card title="Find a student">
        <form className="row" onSubmit={(e: FormEvent) => { e.preventDefault(); setError(null); void load(adm); }} noValidate>
          <Field label="Admission number" value={adm} onChange={(e) => setAdm(e.target.value)} />
          <Button type="submit" busy={busy}>Open account</Button>
        </form>
      </Card>
      {error && <Alert>{error}</Alert>}
      {receipt && <Receipt p={receipt} onClose={() => setReceipt(null)} />}
      {student && (
        <>
          <Card title={`${student.name} (${student.id})`} actions={canManage ? <Button variant="secondary" onClick={() => { setError(null); setAdding(true); }}>Add a fee</Button> : undefined}>
            <p className="muted">Class: {classes.find((c) => c.id === student.classId)?.name ?? student.classId}</p>
            <dl className="summary">
              <dt>Billed</dt><dd className="money">{fmt(billed)}</dd>
              <dt>Paid</dt><dd className="money">{fmt(paid)}</dd>
              <dt>Balance</dt><dd className="money"><strong>{fmt(billed - paid)}</strong></dd>
            </dl>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Fee</th><th>Category</th><th>Due</th><th className="money">Amount</th><th className="money">Paid</th><th className="money">Balance</th><th>Status</th>{canManage && <th>Actions</th>}</tr></thead>
                <tbody>
                  {fees.map((f) => (
                    <tr key={f.id}>
                      <td>{f.description}<br /><small className="muted">{f.session}</small></td>
                      <td>{cat(f.category)}</td>
                      <td>{f.dueDate || '—'}</td>
                      <td className="money">{fmt(f.amount)}</td>
                      <td className="money">{fmt(f.amountPaid)}</td>
                      <td className="money">{fmt(f.balance)}</td>
                      <td><Badge tone={f.status === 'PAID' ? 'ok' : f.status === 'PARTIAL' ? 'warn' : f.status === 'CANCELLED' ? 'muted' : 'bad'}>{f.status}</Badge></td>
                      {canManage && (
                        <td className="actions">
                          {f.balance > 0 && f.status !== 'CANCELLED' && <Button onClick={() => { setError(null); setPaying(f); }} aria-label={`Record payment for ${f.description}`}>Record payment</Button>}
                          {f.status !== 'CANCELLED' && f.amountPaid === 0 && <Button variant="ghost" busy={busy} onClick={() => void cancel(f, true)} aria-label={`Cancel ${f.description}`}>Cancel fee</Button>}
                          {f.status === 'CANCELLED' && <Button variant="ghost" busy={busy} onClick={() => void cancel(f, false)} aria-label={`Restore ${f.description}`}>Restore</Button>}
                        </td>
                      )}
                    </tr>
                  ))}
                  {fees.length === 0 && <tr><td colSpan={8} className="muted">No fees billed to this student yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>

          {paying && (
            <PayForm fee={paying} today={today} onCancel={() => setPaying(null)}
              onSubmit={async (v) => {
                const ok = await run('recordPayment', async () => {
                  const { db } = firebase();
                  const receiptNumber = await reserveReceiptNumber(db, tenantId, Number(v.date.slice(0, 4)), 'RCPT');
                  const plan = planPayment(refOf(paying), { amount: v.amount, date: v.date, method: v.method, reference: v.reference, note: v.note, receiptNumber }, who);
                  try {
                    await applyOps(db, [...plan.ops, auditOp(tenantId, uid, newId(), 'payment.recorded', `payments/${receiptNumber}`, { amount: v.amount, feeId: paying.id, receipt: receiptNumber })]);
                  } catch (e) {
                    if (errorCode(e) === 'permission-denied') { await refreshAfterConflict(student.id); throw new UserFacingError(STALE); }
                    throw e;
                  }
                  const a = await fetchAccount(student.id);
                  setFees(a.fees); setPayments(a.payments);
                  setReceipt(a.payments.find((p) => p.id === receiptNumber) ?? null);
                  return true;
                });
                if (ok) setPaying(null);
              }} busy={busy} />
          )}

          {adding && (
            <AddFee onCancel={() => setAdding(false)} busy={busy}
              onSubmit={async (v) => {
                const ok = await run('addFee', async () => {
                  const id = `custom_${newId()}`;
                  await applyOps(firebase().db, [
                    { kind: 'set', path: `tenants/${tenantId}/fees/${id}`, data: buildFeeDoc({ tenantId, studentId: student.id, studentName: student.name, classId: student.classId, itemId: null, description: v.description, category: v.category, amount: v.amount, session: v.session, termId: '', dueDate: v.dueDate, createdBy: uid }) },
                    auditOp(tenantId, uid, newId(), 'fee.created', `fees/${id}`, { amount: v.amount, studentId: student.id }),
                  ]);
                  const a = await fetchAccount(student.id); setFees(a.fees); setPayments(a.payments);
                  return true;
                });
                if (ok) setAdding(false);
              }} />
          )}

          <Card title="Payment history">
            <div className="table-wrap">
              <table>
                <thead><tr><th>Receipt</th><th>Date</th><th>For</th><th className="money">Amount</th><th>Method</th><th>By</th><th></th></tr></thead>
                <tbody>
                  {payments.map((p) => (
                    <tr key={p.id}>
                      <td>{p.receiptNumber} {p.kind === 'REVERSAL' && <Badge tone="warn">reversal</Badge>} {p.reversed && <Badge tone="bad">reversed</Badge>}</td>
                      <td>{p.paymentDate}</td>
                      <td>{p.description}</td>
                      <td className="money">{p.kind === 'REVERSAL' ? `−${fmt(p.amount)}` : fmt(p.amount)}</td>
                      <td>{findMethod(p.method)?.label ?? p.method}</td>
                      <td>{p.recordedByName}</td>
                      <td className="actions">
                        <Button variant="ghost" onClick={() => setReceipt(p)} aria-label={`View receipt ${p.receiptNumber}`}>Receipt</Button>
                        {canManage && p.kind === 'PAYMENT' && !p.reversed && <Button variant="ghost" onClick={() => { setError(null); setReversing(p); }} aria-label={`Reverse payment ${p.receiptNumber}`}>Reverse</Button>}
                      </td>
                    </tr>
                  ))}
                  {payments.length === 0 && <tr><td colSpan={7} className="muted">No payments yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </Card>

          {reversing && (
            <ReverseForm payment={reversing} busy={busy} onCancel={() => setReversing(null)}
              onSubmit={async (reason) => {
                const ok = await run('reversePayment', async () => {
                  const { db } = firebase();
                  const fee = fees.find((f) => f.id === reversing.feeId);
                  if (!fee) throw new UserFacingError('The fee for this payment could not be found.');
                  const number = await reserveReceiptNumber(db, tenantId, Number(today.slice(0, 4)), 'REV');
                  const plan = planReversal({ id: reversing.id, feeId: reversing.feeId, amount: reversing.amount, kind: reversing.kind, reversed: reversing.reversed, method: reversing.method }, refOf(fee), number, reason, today, who);
                  try {
                    await applyOps(db, [...plan.ops, auditOp(tenantId, uid, newId(), 'payment.reversed', `payments/${reversing.id}`, { amount: reversing.amount, reversal: number })]);
                  } catch (e) {
                    if (errorCode(e) === 'permission-denied') { await refreshAfterConflict(student.id); throw new UserFacingError(STALE); }
                    throw e;
                  }
                  const a = await fetchAccount(student.id);
                  setFees(a.fees); setPayments(a.payments);
                  setReceipt(a.payments.find((p) => p.id === number) ?? null);
                  return true;
                });
                if (ok) setReversing(null);
              }} />
          )}
        </>
      )}
    </>
  );
}

function PayForm({ fee, today, busy, onCancel, onSubmit }: {
  fee: FeeRow; today: string; busy: boolean; onCancel: () => void;
  onSubmit: (v: { amount: number; date: string; method: string; reference: string; note: string }) => Promise<void>;
}) {
  const { tenant } = useTenant();
  const [amount, setAmount] = useState(toPlain(fee.balance));
  const [date, setDate] = useState(today);
  const [method, setMethod] = useState('CASH');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [errs, setErrs] = useState<FieldErrors>({});
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseMoney(amount);
    const found = validatePayment(fee, { amount: parsed, date, method, reference, note }, today);
    setErrs(found);
    if (Object.keys(found).length || parsed === null) return;
    await onSubmit({ amount: parsed, date, method, reference, note });
  };
  return (
    <Card title={`Record payment: ${fee.description}`}>
      <p className="muted">Outstanding: {formatMoney(fee.balance, tenant.settings.currency)}</p>
      <form onSubmit={submit} noValidate>
        <div className="grid3">
          <Field label={`Amount (${tenant.settings.currency})`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} error={errs.amount} required />
          <Field label="Payment date" type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} error={errs.date} required />
          <Select label="Method" value={method} onChange={(e) => setMethod(e.target.value)}>
            {allMethods().map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </Select>
        </div>
        <div className="grid2">
          <Field label="Reference" value={reference} onChange={(e) => setReference(e.target.value)} error={errs.reference} hint="Bank/POS reference or cheque number." />
          <Field label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} error={errs.note} />
        </div>
        <div className="row">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button type="submit" busy={busy}>Save payment</Button>
        </div>
      </form>
    </Card>
  );
}

function AddFee({ busy, onCancel, onSubmit }: {
  busy: boolean; onCancel: () => void;
  onSubmit: (v: { description: string; category: string; amount: number; dueDate: string; session: string }) => Promise<void>;
}) {
  const { tenant } = useTenant();
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('OTHER');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [errs, setErrs] = useState<FieldErrors>({});
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = parseMoney(amount);
    const found = validateCustomFee({ description, category, amount: parsed, dueDate });
    setErrs(found);
    if (Object.keys(found).length || parsed === null) return;
    await onSubmit({ description, category, amount: parsed, dueDate, session: tenant.settings.academicSession });
  };
  return (
    <Card title="Add a fee for this student">
      <form onSubmit={submit} noValidate>
        <Field label="Description" value={description} onChange={(e) => setDescription(e.target.value)} error={errs.description} required />
        <div className="grid3">
          <Select label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
            {FEE_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </Select>
          <Field label={`Amount (${tenant.settings.currency})`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} error={errs.amount} required />
          <Field label="Due date (optional)" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} error={errs.dueDate} />
        </div>
        <div className="row">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button type="submit" busy={busy}>Add fee</Button>
        </div>
      </form>
    </Card>
  );
}

function ReverseForm({ payment, busy, onCancel, onSubmit }: { payment: PayRow; busy: boolean; onCancel: () => void; onSubmit: (reason: string) => Promise<void> }) {
  const { tenant } = useTenant();
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<string | undefined>();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (reason.trim().length < 3) return setErr('Say why the payment is being reversed.');
    setErr(undefined);
    await onSubmit(reason.trim());
  };
  return (
    <Card title={`Reverse ${payment.receiptNumber}`}>
      <Alert kind="info">This records a reversal of {formatMoney(payment.amount, tenant.settings.currency)} and puts it back on the student's balance. The original receipt stays on record.</Alert>
      <form onSubmit={submit} noValidate>
        <Field label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} error={err} required />
        <div className="row">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="danger" busy={busy}>Reverse payment</Button>
        </div>
      </form>
    </Card>
  );
}

function Receipt({ p, onClose }: { p: PayRow; onClose: () => void }) {
  const { tenant, profile, classes } = useTenant();
  const fmt = (n: number) => formatMoney(n, tenant.settings.currency);
  const reversal = p.kind === 'REVERSAL';
  return (
    <section aria-label="Receipt">
      <div className="receipt">
        {profile?.logoDataUrl && <img src={profile.logoDataUrl} alt="" style={{ maxHeight: 56 }} />}
        <h2>{tenant.profile.name}</h2>
        <p>{[tenant.profile.address, tenant.profile.phone, tenant.profile.email].filter(Boolean).join(' · ')}</p>
        <h3>{reversal ? 'Payment reversal' : 'Payment receipt'}</h3>
        <table>
          <tbody>
            <tr><th scope="row">Receipt no.</th><td>{p.receiptNumber}</td></tr>
            <tr><th scope="row">Date</th><td>{p.paymentDate}</td></tr>
            <tr><th scope="row">Student</th><td>{p.studentName} ({p.studentId})</td></tr>
            <tr><th scope="row">Class</th><td>{classes.find((c) => c.id === p.classId)?.name ?? p.classId}</td></tr>
            <tr><th scope="row">For</th><td>{p.description}</td></tr>
            <tr><th scope="row">{reversal ? 'Amount reversed' : 'Amount paid'}</th><td><strong>{fmt(p.amount)}</strong></td></tr>
            <tr><th scope="row">Balance after</th><td>{fmt(p.balanceAfter)}</td></tr>
            <tr><th scope="row">Method</th><td>{findMethod(p.method)?.label ?? p.method}</td></tr>
            {p.reference && <tr><th scope="row">Reference</th><td>{p.reference}</td></tr>}
            {p.note && <tr><th scope="row">Note</th><td>{p.note}</td></tr>}
            <tr><th scope="row">Received by</th><td>{p.recordedByName}</td></tr>
          </tbody>
        </table>
        {tenant.profile.footer && <p>{tenant.profile.footer}</p>}
      </div>
      <div className="row">
        <Button onClick={() => window.print()}>Print receipt</Button>
        <Button variant="ghost" onClick={onClose}>Close</Button>
      </div>
    </section>
  );
}
