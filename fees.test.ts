import { describe, it, expect } from 'vitest';
import { parseMoney, formatMoney, toPlain, MAX_MINOR, findMethod, allMethods, PROVIDERS, MANUAL_PROVIDER } from './lib-money';
import {
  feeStatus, validateFeeItem, validateCustomFee, buildFeeDoc, planInvoices, validatePayment, planPayment, planReversal, planCancel,
  buildFeeItemDoc, buildFeeItemUpdate, feeDocId, type FeeRef,
} from './lib-fees';
import { formatReceiptNumber } from './lib-numbers';
import type { Op } from './lib-ops';

describe('money', () => {
  it('parses to integer minor units without floating-point error', () => {
    expect(parseMoney('50000')).toBe(5_000_000);
    expect(parseMoney('₦50,000.50')).toBe(5_000_050);
    expect(parseMoney(' 0.1 ')).toBe(10);
    expect(parseMoney('0.30')).toBe(30);
    expect(parseMoney('19.99')).toBe(1999);          // 19.99*100 would be 1998.9999999999998 in floats
    expect(parseMoney('1,234,567.8')).toBe(123_456_780);
    expect(parseMoney('.5')).toBe(50);
    expect(parseMoney('NGN 2,500')).toBe(250_000);
  });
  it('rejects bad input', () => {
    for (const bad of ['', 'abc', '-5', '-₦5', '+5', '12.345', '1.2.3', '12 34 5x', '1e5', '5-', '$-5', '.', String(MAX_MINOR)]) expect(parseMoney(bad), bad).toBeNull();
    expect(parseMoney(String(MAX_MINOR / 100))).toBe(MAX_MINOR);
  });
  it('formats and round-trips', () => {
    expect(formatMoney(5_000_050, 'USD', 'en-US')).toBe('$50,000.50');
    expect(formatMoney(5_000_050, 'NGN', 'en-NG')).toBe('₦50,000.50');
    expect(formatMoney(100, 'NOPE', 'en-US')).toContain('1.00'); // unknown currency never throws
    expect(toPlain(5_000_050)).toBe('50000.50');
    expect(toPlain(5)).toBe('0.05');
    expect(parseMoney(toPlain(1999))).toBe(1999);
  });
  it('payment methods come from a provider registry (gateway-ready)', () => {
    expect(PROVIDERS).toContain(MANUAL_PROVIDER);
    expect(allMethods().map((m) => m.id)).toEqual(['CASH', 'BANK_TRANSFER', 'POS', 'CHEQUE', 'OTHER']);
    expect(findMethod('CASH')?.referenceRequired).toBe(false);
    expect(findMethod('BANK_TRANSFER')?.referenceRequired).toBe(true);
    expect(findMethod('BITCOIN')).toBeUndefined();
  });
});

const fee = (over: Partial<FeeRef> = {}): FeeRef => ({ id: 'tuition_S1', amount: 5_000_000, amountPaid: 0, studentId: 'S1', studentName: 'Ada Okafor', classId: 'jss-1', description: 'Tuition', ...over });
const who = { tenantId: 't1', uid: 'acct', name: 'Accountant' };

describe('fee status and items', () => {
  it('status is derived from amounts', () => {
    expect(feeStatus(100, 0)).toBe('UNPAID');
    expect(feeStatus(100, 1)).toBe('PARTIAL');
    expect(feeStatus(100, 99)).toBe('PARTIAL');
    expect(feeStatus(100, 100)).toBe('PAID');
  });
  const ok = { name: 'Tuition', category: 'TUITION', amount: 5_000_000, classIds: ['jss-1'], termId: 'term-1', session: '2026/2027' };
  it('validates fee items', () => {
    const classes = new Set(['jss-1']);
    expect(validateFeeItem(ok, classes)).toEqual({});
    expect(Object.keys(validateFeeItem({ name: ' ', category: 'X', amount: null, classIds: [], termId: '', session: '' }, classes)).sort())
      .toEqual(['amount', 'category', 'classIds', 'name', 'session']);
    expect(validateFeeItem({ ...ok, classIds: ['ghost'] }, classes)).toHaveProperty('classIds');
    expect(validateFeeItem({ ...ok, amount: 0 }, classes)).toHaveProperty('amount');
  });
  it('item docs hold integer amounts; updates never touch tenant or creator', () => {
    const d = buildFeeItemDoc(ok, { tenantId: 't1', createdBy: 'a' });
    expect(Number.isInteger(d.amount)).toBe(true);
    expect(d).toMatchObject({ status: 'ACTIVE', tenantId: 't1' });
    const u = buildFeeItemUpdate(ok);
    for (const k of ['tenantId', 'createdBy', 'createdAt', 'status', 'session']) expect(u).not.toHaveProperty(k);
  });
  it('custom fee validation', () => {
    expect(validateCustomFee({ description: 'Uniform', category: 'UNIFORM', amount: 1000, dueDate: '' })).toEqual({});
    expect(validateCustomFee({ description: '', category: 'X', amount: 0, dueDate: '2026-02-30' })).toHaveProperty('dueDate');
  });
});

describe('invoice generation', () => {
  const item = { id: 'tuition', name: 'Tuition', category: 'TUITION', amount: 5_000_000, termId: 't1', session: '2026/2027' };
  const students = [{ id: 'S1', name: 'A', classId: 'c' }, { id: 'S2', name: 'B', classId: 'c' }, { id: 'S3', name: 'C', classId: 'c' }];
  it('creates one unpaid invoice per student with a deterministic id', () => {
    const ops = planInvoices(item, students, new Set(), { tenantId: 't1', createdBy: 'a' });
    expect(ops.map((o) => o.path)).toEqual(['tenants/t1/fees/tuition_S1', 'tenants/t1/fees/tuition_S2', 'tenants/t1/fees/tuition_S3']);
    expect(ops[0]!.data).toMatchObject({ amount: 5_000_000, amountPaid: 0, balance: 5_000_000, status: 'UNPAID', itemId: 'tuition', studentId: 'S1' });
    expect(feeDocId('tuition', 'S1')).toBe('tuition_S1');
  });
  it('is idempotent: running again only bills new students', () => {
    const again = planInvoices(item, students, new Set(['S1', 'S2']), { tenantId: 't1', createdBy: 'a' });
    expect(again.map((o) => o.path)).toEqual(['tenants/t1/fees/tuition_S3']);
    expect(planInvoices(item, students, new Set(['S1', 'S2', 'S3']), { tenantId: 't1', createdBy: 'a' })).toEqual([]);
  });
  it('buildFeeDoc always starts unpaid with balance == amount', () => {
    expect(buildFeeDoc({ tenantId: 't', studentId: 's', studentName: 'n', classId: 'c', itemId: null, description: ' x  y ', category: 'OTHER', amount: 7, session: 's', termId: '', dueDate: '', createdBy: 'a' }))
      .toMatchObject({ description: 'x y', amountPaid: 0, balance: 7, status: 'UNPAID', itemId: null });
  });
});

describe('payments', () => {
  const input = { amount: 1_000_000, date: '2026-10-14', method: 'CASH', reference: '', note: '' };
  it('validates amount, date, method, reference', () => {
    expect(validatePayment(fee(), input, '2026-10-14')).toEqual({});
    expect(validatePayment(fee(), { ...input, amount: 5_000_001 }, '2026-10-14')).toHaveProperty('amount');   // overpayment
    expect(validatePayment(fee(), { ...input, amount: 0 }, '2026-10-14')).toHaveProperty('amount');
    expect(validatePayment(fee(), { ...input, amount: null }, '2026-10-14')).toHaveProperty('amount');
    expect(validatePayment(fee({ amountPaid: 4_500_000 }), { ...input, amount: 600_000 }, '2026-10-14')).toHaveProperty('amount');
    expect(validatePayment(fee({ amountPaid: 4_500_000 }), { ...input, amount: 500_000 }, '2026-10-14')).toEqual({});
    expect(validatePayment(fee(), { ...input, date: '2026-10-15' }, '2026-10-14')).toHaveProperty('date');  // future
    expect(validatePayment(fee(), { ...input, date: '2026-13-01' }, '2026-10-14')).toHaveProperty('date');
    expect(validatePayment(fee(), { ...input, method: 'BITCOIN' }, '2026-10-14')).toHaveProperty('method');
    expect(validatePayment(fee(), { ...input, method: 'BANK_TRANSFER' }, '2026-10-14')).toHaveProperty('reference');
    expect(validatePayment(fee(), { ...input, method: 'BANK_TRANSFER', reference: 'TRX123' }, '2026-10-14')).toEqual({});
    expect(validatePayment(fee({ status: 'CANCELLED' }), input, '2026-10-14')).toHaveProperty('amount');
  });
  it('writes the receipt and the new balance together', () => {
    const { ops, balanceAfter } = planPayment(fee(), { ...input, receiptNumber: 'RCPT-2026-000001' }, who);
    expect(balanceAfter).toBe(4_000_000);
    expect(ops.map((o) => `${o.kind}:${o.path}`)).toEqual(['set:tenants/t1/payments/RCPT-2026-000001', 'update:tenants/t1/fees/tuition_S1']);
    expect(ops[0]!.data).toMatchObject({ kind: 'PAYMENT', amount: 1_000_000, balanceAfter: 4_000_000, reversed: false, reversedBy: null, reverses: null, receiptNumber: 'RCPT-2026-000001', recordedBy: 'acct' });
    expect(ops[1]!.data).toMatchObject({ amountPaid: 1_000_000, balance: 4_000_000, status: 'PARTIAL' });
  });
  it('paying the exact balance marks PAID; overpaying is refused at the plan level too', () => {
    const { ops } = planPayment(fee({ amountPaid: 4_000_000 }), { ...input, receiptNumber: 'R' }, who);
    expect(ops[1]!.data).toMatchObject({ amountPaid: 5_000_000, balance: 0, status: 'PAID' });
    expect(() => planPayment(fee({ amountPaid: 4_500_000 }), { ...input, receiptNumber: 'R' }, who)).toThrow(/more than the outstanding/);
    expect(() => planPayment(fee(), { ...input, amount: 0, receiptNumber: 'R' }, who)).toThrow();
    expect(() => planPayment(fee(), { ...input, amount: 1.5, receiptNumber: 'R' }, who)).toThrow();
  });
  it('reversal restores the balance and links both records', () => {
    const f = fee({ amountPaid: 1_000_000 });
    const { ops, balanceAfter } = planReversal({ id: 'RCPT-2026-000001', feeId: f.id, amount: 1_000_000, kind: 'PAYMENT', reversed: false, method: 'CASH' }, f, 'REV-2026-000001', 'Wrong student', '2026-10-14', who);
    expect(balanceAfter).toBe(5_000_000);
    expect(ops[0]!.data).toMatchObject({ kind: 'REVERSAL', reverses: 'RCPT-2026-000001', amount: 1_000_000, note: 'Wrong student', balanceAfter: 5_000_000 });
    expect(ops[1]).toMatchObject({ kind: 'update', path: 'tenants/t1/payments/RCPT-2026-000001', data: { reversed: true, reversedBy: 'REV-2026-000001' } });
    expect(ops[2]!.data).toMatchObject({ amountPaid: 0, balance: 5_000_000, status: 'UNPAID' });
  });
  it('refuses invalid reversals', () => {
    const base = { id: 'R1', feeId: 'tuition_S1', amount: 100, kind: 'PAYMENT', reversed: false, method: 'CASH' };
    expect(() => planReversal({ ...base, kind: 'REVERSAL' }, fee({ amountPaid: 100 }), 'V', '', '2026-01-01', who)).toThrow(/Only payments/);
    expect(() => planReversal({ ...base, reversed: true }, fee({ amountPaid: 100 }), 'V', '', '2026-01-01', who)).toThrow(/already been reversed/);
    expect(() => planReversal({ ...base, feeId: 'other' }, fee({ amountPaid: 100 }), 'V', '', '2026-01-01', who)).toThrow(/different fee/);
    expect(() => planReversal(base, fee({ amountPaid: 50 }), 'V', '', '2026-01-01', who)).toThrow(/no longer allows/);
  });
  it('cancel only when nothing is paid; un-cancel restores the derived status', () => {
    expect(planCancel(fee(), who, true)[0]!.data).toMatchObject({ status: 'CANCELLED' });
    expect(() => planCancel(fee({ amountPaid: 1 }), who, true)).toThrow(/Reverse the payments/);
    expect(planCancel(fee({ status: 'CANCELLED' }), who, false)[0]!.data).toMatchObject({ status: 'UNPAID' });
  });
  it('receipt numbers are zero-padded and distinct per kind', () => {
    expect(formatReceiptNumber('RCPT', 2026, 7)).toBe('RCPT-2026-000007');
    expect(formatReceiptNumber('REV', 2026, 7)).toBe('REV-2026-000007');
  });
  it('INVARIANT: after any sequence of payments and reversals, balance == amount - (payments - reversals) and status matches', () => {
    // simple deterministic PRNG so failures are reproducible
    let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let round = 0; round < 200; round++) {
      const amount = 100 + Math.floor(rnd() * 1_000_000);
      let f = fee({ amount, amountPaid: 0 });
      const live: { id: string; amount: number }[] = [];
      let sumPay = 0; let sumRev = 0; let n = 0;
      for (let step = 0; step < 25; step++) {
        let ops: Op[];
        if (rnd() < 0.7 || live.length === 0) {
          const bal = f.amount - f.amountPaid; if (bal === 0) continue;
          const amt = 1 + Math.floor(rnd() * bal);
          const id = `R${++n}`;
          ops = planPayment(f, { amount: amt, date: '2026-01-01', method: 'CASH', reference: '', note: '', receiptNumber: id }, who).ops;
          live.push({ id, amount: amt }); sumPay += amt;
        } else {
          const pick = live.splice(Math.floor(rnd() * live.length), 1)[0]!;
          ops = planReversal({ id: pick.id, feeId: f.id, amount: pick.amount, kind: 'PAYMENT', reversed: false, method: 'CASH' }, f, `V${++n}`, '', '2026-01-01', who).ops;
          sumRev += pick.amount;
        }
        const upd = ops.find((o) => o.path.includes('/fees/'))!.data as { amountPaid: number; balance: number; status: string };
        f = { ...f, amountPaid: upd.amountPaid };
        expect(upd.amountPaid).toBe(sumPay - sumRev);
        expect(upd.balance).toBe(amount - (sumPay - sumRev));
        expect(upd.amountPaid).toBeGreaterThanOrEqual(0);
        expect(upd.amountPaid).toBeLessThanOrEqual(amount);
        expect(upd.status).toBe(feeStatus(amount, upd.amountPaid));
        expect(Number.isInteger(upd.balance)).toBe(true);
      }
    }
  });
});
