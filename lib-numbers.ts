import { doc, runTransaction, type Firestore } from 'firebase/firestore';
import { formatAdmissionNumber } from './lib-people';
import { UserFacingError } from './lib-errors';

/**
 * Atomically reserves `count` consecutive numbers from a per-school counter and returns the FIRST one.
 * The counter only ever moves forward (enforced by security rules), so numbers are never reused.
 * Gaps are possible if a later write fails; that is acceptable and safer than reuse.
 */
export async function reserveCounter(db: Firestore, tenantId: string, counterId: string, count: number): Promise<number> {
  if (!Number.isInteger(count) || count < 1 || count > 500) throw new UserFacingError('Invalid quantity requested.');
  const ref = doc(db, `tenants/${tenantId}/counters/${counterId}`);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists() ? Number((snap.data() as { next: number }).next) : 1;
    tx.set(ref, { next: current + count });
    return current;
  });
}

export async function reserveAdmissionNumbers(
  db: Firestore, tenantId: string, year: number, prefix: string, count: number,
): Promise<string[]> {
  const start = await reserveCounter(db, tenantId, `students-${year}`, count);
  return Array.from({ length: count }, (_, i) => formatAdmissionNumber(prefix, year, start + i));
}

/** RCPT-2026-000001 for receipts, REV-2026-000001 for reversals (they share one counter so numbers never clash). */
export const formatReceiptNumber = (kind: 'RCPT' | 'REV', year: number, n: number) => `${kind}-${year}-${String(n).padStart(6, '0')}`;
export async function reserveReceiptNumber(db: Firestore, tenantId: string, year: number, kind: 'RCPT' | 'REV' = 'RCPT'): Promise<string> {
  return formatReceiptNumber(kind, year, await reserveCounter(db, tenantId, `receipts-${year}`, 1));
}
