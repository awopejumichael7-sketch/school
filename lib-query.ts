import { getDocs, limit, query, startAfter, type CollectionReference, type DocumentData, type QueryConstraint, type QueryDocumentSnapshot, type QuerySnapshot } from 'firebase/firestore';

/**
 * Reads every page of a query (bounded so a mistake can never read an entire large collection).
 * Equality filters only, default ordering, so no extra Firestore index is needed.
 */
export async function getAllDocs(
  col: CollectionReference<DocumentData>, constraints: QueryConstraint[], pageSize = 300, maxPages = 20,
): Promise<QueryDocumentSnapshot<DocumentData>[]> {
  const out: QueryDocumentSnapshot<DocumentData>[] = [];
  let last: QueryDocumentSnapshot<DocumentData> | null = null;
  for (let i = 0; i < maxPages; i++) {
    const snap: QuerySnapshot<DocumentData> = await getDocs(query(col, ...constraints, ...(last ? [startAfter(last)] : []), limit(pageSize)));
    out.push(...snap.docs);
    if (snap.docs.length < pageSize) break;
    last = snap.docs[snap.docs.length - 1] ?? null;
  }
  return out;
}
