import { useEffect, useState } from 'react';
import { collection, getDocs, limit, query, where } from 'firebase/firestore';
import { firebase } from './lib-firebase';
import { useTenant } from './ctx-tenant';
import { Alert, Card, Spinner } from './ui';
import { friendlyError, logTechnical } from './lib-errors';

interface Row { id: string; name: string; adm: string }

/** Teachers see ONLY their assigned classes. The security rules enforce this independently of this page. */
export default function MyClasses() {
  const { tenantId, member, classes } = useTenant();
  const assigned = member.classIds ?? [];
  const [data, setData] = useState<Record<string, Row[]> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const out: Record<string, Row[]> = {};
        for (const cid of assigned) {
          const snap = await getDocs(query(
            collection(firebase().db, `tenants/${tenantId}/students`),
            where('classId', '==', cid), where('status', '==', 'ACTIVE'), limit(100),
          ));
          out[cid] = snap.docs.map((d) => ({
            id: d.id, adm: String(d.get('admissionNumber')),
            name: [d.get('firstName'), d.get('middleName'), d.get('lastName')].filter(Boolean).join(' '),
          }));
        }
        if (alive) setData(out);
      } catch (e) {
        logTechnical('myClasses', e);
        if (alive) setError(friendlyError(e));
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, assigned.join('|')]);

  return (
    <>
      <h1>My classes</h1>
      {error && <Alert>{error}</Alert>}
      {assigned.length === 0 && <p className="muted">You have not been assigned to any class yet. Please ask your administrator.</p>}
      {assigned.length > 0 && !data && !error && <Spinner />}
      {assigned.map((cid) => (
        <Card key={cid} title={classes.find((c) => c.id === cid)?.name ?? cid}>
          {!data ? null : (data[cid] ?? []).length === 0 ? <p className="muted">No active students in this class.</p> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Admission no.</th><th>Name</th></tr></thead>
                <tbody>{(data[cid] ?? []).map((s) => <tr key={s.id}><td>{s.adm}</td><td>{s.name}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </Card>
      ))}
    </>
  );
}
