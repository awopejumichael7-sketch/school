import { useState, type FormEvent } from 'react';
import { serverTimestamp } from 'firebase/firestore';
import { firebase } from './lib-firebase';
import { useAuth } from './ctx-auth';
import { isActiveItem, useTenant } from './ctx-tenant';
import { Alert, Button, Card, Field, Spinner } from './ui';
import { AssessmentEditor, GradingEditor } from './ui-editors';
import { useAction } from './use-action';
import { applyOps, newId } from './lib-ops';
import { auditOp } from './lib-accounts';
import { isValidHexColor, validateAssessment, validateGrading } from './lib-config';
import { defaultAdmissionPrefix, looksLikeEmail } from './lib-people';
import { fileToLogoDataUrl } from './lib-image';
import { applyBranding } from './lib-theme';
import type { AssessmentWeight, GradeBand, PublicProfile, SchoolProfile } from './types';

export default function Settings() {
  const { ready, profile } = useTenant();
  if (!ready || !profile) return <Spinner />;
  return <SettingsForm profile={profile} />;
}

function SettingsForm({ profile: pub }: { profile: PublicProfile }) {
  const auth = useAuth();
  const { tenantId, uid, tenant, terms, reload } = useTenant();
  const { busy, error, setError, run } = useAction();
  const [saved, setSaved] = useState(false);

  const [p, setP] = useState<SchoolProfile>(tenant.profile);
  const [primary, setPrimary] = useState(pub.primaryColor);
  const [secondary, setSecondary] = useState(pub.secondaryColor);
  const [logo, setLogo] = useState<string | null>(pub.logoDataUrl);
  const [session, setSession] = useState(tenant.settings.academicSession);
  const [prefix, setPrefix] = useState(tenant.settings.admissionPrefix ?? defaultAdmissionPrefix(tenant.name));
  const [currency, setCurrency] = useState(tenant.settings.currency);
  const [timezone, setTimezone] = useState(tenant.settings.timezone);
  const [grading, setGrading] = useState<GradeBand[]>(tenant.settings.grading);
  const [assessment, setAssessment] = useState<AssessmentWeight[]>(tenant.settings.assessment);
  const [lateCounts, setLateCounts] = useState(tenant.settings.attendance?.lateCountsAsPresent ?? true);
  const [excusedCounts, setExcusedCounts] = useState(tenant.settings.attendance?.excusedCountsAsAbsent ?? false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    const name = p.name.trim();
    if (name.length < 2) return setError('Please enter the school name.');
    if (p.email && !looksLikeEmail(p.email)) return setError('Please enter a valid school email address.');
    if (!isValidHexColor(primary) || !isValidHexColor(secondary)) return setError('Please choose valid theme colours.');
    if (!session.trim()) return setError('Please enter the academic session.');
    if (!/^[A-Z0-9]{2,6}$/.test(prefix)) return setError('Admission prefix must be 2-6 capital letters or numbers.');
    if (!/^[A-Z]{3}$/.test(currency)) return setError('Currency must be a 3-letter code such as NGN or USD.');
    try { new Intl.DateTimeFormat(undefined, { timeZone: timezone.trim() }); } catch { return setError('Please enter a valid timezone, for example Africa/Lagos.'); }
    const g = validateGrading(grading); if (!g.ok) return setError(g.errors[0] ?? 'Check the grading bands.');
    const a = validateAssessment(assessment); if (!a.ok) return setError(a.errors[0] ?? 'Check the assessment weights.');

    const past = new Set(tenant.settings.pastSessions ?? []);
    if (session.trim() !== tenant.settings.academicSession) past.add(tenant.settings.academicSession);
    const termNames = terms.filter(isActiveItem).map((t) => t.name);
    const profile: SchoolProfile = { ...p, name, emailSenderName: p.emailSenderName.trim() || name };

    const ok = await run('saveSettings', async () => {
      await applyOps(firebase().db, [
        { kind: 'update', path: `tenants/${tenantId}`, data: {
          name, profile,
          settings: {
            academicSession: session.trim(), admissionPrefix: prefix, pastSessions: [...past].slice(-20),
            terms: termNames.length ? termNames : tenant.settings.terms, currency, timezone: timezone.trim(), grading, assessment,
            attendance: { lateCountsAsPresent: lateCounts, excusedCountsAsAbsent: excusedCounts },
          },
          updatedAt: serverTimestamp(),
        } },
        { kind: 'update', path: `publicProfiles/${tenantId}`, data: { name, motto: p.motto, logoDataUrl: logo, primaryColor: primary, secondaryColor: secondary } },
        auditOp(tenantId, uid, newId(), 'settings.updated', `tenants/${tenantId}`),
      ]);
      await auth.refresh();
      await reload();
      return true;
    });
    if (ok) { applyBranding(primary, secondary); setSaved(true); }
  }

  const on = (k: keyof SchoolProfile) => (e: { target: { value: string } }) => setP({ ...p, [k]: e.target.value });
  return (
    <>
      <h1>Settings</h1>
      <form onSubmit={save} noValidate>
        {error && <Alert>{error}</Alert>}
        {saved && <Alert kind="success">Settings saved.</Alert>}
        <Card title="School profile">
          <Field label="School name" value={p.name} onChange={on('name')} required />
          <Field label="Motto" value={p.motto} onChange={on('motto')} />
          <Field label="Address" value={p.address} onChange={on('address')} />
          <div className="grid2">
            <Field label="Phone" type="tel" value={p.phone} onChange={on('phone')} />
            <Field label="School email" type="email" value={p.email} onChange={on('email')} />
          </div>
          <Field label="Website" value={p.website} onChange={on('website')} />
          <Field label="Email sender name" value={p.emailSenderName} onChange={on('emailSenderName')} />
          <Field label="Footer text" value={p.footer} onChange={on('footer')} />
          <p className="muted">School web address: <code>#/s/{pub.slug}</code> (cannot be changed).</p>
        </Card>
        <Card title="Look and feel">
          <div className="grid2">
            <Field label="Primary colour" type="color" value={primary} onChange={(e) => { setPrimary(e.target.value); applyBranding(e.target.value, secondary); }} />
            <Field label="Secondary colour" type="color" value={secondary} onChange={(e) => { setSecondary(e.target.value); applyBranding(primary, e.target.value); }} />
          </div>
          <div className="field">
            <label htmlFor="logo">Logo (PNG, JPG or WebP)</label>
            <input id="logo" type="file" accept="image/png,image/jpeg,image/webp"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void run('logo', async () => setLogo(await fileToLogoDataUrl(f))); }} />
            {logo && <img className="logo-preview" src={logo} alt="Logo preview" />}
            {logo && <Button type="button" variant="ghost" onClick={() => setLogo(null)}>Remove logo</Button>}
          </div>
        </Card>
        <Card title="Academic settings">
          <div className="grid2">
            <Field label="Current academic session" value={session} onChange={(e) => setSession(e.target.value)} hint="Changing this keeps the old session in your history." />
            <Field label="Admission number prefix" value={prefix} maxLength={6} onChange={(e) => setPrefix(e.target.value.toUpperCase())} hint={`Example: ${prefix || 'SCH'}-${new Date().getFullYear()}-0001`} />
          </div>
          <div className="grid2">
            <Field label="Currency (3-letter code)" value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
            <Field label="Timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
          </div>
          <fieldset className="checks">
            <legend>How attendance percentages are calculated</legend>
            <label><input type="checkbox" checked={lateCounts} onChange={(e) => setLateCounts(e.target.checked)} /> A late student counts as attended</label>
            <label><input type="checkbox" checked={excusedCounts} onChange={(e) => setExcusedCounts(e.target.checked)} /> An excused absence counts against the student</label>
          </fieldset>
          <AssessmentEditor value={assessment} onChange={setAssessment} />
          <GradingEditor value={grading} onChange={setGrading} />
        </Card>
        <Button type="submit" busy={busy}>Save settings</Button>
      </form>
    </>
  );
}
