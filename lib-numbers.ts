import { doc, runTransaction, type Firestore } from 'firebase/firestore';
import { formatAdmissionNumber } from './lib-people';
import { UserFacingError } from './lib-errors';

/**
 * Atomically reserves `count` consecutive admission numbers for the given year.
 * The counter only ever moves forward (enforced by security rules), so numbers are never reused.
 * Gaps are possible if a later write fails; that is acceptable and safer than reuse.
 */
export async function reserveAdmissionNumbers(
  db: Firestore, tenantId: string, year: number, prefix: string, count: number,
): Promise<string[]> {
  if (!Number.isInteger(count) || count < 1 || count > 500) throw new UserFacingError('Invalid number of admissions.');
  const ref = doc(db, `tenants/${tenantId}/counters/students-${year}`);
  const start = await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists() ? Number((snap.data() as { next: number }).next) : 1;
    tx.set(ref, { next: current + count });
    return current;
  });
  return Array.from({ length: count }, (_, i) => formatAdmissionNumber(prefix, year, start + i));
}
