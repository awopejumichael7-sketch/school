import { serverTimestamp } from 'firebase/firestore';
import type { Op } from './lib-ops';
import { findMethod, MAX_MINOR } from './lib-money';
import { isValidIsoDate, type FieldErrors } from './lib-people';
import { UserFacingError } from './lib-errors';
import type { FeeCategory, FeeStatus } from './types';

export const FEE_CATEGORIES: { id: FeeCategory; label: string }[] = [
  { id: 'TUITION', label: 'Tuition' }, { id: 'BOOKS', label: 'Books' }, { id: 'UNIFORM', label: 'Uniform' },
  { id: 'TRANSPORT', label: 'Transport' }, { id: 'EXAMINATION', label: 'Examination' }, { id: 'OTHER', label: 'Other' },
];
const isCategory = (v: string) => FEE_CATEGORIES.some((c) => c.id === v);
const clean = (v: string) => v.trim().replace(/\s+/g, ' ');

/** The only place status is derived, so UI, plans and security rules cannot drift apart. */
export function feeStatus(amount: number, paid: number): Exclude<FeeStatus, 'CANCELLED'> {
  if (paid <= 0) return 'UNPAID';
  return paid >= amount ? 'PAID' : 'PARTIAL';
}

// ------------------------------------------------------------------------------- fee items
export interface FeeItemInput {
  name: string; category: string; amount: number | null; classIds: string[]; termId: string; session: string;
}
export function validateFeeItem(i: FeeItemInput, activeClassIds: ReadonlySet<string>): FieldErrors {
  const e: FieldErrors = {};
  if (!clean(i.name)) e.name = 'Enter a name for this fee.';
  else if (clean(i.name).length > 100) e.name = 'Too long (max 100).';
  if (!isCategory(i.category)) e.category = 'Choose a category.';
  if (i.amount === null || i.amount <= 0 || i.amount > MAX_MINOR) e.amount = 'Enter a valid amount (for example 50000 or 50,000.50).';
  if (i.classIds.length === 0) e.classIds = 'Choose at least one class.';
  else if (i.classIds.some((c) => !activeClassIds.has(c))) e.classIds = 'One of the chosen classes is not available.';
  if (!clean(i.session)) e.session = 'Enter the academic session.';
  return e;
}
export function buildFeeItemDoc(i: FeeItemInput, c: { tenantId: string; createdBy: string }): Record<string, unknown> {
  return {
    tenantId: c.tenantId, name: clean(i.name), category: i.category, amount: i.amount, classIds: i.classIds,
    termId: i.termId, session: clean(i.session), status: 'ACTIVE', createdAt: serverTimestamp(), createdBy: c.createdBy,
  };
}
/** Editing an item never changes invoices that were already generated. */
export function buildFeeItemUpdate(i: FeeItemInput): Record<string, unknown> {
  return { name: clean(i.name), category: i.category, amount: i.amount, classIds: i.classIds, termId: i.termId, updatedAt: serverTimestamp() };
}

// ------------------------------------------------------------------------------------ fees
export interface FeeSpec {
  tenantId: string; studentId: string; studentName: string; classId: string; itemId: string | null;
  description: string; category: string; amount: number; session: string; termId: string; dueDate: string; createdBy: string;
}
export const feeDocId = (itemId: string, studentId: string) => `${itemId}_${studentId}`;

export function buildFeeDoc(s: FeeSpec): Record<string, unknown> {
  return {
    tenantId: s.tenantId, studentId: s.studentId, studentName: s.studentName, classId: s.classId, itemId: s.itemId,
    description: clean(s.description), category: s.category, amount: s.amount, amountPaid: 0, balance: s.amount,
    status: 'UNPAID', session: s.session, termId: s.termId, dueDate: s.dueDate,
    createdAt: serverTimestamp(), createdBy: s.createdBy,
  };
}

export function validateCustomFee(i: { description: string; category: string; amount: number | null; dueDate: string }): FieldErrors {
  const e: FieldErrors = {};
  if (!clean(i.description)) e.description = 'Describe the fee.';
  else if (clean(i.description).length > 100) e.description = 'Too long (max 100).';
  if (!isCategory(i.category)) e.category = 'Choose a category.';
  if (i.amount === null || i.amount <= 0 || i.amount > MAX_MINOR) e.amount = 'Enter a valid amount.';
  if (i.dueDate && !isValidIsoDate(i.dueDate)) e.dueDate = 'Enter a valid due date.';
  return e;
}

export interface BillableStudent { id: string; name: string; classId: string }
/** Idempotent: students already billed for this item are skipped, so it is safe to run again after new admissions. */
export function planInvoices(
  item: { id: string; name: string; category: string; amount: number; termId: string; session: string },
  students: BillableStudent[], alreadyBilled: ReadonlySet<string>, ctx: { tenantId: string; createdBy: string },
): Op[] {
  return students.filter((s) => !alreadyBilled.has(s.id)).map((s) => ({
    kind: 'set' as const,
    path: `tenants/${ctx.tenantId}/fees/${feeDocId(item.id, s.id)}`,
    data: buildFeeDoc({
      tenantId: ctx.tenantId, studentId: s.id, studentName: s.name, classId: s.classId, itemId: item.id,
      description: item.name, category: item.category, amount: item.amount, session: item.session, termId: item.termId,
      dueDate: '', createdBy: ctx.createdBy,
    }),
  }));
}

// ---------------------------------------------------------------------------------- payments
export interface FeeRef {
  id: string; amount: number; amountPaid: number; studentId: string; studentName: string; classId: string;
  description: string; status?: string;
}
export interface PaymentInput { amount: number | null; date: string; method: string; reference: string; note: string }
const balanceOf = (f: Pick<FeeRef, 'amount' | 'amountPaid'>) => f.amount - f.amountPaid;

export function validatePayment(fee: Pick<FeeRef, 'amount' | 'amountPaid' | 'status'>, i: PaymentInput, today: string): FieldErrors {
  const e: FieldErrors = {};
  if (fee.status === 'CANCELLED') e.amount = 'This fee has been cancelled.';
  else if (i.amount === null || i.amount <= 0) e.amount = 'Enter a valid amount.';
  else if (i.amount > balanceOf(fee)) e.amount = 'That is more than the outstanding balance.';
  if (!isValidIsoDate(i.date) || i.date > today) e.date = 'Enter a valid payment date (not in the future).';
  const m = findMethod(i.method);
  if (!m) e.method = 'Choose how it was paid.';
  else if (m.referenceRequired && !clean(i.reference)) e.reference = `A reference is required for ${m.label.toLowerCase()} payments.`;
  if (clean(i.reference).length > 100) e.reference = 'Too long (max 100).';
  if (i.note.trim().length > 200) e.note = 'Too long (max 200).';
  return e;
}

export interface Who { tenantId: string; uid: string; name: string }

function paymentDoc(
  f: FeeRef, w: Who,
  p: { kind: 'PAYMENT' | 'REVERSAL'; amount: number; balanceAfter: number; method: string; reference: string; note: string; date: string; receiptNumber: string; reverses: string | null },
): Record<string, unknown> {
  return {
    tenantId: w.tenantId, feeId: f.id, studentId: f.studentId, studentName: f.studentName, classId: f.classId,
    description: f.description, amount: p.amount, balanceAfter: p.balanceAfter, kind: p.kind, method: p.method,
    reference: clean(p.reference), note: p.note.trim(), paymentDate: p.date, receiptNumber: p.receiptNumber,
    reverses: p.reverses, reversed: false, reversedBy: null, recordedBy: w.uid, recordedByName: w.name,
    recordedAt: serverTimestamp(),
  };
}
const feeUpdate = (f: FeeRef, paid: number): Record<string, unknown> => ({
  amountPaid: paid, balance: f.amount - paid, status: feeStatus(f.amount, paid), updatedAt: serverTimestamp(),
});

/** One atomic batch: the receipt AND the new balance are written together or not at all. */
export function planPayment(
  fee: FeeRef, p: { amount: number; date: string; method: string; reference: string; note: string; receiptNumber: string }, w: Who,
): { ops: Op[]; balanceAfter: number } {
  const paid = fee.amountPaid + p.amount;
  if (!Number.isSafeInteger(p.amount) || p.amount <= 0) throw new UserFacingError('Enter a valid amount.');
  if (paid > fee.amount) throw new UserFacingError('That is more than the outstanding balance.');
  const balanceAfter = fee.amount - paid;
  return {
    balanceAfter,
    ops: [
      { kind: 'set', path: `tenants/${w.tenantId}/payments/${p.receiptNumber}`, data: paymentDoc(fee, w, { ...p, kind: 'PAYMENT', balanceAfter, reverses: null }) },
      { kind: 'update', path: `tenants/${w.tenantId}/fees/${fee.id}`, data: feeUpdate(fee, paid) },
    ],
  };
}

export interface PaymentRef { id: string; feeId: string; amount: number; kind: string; reversed: boolean; method: string }
/** Payments are never edited or deleted: a mistake is corrected by a reversal that is itself on the record. */
export function planReversal(
  original: PaymentRef, fee: FeeRef, reversalNumber: string, reason: string, date: string, w: Who,
): { ops: Op[]; balanceAfter: number } {
  if (original.kind !== 'PAYMENT') throw new UserFacingError('Only payments can be reversed.');
  if (original.reversed) throw new UserFacingError('This payment has already been reversed.');
  if (original.feeId !== fee.id) throw new UserFacingError('This payment belongs to a different fee.');
  if (fee.amountPaid < original.amount) throw new UserFacingError('The fee balance no longer allows this reversal.');
  const paid = fee.amountPaid - original.amount;
  const balanceAfter = fee.amount - paid;
  return {
    balanceAfter,
    ops: [
      {
        kind: 'set', path: `tenants/${w.tenantId}/payments/${reversalNumber}`,
        data: paymentDoc(fee, w, { kind: 'REVERSAL', amount: original.amount, balanceAfter, method: original.method, reference: `Reversal of ${original.id}`, note: reason, date, receiptNumber: reversalNumber, reverses: original.id }),
      },
      { kind: 'update', path: `tenants/${w.tenantId}/payments/${original.id}`, data: { reversed: true, reversedBy: reversalNumber } },
      { kind: 'update', path: `tenants/${w.tenantId}/fees/${fee.id}`, data: feeUpdate(fee, paid) },
    ],
  };
}

/** Cancelling is only allowed while nothing has been paid (otherwise reverse the payments first). */
export function planCancel(fee: FeeRef, w: Who, cancel: boolean): Op[] {
  if (cancel && fee.amountPaid > 0) throw new UserFacingError('Reverse the payments on this fee before cancelling it.');
  return [{
    kind: 'update', path: `tenants/${w.tenantId}/fees/${fee.id}`,
    data: { status: cancel ? 'CANCELLED' : feeStatus(fee.amount, fee.amountPaid), updatedAt: serverTimestamp() },
  }];
}
