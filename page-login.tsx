import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import { sendPasswordResetEmail } from 'firebase/auth';
import { firebase } from './lib-firebase';
import { useAuth } from './ctx-auth';
import { Alert, Button, Field, Spinner } from './ui';
import { errorCode, friendlyError, logTechnical } from './lib-errors';
import { applyBranding, resetBranding } from './lib-theme';
import { isValidSlug } from './lib-config';
import { loginIdToEmail } from './lib-accounts';
import type { PublicProfile } from './types';

type Load = { s: 'loading' } | { s: 'missing' } | { s: 'error' } | { s: 'ready'; profile: PublicProfile };

export default function SchoolLogin() {
  const { slug = '' } = useParams();
  const auth = useAuth();
  const [load, setLoad] = useState<Load>({ s: 'loading' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!isValidSlug(slug)) return alive && setLoad({ s: 'missing' });
      try {
        const { db } = firebase();
        const sl = await getDoc(doc(db, `slugs/${slug}`));
        if (!sl.exists()) return alive && setLoad({ s: 'missing' });
        const tenantId = (sl.data() as { tenantId: string }).tenantId;
        const pp = await getDoc(doc(db, `publicProfiles/${tenantId}`));
        if (!pp.exists()) return alive && setLoad({ s: 'missing' });
        const profile = pp.data() as PublicProfile;
        applyBranding(profile.primaryColor, profile.secondaryColor);
        if (alive) setLoad({ s: 'ready', profile });
      } catch (e) {
        logTechnical('loginBranding', e);
        if (alive) setLoad({ s: 'error' });
      }
    })();
    return () => { alive = false; resetBranding(); };
  }, [slug]);

  if (load.s === 'loading') return <main className="center"><Spinner /></main>;
  if (load.s === 'missing') {
    return (
      <main className="center narrow">
        <h1>School not found</h1>
        <p>We couldn't find a school with that address. Please check the link you were given.</p>
        <Link to="/">Back to start</Link>
      </main>
    );
  }
  if (load.s === 'error') {
    return (
      <main className="center narrow">
        <Alert>The school page could not be loaded. Please check your connection and try again.</Alert>
      </main>
    );
  }
  const { profile } = load;

  if (auth.status === 'ready' && auth.user && auth.tenantId === profile.tenantId && auth.member) {
    return <Navigate to="/app" replace />;
  }
  const signedInElsewhere = auth.status === 'ready' && auth.user && auth.tenantId !== profile.tenantId;

  /** Works for people who signed up with a real email. Username-only accounts must ask their administrator. */
  async function forgot() {
    setError(null); setNotice(null);
    if (!email.includes('@')) {
      return setError('Enter the email address you sign in with, then choose "Forgot password?". If you sign in with a username, ask your school administrator.');
    }
    try {
      await sendPasswordResetEmail(firebase().auth, email.trim());
    } catch (err) {
      logTechnical('forgot', err);
      if (errorCode(err) !== 'auth/user-not-found') return setError(friendlyError(err));
    }
    // Same message whether or not the account exists (does not reveal who has an account).
    setNotice('If an account exists for that email, a password reset link has been sent.');
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await auth.signIn(loginIdToEmail(email, slug), password);
      setPassword('');
    } catch (err) {
      logTechnical('login', err);
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <div className="login-card">
        {profile.logoDataUrl && <img className="login-logo" src={profile.logoDataUrl} alt={`${profile.name} logo`} />}
        <h1>{profile.name}</h1>
        {profile.motto && <p className="muted">{profile.motto}</p>}
        {signedInElsewhere ? (
          <>
            <Alert kind="info">You're signed in with an account that doesn't belong to this school.</Alert>
            <Button onClick={() => void auth.signOut()}>Sign out</Button>
          </>
        ) : (
          <form onSubmit={submit} noValidate>
            {error && <Alert>{error}</Alert>}
            <Field label="Email or username" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} required />
            <Field label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            {notice && <Alert kind="info">{notice}</Alert>}
            <Button type="submit" busy={busy}>Sign in</Button>
            <p><Button type="button" variant="ghost" onClick={() => void forgot()}>Forgot password?</Button></p>
          </form>
        )}
        {auth.status === 'ready' && auth.user && auth.tenantId === profile.tenantId && !auth.member && (
          <Alert>Your account is not active for this school. Please contact your administrator.</Alert>
        )}
      </div>
    </main>
  );
}
