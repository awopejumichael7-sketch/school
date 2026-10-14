import { useState, type FormEvent } from 'react';
import { updatePassword } from 'firebase/auth';
import { firebase } from './lib-firebase';
import { useAuth } from './ctx-auth';
import { Alert, Button, Field } from './ui';
import { applyOps } from './lib-ops';
import { friendlyError, logTechnical } from './lib-errors';
import { logAudit } from './lib-audit';

/**
 * Shown to accounts created by an administrator. Until the temporary password is replaced, the
 * security rules give the account NO access to school data (see hasRole in firestore.rules).
 */
export default function ChangePassword() {
  const auth = useAuth();
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (pw.length < 8) return setError('Please choose a password of at least 8 characters.');
    if (pw !== again) return setError('The two passwords do not match.');
    const { auth: fa, db } = firebase();
    const user = fa.currentUser;
    if (!user || !auth.tenantId) return setError('Please sign in again.');
    setBusy(true);
    try {
      await updatePassword(user, pw);
      await applyOps(db, [{ kind: 'update', path: `tenants/${auth.tenantId}/members/${user.uid}`, data: { mustChangePassword: false } }]);
      setPw(''); setAgain('');
      await auth.refresh();
      await logAudit(db, auth.tenantId, user.uid, 'auth.password_changed', `members/${user.uid}`);
    } catch (err) {
      logTechnical('changePassword', err);
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <div className="login-card">
        <h1>Choose a new password</h1>
        <p className="muted">Your administrator gave you a temporary password. Set your own now to continue.</p>
        <form onSubmit={submit} noValidate>
          {error && <Alert>{error}</Alert>}
          <Field label="New password" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" hint="At least 8 characters." />
          <Field label="Repeat new password" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
          <Button type="submit" busy={busy}>Save password</Button>
        </form>
        <p><Button variant="ghost" onClick={() => void auth.signOut()}>Sign out</Button></p>
      </div>
    </main>
  );
}
