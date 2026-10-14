import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { createUserWithEmailAndPassword, signInWithEmailAndPassword } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { firebase } from './lib-firebase';
import { useAuth } from './ctx-auth';
import { Alert, Button, Card, Field, TextArea, Badge } from './ui';
import { friendlyError, logTechnical } from './lib-errors';
import { hashLicenseKey, normalizeLicenseKey } from './lib-license';
import { recordFailure, recordSuccess, secondsLocked } from './lib-throttle';
import {
  DEFAULT_ASSESSMENT, DEFAULT_GRADING, DEFAULT_TERMS, isValidHexColor, isValidSlug, parseList, slugify,
  validateAssessment, validateGrading,
} from './lib-config';
import { buildActivationPlan, buildReactivationPlan, type ActivationPlan } from './lib-activation';
import { applyOps, newId } from './lib-ops';
import { fileToLogoDataUrl } from './lib-image';
import { AssessmentEditor, GradingEditor } from './ui-editors';
import { applyBranding, DEFAULT_PRIMARY, DEFAULT_SECONDARY } from './lib-theme';
import { logAudit } from './lib-audit';
import type { AssessmentWeight, GradeBand, LicenseDoc, SchoolProfile } from './types';

type Step = 'key' | 'account' | 'school' | 'academic' | 'review' | 'restore';
const STEPS: { id: Step; label: string }[] = [
  { id: 'key', label: 'License' },
  { id: 'account', label: 'Administrator' },
  { id: 'school', label: 'School' },
  { id: 'academic', label: 'Academics' },
  { id: 'review', label: 'Finish' },
];
const COMMON_CURRENCIES = ['NGN', 'USD', 'GBP', 'EUR', 'GHS', 'KES', 'ZAR', 'XOF', 'CAD', 'AUD', 'INR'];

function validTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat(undefined, { timeZone: tz }); return tz.length > 0; } catch { return false; }
}
const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

export default function Onboarding() {
  const nav = useNavigate();
  const auth = useAuth();
  const [step, setStep] = useState<Step>('key');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // --- license ---
  const [keyInput, setKeyInput] = useState('');
  const [verified, setVerified] = useState<{ hash: string; license: LicenseDoc } | null>(null);

  // --- account ---
  const [mode, setMode] = useState<'create' | 'signin'>('create');
  const [adminName, setAdminName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // --- school ---
  const [profile, setProfile] = useState<SchoolProfile>({
    name: '', motto: '', address: '', phone: '', email: '', website: '', footer: '', emailSenderName: '',
  });
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [primary, setPrimary] = useState(DEFAULT_PRIMARY);
  const [secondary, setSecondary] = useState(DEFAULT_SECONDARY);
  const [logo, setLogo] = useState<string | null>(null);

  // --- academics ---
  const [session, setSession] = useState(() => {
    const y = new Date().getFullYear();
    return `${y}/${y + 1}`;
  });
  const [termsText, setTermsText] = useState(DEFAULT_TERMS.join(', '));
  const [classesText, setClassesText] = useState('Class 1, Class 2, Class 3, Class 4, Class 5, Class 6');
  const [subjectsText, setSubjectsText] = useState('Mathematics, English Language, Science, Social Studies');
  const [currency, setCurrency] = useState('NGN');
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [grading, setGrading] = useState<GradeBand[]>(DEFAULT_GRADING);
  const [assessment, setAssessment] = useState<AssessmentWeight[]>(DEFAULT_ASSESSMENT);

  // --- activation progress ---
  const ids = useRef({ tenantId: newId(), installationId: newId() });
  const planRef = useRef<ActivationPlan | null>(null);
  const [resumeAt, setResumeAt] = useState<number | null>(null);

  const timezones = useMemo(
    () => (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [],
    [],
  );
  const currentIndex = STEPS.findIndex((s) => s.id === step);

  function fail(e: unknown, ctx: string) {
    logTechnical(ctx, e);
    setError(friendlyError(e));
  }

  // ---------------------------------------------------------------- step 1
  async function verifyKey(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const wait = secondsLocked();
    if (wait > 0) return setError(`Too many attempts. Please wait ${wait} seconds and try again.`);
    const canonical = normalizeLicenseKey(keyInput);
    if (!canonical) {
      recordFailure();
      return setError('That does not look like a valid license key. Please check for typos.');
    }
    setBusy(true);
    try {
      const hash = await hashLicenseKey(canonical);
      const snap = await getDoc(doc(firebase().db, `licenses/${hash}`));
      if (!snap.exists()) {
        recordFailure();
        return setError('This license key is not valid.');
      }
      const license = snap.data() as LicenseDoc;
      if (license.status === 'ACTIVE') return setError('This license key has already been activated.');
      if (license.status === 'DEACTIVATED') return setError('This license has been deactivated. Please contact support.');
      if (license.expiresAt && license.expiresAt.toDate().getTime() < Date.now()) {
        return setError('This license key has expired. Please contact support.');
      }
      recordSuccess();
      setVerified({ hash, license });
      setMode(license.status === 'RESET' ? 'signin' : 'create');
      setStep(license.status === 'RESET' ? 'restore' : 'account');
    } catch (err) {
      fail(err, 'verifyKey');
    } finally {
      setBusy(false);
    }
  }

  // ---------------------------------------------------------------- step 2
  async function submitAccount(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!looksLikeEmail(email.trim())) return setError('Please enter a valid email address.');
    if (mode === 'create') {
      if (adminName.trim().length < 2) return setError("Please enter the administrator's name.");
      if (password.length < 8) return setError('Please choose a password of at least 8 characters.');
    }
    setBusy(true);
    try {
      const { auth: fa } = firebase();
      if (mode === 'create') await createUserWithEmailAndPassword(fa, email.trim(), password);
      else await signInWithEmailAndPassword(fa, email.trim(), password);
      setPassword('');
      await auth.refresh();
      if (step === 'account') setStep('school');
    } catch (err) {
      fail(err, 'account');
    } finally {
      setBusy(false);
    }
  }

  // ---------------------------------------------------------------- step 3
  function nextSchool(e: FormEvent) {
    e.preventDefault();
    void (async () => {
      setError(null);
      const p = profile;
      if (p.name.trim().length < 2) return setError('Please enter the school name.');
      if (!isValidSlug(slug)) return setError('The school address must be 3-40 characters: lowercase letters, numbers and dashes.');
      if (p.email && !looksLikeEmail(p.email)) return setError('Please enter a valid school email address.');
      if (!isValidHexColor(primary) || !isValidHexColor(secondary)) return setError('Please choose valid theme colours.');
      setBusy(true);
      try {
        const taken = await getDoc(doc(firebase().db, `slugs/${slug}`));
        if (taken.exists()) return setError('That school address is already in use. Please choose another.');
        setStep('academic');
      } catch (err) {
        fail(err, 'slugCheck');
      } finally {
        setBusy(false);
      }
    })();
  }

  async function onLogo(file: File | undefined) {
    if (!file) return;
    setError(null);
    try { setLogo(await fileToLogoDataUrl(file)); } catch (err) { fail(err, 'logo'); }
  }

  // ---------------------------------------------------------------- step 4
  const terms = parseList(termsText, 12);
  const classes = parseList(classesText, 60);
  const subjects = parseList(subjectsText, 100);

  function nextAcademic(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!session.trim()) return setError('Please enter the academic session.');
    if (terms.length === 0) return setError('Add at least one term.');
    if (classes.length === 0) return setError('Add at least one class.');
    if (subjects.length === 0) return setError('Add at least one subject.');
    if (!/^[A-Z]{3}$/.test(currency)) return setError('Currency must be a 3-letter code such as NGN or USD.');
    if (!validTimezone(timezone)) return setError('Please choose a valid timezone.');
    const g = validateGrading(grading);
    if (!g.ok) return setError(g.errors[0] ?? 'Check the grading bands.');
    const a = validateAssessment(assessment);
    if (!a.ok) return setError(a.errors[0] ?? 'Check the assessment weights.');
    setStep('review');
  }

  // ---------------------------------------------------------------- step 5
  async function runConfig(plan: ActivationPlan, from: number) {
    const { db } = firebase();
    for (let i = from; i < plan.config.length; i++) {
      try {
        await applyOps(db, plan.config[i] ?? []);
      } catch (err) {
        setResumeAt(i);
        fail(err, 'config batch');
        return;
      }
    }
    setResumeAt(null);
    await auth.refresh();
    nav('/app', { replace: true });
  }

  async function activate() {
    setError(null);
    const user = firebase().auth.currentUser;
    if (!verified || !user) return setError('Please start again from the license step.');
    if (auth.tenantId) return setError('This account already belongs to a school. Please use a different email address.');
    setBusy(true);
    const plan = buildActivationPlan({
      licenseHash: verified.hash,
      license: { plan: verified.license.plan, expiresAt: verified.license.expiresAt ?? null },
      uid: user.uid,
      adminName: adminName.trim() || user.displayName || user.email || 'Administrator',
      adminEmail: user.email ?? email.trim(),
      tenantId: ids.current.tenantId,
      installationId: ids.current.installationId,
      slug,
      profile: { ...profile, name: profile.name.trim(), emailSenderName: profile.emailSenderName.trim() || profile.name.trim() },
      logoDataUrl: logo,
      primaryColor: primary,
      secondaryColor: secondary,
      settings: {
        academicSession: session.trim(), terms, currency, timezone,
        grading, assessment,
      },
      classes, subjects,
    });
    planRef.current = plan;
    try {
      await applyOps(firebase().db, plan.core); // one atomic batch: license bind + tenant + admin
    } catch (err) {
      logTechnical('activation core', err);
      // Tell the user the real reason if someone else just used the key.
      try {
        const fresh = await getDoc(doc(firebase().db, `licenses/${verified.hash}`));
        if (fresh.exists() && (fresh.data() as LicenseDoc).status !== 'UNUSED') {
          setError('This license key has already been activated.');
          setBusy(false);
          return;
        }
      } catch { /* fall through to the generic message */ }
      setError(friendlyError(err));
      setBusy(false);
      return;
    }
    await runConfig(plan, 0);
    setBusy(false);
  }

  async function retryConfig() {
    if (!planRef.current || resumeAt === null) return;
    setBusy(true); setError(null);
    await runConfig(planRef.current, resumeAt);
    setBusy(false);
  }

  // --------------------------------------------------------------- restore
  async function restore() {
    setError(null);
    const user = firebase().auth.currentUser;
    if (!verified || !user) return;
    const tenantId = auth.tenantId;
    if (!tenantId || auth.member?.role !== 'SCHOOL_ADMIN' || tenantId !== verified.license.tenantId) {
      return setError('Only the administrator of the school this license belongs to can restore it.');
    }
    setBusy(true);
    try {
      const { db } = firebase();
      await applyOps(db, buildReactivationPlan({
        licenseHash: verified.hash, tenantId, uid: user.uid, installationId: newId(),
      }));
      await logAudit(db, tenantId, user.uid, 'license.restored', `licenses/${verified.hash.slice(0, 8)}`);
      await auth.refresh();
      nav('/app', { replace: true });
    } catch (err) {
      fail(err, 'restore');
    } finally {
      setBusy(false);
    }
  }

  // ================================================================ render
  const signedInEmail = auth.user?.email;
  const accountForm = (
    <form onSubmit={submitAccount} noValidate>
      {mode === 'create' && <Field label="Administrator name" value={adminName} onChange={(e) => setAdminName(e.target.value)} autoComplete="name" required />}
      <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
      <Field label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
        autoComplete={mode === 'create' ? 'new-password' : 'current-password'} hint={mode === 'create' ? 'At least 8 characters.' : undefined} required />
      <div className="row">
        <Button type="submit" busy={busy}>{mode === 'create' ? 'Create account & continue' : 'Sign in & continue'}</Button>
        {step === 'account' && (
          <Button type="button" variant="ghost" onClick={() => { setMode(mode === 'create' ? 'signin' : 'create'); setError(null); }}>
            {mode === 'create' ? 'I already have an account' : 'Create a new account'}
          </Button>
        )}
      </div>
    </form>
  );

  return (
    <main className="wizard">
      <p><Link to="/">← Back</Link></p>
      <h1>Activate your school</h1>
      {step !== 'restore' && (
        <ol className="steps" aria-label="Progress">
          {STEPS.map((s, i) => (
            <li key={s.id} aria-current={i === currentIndex ? 'step' : undefined} className={i < currentIndex ? 'done' : i === currentIndex ? 'now' : ''}>
              <span>{i + 1}</span> {s.label}
            </li>
          ))}
        </ol>
      )}
      {error && <Alert>{error}</Alert>}

      {step === 'key' && (
        <Card title="Enter your license key">
          <form onSubmit={verifyKey} noValidate>
            <Field label="License key" value={keyInput} onChange={(e) => setKeyInput(e.target.value)}
              placeholder="SC-XXXX-XXXX-XXXX-XXXX" autoComplete="off" autoCapitalize="characters" spellCheck={false}
              hint="Each key can be activated for one school only." required />
            <Button type="submit" busy={busy}>Verify key</Button>
          </form>
        </Card>
      )}

      {step === 'account' && verified && (
        <Card title="Create the first administrator">
          <p className="muted">License verified <Badge tone="ok">{verified.license.plan}</Badge></p>
          {signedInEmail ? (
            <>
              <Alert kind="info">Signed in as <strong>{signedInEmail}</strong>.</Alert>
              <div className="row">
                <Button onClick={() => {
                  if (auth.tenantId) return setError('This account already belongs to a school. Please use a different account.');
                  setError(null); setStep('school');
                }}>Continue as this administrator</Button>
                <Button variant="ghost" onClick={() => void auth.signOut()}>Use a different account</Button>
              </div>
            </>
          ) : accountForm}
        </Card>
      )}

      {step === 'restore' && verified && (
        <Card title="Restore your school">
          <p>This license was reset by the product owner. The school administrator can restore access by signing in below. The key stays linked to the same school.</p>
          {signedInEmail ? (
            <div className="row">
              <Button onClick={() => void restore()} busy={busy}>Restore school as {signedInEmail}</Button>
              <Button variant="ghost" onClick={() => void auth.signOut()}>Use a different account</Button>
            </div>
          ) : accountForm}
        </Card>
      )}

      {step === 'school' && (
        <Card title="School details">
          <form onSubmit={nextSchool} noValidate>
            <Field label="School name" value={profile.name} required
              onChange={(e) => { const name = e.target.value; setProfile({ ...profile, name }); if (!slugTouched) setSlug(slugify(name)); }} />
            <Field label="School address (web link name)" value={slug} required
              onChange={(e) => { setSlugTouched(true); setSlug(slugify(e.target.value)); }}
              hint="Your students and staff will sign in at …/#/s/this-name" />
            <Field label="Motto" value={profile.motto} onChange={(e) => setProfile({ ...profile, motto: e.target.value })} />
            <Field label="Address" value={profile.address} onChange={(e) => setProfile({ ...profile, address: e.target.value })} />
            <div className="grid2">
              <Field label="Phone" type="tel" value={profile.phone} onChange={(e) => setProfile({ ...profile, phone: e.target.value })} />
              <Field label="School email" type="email" value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.target.value })} />
            </div>
            <Field label="Website" value={profile.website} onChange={(e) => setProfile({ ...profile, website: e.target.value })} />
            <Field label="Email sender name" value={profile.emailSenderName} onChange={(e) => setProfile({ ...profile, emailSenderName: e.target.value })} hint="Defaults to the school name." />
            <Field label="Footer text" value={profile.footer} onChange={(e) => setProfile({ ...profile, footer: e.target.value })} />
            <div className="grid2">
              <Field label="Primary colour" type="color" value={primary} onChange={(e) => { setPrimary(e.target.value); applyBranding(e.target.value, secondary); }} />
              <Field label="Secondary colour" type="color" value={secondary} onChange={(e) => { setSecondary(e.target.value); applyBranding(primary, e.target.value); }} />
            </div>
            <div className="field">
              <label htmlFor="logo">Logo (PNG, JPG or WebP)</label>
              <input id="logo" type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => void onLogo(e.target.files?.[0])} />
              {logo && <img className="logo-preview" src={logo} alt="Logo preview" />}
            </div>
            <div className="row">
              <Button type="button" variant="secondary" onClick={() => setStep('account')}>Back</Button>
              <Button type="submit" busy={busy}>Continue</Button>
            </div>
          </form>
        </Card>
      )}

      {step === 'academic' && (
        <Card title="Academic setup">
          <form onSubmit={nextAcademic} noValidate>
            <Field label="Academic session" value={session} onChange={(e) => setSession(e.target.value)} required />
            <TextArea label="Terms" value={termsText} onChange={(e) => setTermsText(e.target.value)} rows={2} hint="Separate with commas or new lines." />
            <TextArea label="Classes" value={classesText} onChange={(e) => setClassesText(e.target.value)} hint={`${classes.length} class(es). Separate with commas or new lines.`} />
            <TextArea label="Subjects" value={subjectsText} onChange={(e) => setSubjectsText(e.target.value)} hint={`${subjects.length} subject(s).`} />
            <div className="grid2">
              <Field label="Currency (3-letter code)" list="currencies" value={currency} maxLength={3}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
              <Field label="Timezone" list="timezones" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
            </div>
            <datalist id="currencies">{COMMON_CURRENCIES.map((c) => <option key={c} value={c} />)}</datalist>
            <datalist id="timezones">{timezones.map((z) => <option key={z} value={z} />)}</datalist>

            <AssessmentEditor value={assessment} onChange={setAssessment} />
            <GradingEditor value={grading} onChange={setGrading} />

            <div className="row">
              <Button type="button" variant="secondary" onClick={() => setStep('school')}>Back</Button>
              <Button type="submit">Review</Button>
            </div>
          </form>
        </Card>
      )}

      {step === 'review' && (
        <Card title="Review and activate">
          <dl className="summary">
            <dt>School</dt><dd>{profile.name} <small>(#/s/{slug})</small></dd>
            <dt>Administrator</dt><dd>{signedInEmail}</dd>
            <dt>Plan</dt><dd>{verified?.license.plan}</dd>
            <dt>Session</dt><dd>{session} · {terms.length} term(s)</dd>
            <dt>Classes / Subjects</dt><dd>{classes.length} / {subjects.length}</dd>
            <dt>Currency · Timezone</dt><dd>{currency} · {timezone}</dd>
          </dl>
          <Alert kind="info">Activating permanently links this license key to this school. The key cannot be used for any other school.</Alert>
          {resumeAt !== null ? (
            <Button onClick={() => void retryConfig()} busy={busy}>Resume setup</Button>
          ) : (
            <div className="row">
              <Button type="button" variant="secondary" onClick={() => setStep('academic')} disabled={busy}>Back</Button>
              <Button onClick={() => void activate()} busy={busy}>Activate &amp; create school</Button>
            </div>
          )}
        </Card>
      )}
    </main>
  );
}
