import { lazy, Suspense, type ReactNode } from 'react';
import { Link, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { useAuth } from './ctx-auth';
import { TenantProvider, useTenant } from './ctx-tenant';
import { Alert, Badge, Button, Spinner } from './ui';
import { can, navFor, type Permission } from './lib-permissions';

const Overview = lazy(() => import('./page-overview'));
const Academics = lazy(() => import('./page-academics'));
const Students = lazy(() => import('./page-students'));
const Teachers = lazy(() => import('./page-teachers'));
const Parents = lazy(() => import('./page-parents'));
const Users = lazy(() => import('./page-users'));
const Settings = lazy(() => import('./page-settings'));
const ImportPage = lazy(() => import('./page-import'));
const MyClasses = lazy(() => import('./page-myclasses'));
const Attendance = lazy(() => import('./page-attendance'));
const Fees = lazy(() => import('./page-fees'));
const ChangePassword = lazy(() => import('./page-changepassword'));

/** Modules that arrive in later phases; shown disabled so nothing looks falsely functional. */
const SOON: { label: string; phase: number }[] = [
  { label: 'Assignments', phase: 12 },
  { label: 'Exams', phase: 13 }, { label: 'Results', phase: 14 }, { label: 'Materials', phase: 15 },
  { label: 'Notifications', phase: 16 }, { label: 'Analytics', phase: 17 },
];

export default function Dashboard() {
  const auth = useAuth();
  if (auth.status === 'loading') return <main className="center"><Spinner /></main>;
  if (!auth.user || !auth.tenantId || !auth.member) return <Navigate to="/" replace />;

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
  const active = tenant.status === 'ACTIVE' && !(tenant.expiresAt && tenant.expiresAt.toDate().getTime() < Date.now());
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
  if (member.mustChangePassword) {
    return <Suspense fallback={<main className="center"><Spinner /></main>}><ChangePassword /></Suspense>;
  }
  return (
    <TenantProvider tenantId={auth.tenantId} uid={auth.user.uid} tenant={tenant} member={member}>
      <Shell />
    </TenantProvider>
  );
}

function Guard({ perm, children }: { perm: Permission; children: ReactNode }) {
  const { member } = useTenant();
  if (!can(member.role, perm)) return <Alert>You don't have permission to view this page.</Alert>;
  return <>{children}</>;
}

function Shell() {
  const auth = useAuth();
  const { tenant, member, profile } = useTenant();
  const items = navFor(member.role);
  const link = (to: string, label: string) => (
    <NavLink key={label} to={to === '' ? '/app' : `/app/${to}`} end={to === ''}>{label}</NavLink>
  );
  const showSoon = can(member.role, 'academics.manage');
  return (
    <div className="shell">
      <aside className="sidebar" aria-label="Main navigation">
        <div className="brand">
          {profile?.logoDataUrl && <img src={profile.logoDataUrl} alt="" />}
          <strong>{tenant.name}</strong>
        </div>
        <nav>
          {items.map((n) => link(n.to, n.label))}
          {showSoon && SOON.map((m) => (
            <span key={m.label} className="soon" aria-disabled="true" title={`Planned: Phase ${m.phase}`}>{m.label}</span>
          ))}
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="muted">{member.displayName || auth.user?.email} · <Badge tone="muted">{member.role.replace('_', ' ')}</Badge></span>
          <Button variant="secondary" onClick={() => void auth.signOut()}>Sign out</Button>
        </header>
        <Suspense fallback={<Spinner />}>
          <Routes>
            <Route index element={<Overview />} />
            <Route path="academics" element={<Guard perm="academics.manage"><Academics /></Guard>} />
            <Route path="students" element={<Guard perm="students.read"><Students /></Guard>} />
            <Route path="teachers" element={<Guard perm="teachers.read"><Teachers /></Guard>} />
            <Route path="parents" element={<Guard perm="parents.manage"><Parents /></Guard>} />
            <Route path="attendance" element={<Guard perm="attendance.read"><Attendance /></Guard>} />
            <Route path="fees" element={<Guard perm="fees.read"><Fees /></Guard>} />
            <Route path="users" element={<Guard perm="users.manage"><Users /></Guard>} />
            <Route path="import" element={<Guard perm="import.run"><ImportPage /></Guard>} />
            <Route path="settings" element={<Guard perm="settings.manage"><Settings /></Guard>} />
            <Route path="my-classes" element={<Guard perm="classes.viewAssigned"><MyClasses /></Guard>} />
            <Route path="*" element={<Navigate to="/app" replace />} />
          </Routes>
        </Suspense>
        <footer className="foot muted">{tenant.profile.footer || tenant.name}</footer>
      </div>
      <nav className="bottomnav" aria-label="Mobile navigation">
        {items.map((n) => link(n.to, n.label))}
      </nav>
    </div>
  );
}
