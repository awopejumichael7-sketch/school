import { lazy, Suspense, useState, type FormEvent } from 'react';
import { HashRouter, Link, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './ctx-auth';
import { isConfigured } from './lib-firebase';
import { Alert, Button, Field, Spinner } from './ui';
import { isValidSlug, slugify } from './lib-config';

// Route-level code splitting keeps first load small (matters on mobile data).
const Onboarding = lazy(() => import('./page-onboarding'));
const SchoolLogin = lazy(() => import('./page-login'));
const Platform = lazy(() => import('./page-platform'));
const Dashboard = lazy(() => import('./page-dashboard'));

function NotConfigured() {
  return (
    <main className="center narrow">
      <h1>Setup required</h1>
      <Alert kind="info">
        Firebase is not configured yet. Copy <code>.env.example</code> to <code>.env</code>, fill in your Firebase web-app values, then restart. See README.md.
      </Alert>
    </main>
  );
}

function Landing() {
  const nav = useNavigate();
  const auth = useAuth();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (auth.status === 'loading') return <main className="center"><Spinner /></main>;
  if (auth.user && auth.member && auth.tenantId) return <Navigate to="/app" replace />;

  function go(e: FormEvent) {
    e.preventDefault();
    const s = slugify(code);
    if (!isValidSlug(s)) return setError('Enter your school address (at least 3 letters or numbers).');
    nav(`/s/${s}`);
  }
  return (
    <main className="center narrow">
      <h1>School Platform</h1>
      <form onSubmit={go} noValidate>
        {error && <Alert>{error}</Alert>}
        <Field label="Your school address" value={code} onChange={(e) => setCode(e.target.value)}
          hint="Ask your school for this, e.g. royal-scholars" autoComplete="off" />
        <Button type="submit">Go to my school</Button>
      </form>
      <p className="muted">New school? <Link to="/activate">Activate a license</Link></p>
      <p className="muted"><Link to="/platform">Product owner</Link></p>
    </main>
  );
}

export default function App() {
  if (!isConfigured) return <NotConfigured />;
  return (
    <HashRouter>
      <AuthProvider>
        <a className="skip" href="#main">Skip to content</a>
        <div id="main">
          <Suspense fallback={<main className="center"><Spinner /></main>}>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/s/:slug" element={<SchoolLogin />} />
            <Route path="/activate" element={<Onboarding />} />
            <Route path="/platform" element={<Platform />} />
            <Route path="/app/*" element={<Dashboard />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </Suspense>
        </div>
      </AuthProvider>
    </HashRouter>
  );
}
