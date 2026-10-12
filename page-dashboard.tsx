import { useEffect, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { collection, doc, getDoc, getDocs, limit, orderBy, query } from 'firebase/firestore';
import { firebase } from './lib-firebase';
import { useAuth } from './ctx-auth';
import { Alert, Badge, Button, Card, Spinner, formatDate } from './ui';
import { logTechnical } from './lib-errors';
import { applyBranding, resetBranding } from './lib-theme';
import type { PublicProfile } from './types';

/** Modules arrive phase by phase; shown disabled so nothing looks falsely functional. */
const MODULES: { label: string; phase: number }[] = [
  { label: 'Students', phase: 8 }, { label: 'Teachers', phase: 9 }, { label: 'Attendance', phase: 10 },
  { label: 'Fees', phase: 11 }, { label: 'Assignments', phase: 12 }, { label: 'Exams', phase: 13 },
  { label: 'Results', phase: 14 }, { label: 'Materials', phase: 15 }, { label: 'Notifications', phase: 16 },
  { label: 'Analytics', phase: 17 },
];

export default function Dashboard() {
  const auth = useAuth();
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [classes, setClasses] = useState<string[] | null>(null);
  const [subjects, setSubjects] = useState<string[] | null>(null);
  const tenantId = auth.tenantId;
  const active = auth.tenant?.status === 'ACTIVE'
    && !(auth.tenant.expiresAt && auth.tenant.expiresAt.toDate().getTime() < Date.now());

  useEffect(() => {
    if (!tenantId || !auth.member) return;
    let alive = true;
    const { db } = firebase();
    void getDoc(doc(db, `publicProfiles/${tenantId}`)).then((s) => {
      if (!alive || !s.exists()) return;
      const p = s.data() as PublicProfile;
      setProfile(p);
      applyBranding(p.primaryColor, p.secondaryColor);
    }).catch((e) => logTechnical('profile', e));
    if (active) {
      const names = (col: string, set: (v: string[]) => void) =>
        getDocs(query(collection(db, `tenants/${tenantId}/${col}`), orderBy('order'), limit(100)))
          .then((s) => alive && set(s.docs.map((d) => String(d.get('name')))))
          .catch((e) => { logTechnical(col, e); if (alive) set([]); });
      void names('classes', setClasses);
      void names('subjects', setSubjects);
    }
    return () => { alive = false; resetBranding(); };
  }, [tenantId, auth.member, active]);

  if (auth.status === 'loading') return <main className="center"><Spinner /></main>;
  if (!auth.user || !tenantId || !auth.member) return <Navigate to="/" replace />;
  if (auth.member.status !== 'ACTIVE') {
    return (
      <main className="center narrow">
        <h1>Account disabled</h1>
        <Alert>Your account has been disabled. Please contact your school administrator.</Alert>
        <Button variant="secondary" onClick={() => void auth.signOut()}>Sign out</Button>
      </main>
    );
  }
  if (!auth.tenant) {
    // Do NOT redirect to "/" here: that page redirects back to /app and would loop.
    return (
      <main className="center narrow">
        <h1>Couldn't load your school</h1>
        <Alert>Please check your connection and try again.</Alert>
        <div className="row">
          <Button onClick={() => void auth.refresh()}>Try again</Button>
          <Button variant="secondary" onClick={() => void auth.signOut()}>Sign out</Button>
        </div>
      </main>
    );
  }
  const { tenant, member } = auth;

  if (!active) {
    return (
      <main className="center narrow">
        <h1>Access suspended</h1>
        <Alert>This school's license is not currently active. Please contact the school administrator or support.</Alert>
        {member.role === 'SCHOOL_ADMIN' && (
          <p>If your license was reset by support, <Link to="/activate">restore it with your license key</Link>.</p>
        )}
        <Button variant="secondary" onClick={() => void auth.signOut()}>Sign out</Button>
      </main>
    );
  }

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Main navigation">
        <div className="brand">
          {profile?.logoDataUrl && <img src={profile.logoDataUrl} alt="" />}
          <strong>{tenant.name}</strong>
        </div>
        <nav>
          <a href="#/app" aria-current="page" className="on">Overview</a>
          {MODULES.map((m) => (
            <span key={m.label} className="soon" aria-disabled="true" title={`Planned: Phase ${m.phase}`}>{m.label}</span>
          ))}
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <h1>Overview</h1>
          <div className="row">
            <span className="muted">{member.displayName || auth.user.email} · <Badge tone="muted">{member.role.replace('_', ' ')}</Badge></span>
            <Button variant="secondary" onClick={() => void auth.signOut()}>Sign out</Button>
          </div>
        </header>
        {!tenant.setupComplete && (
          <Alert>School setup did not finish completely. Some classes, subjects or terms may be missing. They can be added once management screens ship in the next phases.</Alert>
        )}
        <div className="cards">
          <Card title="License">
            <dl className="summary">
              <dt>Plan</dt><dd>{tenant.plan}</dd>
              <dt>Status</dt><dd><Badge tone="ok">Active</Badge></dd>
              <dt>Expires</dt><dd>{tenant.expiresAt ? formatDate(tenant.expiresAt) : 'Never'}</dd>
            </dl>
          </Card>
          <Card title="Academic year">
            <dl className="summary">
              <dt>Session</dt><dd>{tenant.settings.academicSession}</dd>
              <dt>Terms</dt><dd>{tenant.settings.terms.join(', ')}</dd>
              <dt>Currency</dt><dd>{tenant.settings.currency}</dd>
              <dt>Timezone</dt><dd>{tenant.settings.timezone}</dd>
            </dl>
          </Card>
          <Card title="Classes">
            {classes === null ? <Spinner /> : classes.length === 0 ? <p className="muted">None yet.</p>
              : <ul className="chips">{classes.map((c) => <li key={c}>{c}</li>)}</ul>}
          </Card>
          <Card title="Subjects">
            {subjects === null ? <Spinner /> : subjects.length === 0 ? <p className="muted">None yet.</p>
              : <ul className="chips">{subjects.map((c) => <li key={c}>{c}</li>)}</ul>}
          </Card>
        </div>
        <footer className="foot muted">{tenant.profile.footer || tenant.name}</footer>
      </div>
      <nav className="bottomnav" aria-label="Mobile navigation">
        <a href="#/app" className="on">Overview</a>
        <span className="soon">More soon</span>
      </nav>
    </div>
  );
}
