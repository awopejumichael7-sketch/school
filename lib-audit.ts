import { addDoc, collection, serverTimestamp, type Firestore } from 'firebase/firestore';
import { logTechnical } from './lib-errors';

/**
 * Best-effort audit entry. Rules force actorId == caller and a server timestamp,
 * and make the log append-only. Failures never block the user action.
 * (Spark-only note: entries are client-written, so they prove WHO the platform
 * says wrote them, but a malicious admin could simply omit an entry. Phase 19
 * documents how a Blaze + Cloud Functions upgrade makes this tamper-proof.)
 */
export async function logAudit(
  db: Firestore, tenantId: string, actorId: string, action: string, target: string,
  metadata: Record<string, string | number | boolean | null> = {},
): Promise<void> {
  try {
    await addDoc(collection(db, `tenants/${tenantId}/auditLogs`), {
      actorId, tenantId, action, target, timestamp: serverTimestamp(), metadata,
    });
  } catch (e) {
    logTechnical('audit', e);
  }
}
