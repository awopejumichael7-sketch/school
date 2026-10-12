import { doc, writeBatch, type Firestore } from 'firebase/firestore';

/** A single Firestore write described as plain data, so plans can be unit-tested. */
export interface Op {
  kind: 'set' | 'update';
  /** Slash-separated document path, e.g. "tenants/abc/classes/js1" */
  path: string;
  data: Record<string, unknown>;
}

/**
 * Firestore rules allow at most 20 document-access calls per batched write
 * (and 10 per operation). Batches that touch role-checked collections use
 * about 2 calls per operation, so keep chunks at 9 operations.
 */
export const MAX_OPS_PER_BATCH = 9;

export function chunkOps(ops: Op[], size: number = MAX_OPS_PER_BATCH): Op[][] {
  if (size < 1) throw new Error('size must be >= 1');
  const out: Op[][] = [];
  for (let i = 0; i < ops.length; i += size) out.push(ops.slice(i, i + size));
  return out;
}

export async function applyOps(db: Firestore, ops: Op[]): Promise<void> {
  if (ops.length === 0) return;
  const batch = writeBatch(db);
  for (const op of ops) {
    const ref = doc(db, op.path);
    if (op.kind === 'set') batch.set(ref, op.data);
    else batch.update(ref, op.data);
  }
  await batch.commit();
}

export function newId(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}
