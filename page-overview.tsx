import { Alert, Badge, Card, Spinner, formatDate } from './ui';
import { isActiveItem, useTenant } from './ctx-tenant';
import { can } from './lib-permissions';

export default function Overview() {
  const { tenant, member, classes, subjects, terms, ready } = useTenant();
  const act = (l: typeof classes) => l.filter(isActiveItem);
  const termNames = ready && terms.length > 0 ? act(terms).map((t) => t.name) : tenant.settings.terms;
  return (
    <>
      <h1>Overview</h1>
      {!tenant.setupComplete && (
        <Alert>School setup did not finish completely. Some classes, subjects or terms may be missing. You can add them under Academics.</Alert>
      )}
      <div className="cards">
        {can(member.role, 'settings.manage') && <Card title="License">
          <dl className="summary">
            <dt>Plan</dt><dd>{tenant.plan}</dd>
            <dt>Status</dt><dd><Badge tone="ok">Active</Badge></dd>
            <dt>Expires</dt><dd>{tenant.expiresAt ? formatDate(tenant.expiresAt) : 'Never'}</dd>
          </dl>
        </Card>}
        <Card title="Academic year">
          <dl className="summary">
            <dt>Session</dt><dd>{tenant.settings.academicSession}</dd>
            <dt>Terms</dt><dd>{termNames.join(', ')}</dd>
            <dt>Currency</dt><dd>{tenant.settings.currency}</dd>
            <dt>Timezone</dt><dd>{tenant.settings.timezone}</dd>
          </dl>
        </Card>
        <Card title="Classes">
          {!ready ? <Spinner /> : act(classes).length === 0 ? <p className="muted">None yet.</p>
            : <ul className="chips">{act(classes).map((c) => <li key={c.id}>{c.name}</li>)}</ul>}
        </Card>
        <Card title="Subjects">
          {!ready ? <Spinner /> : act(subjects).length === 0 ? <p className="muted">None yet.</p>
            : <ul className="chips">{act(subjects).map((c) => <li key={c.id}>{c.name}</li>)}</ul>}
        </Card>
      </div>
    </>
  );
}
