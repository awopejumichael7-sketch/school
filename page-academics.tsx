import { useState, type FormEvent } from 'react';
import { serverTimestamp } from 'firebase/firestore';
import { firebase } from './lib-firebase';
import { isActiveItem, useTenant } from './ctx-tenant';
import { Alert, Badge, Button, Card, Field } from './ui';
import { useAction } from './use-action';
import { applyOps, newId, type Op } from './lib-ops';
import { auditOp } from './lib-accounts';
import { slugify } from './lib-config';
import { can } from './lib-permissions';
import { isValidIsoDate } from './lib-people';
import type { NamedItem } from './types';

type Kind = 'classes' | 'subjects' | 'terms';

export default function Academics() {
  const { classes, subjects, terms, member } = useTenant();
  const canEdit = can(member.role, 'academics.manage');
  return (
    <>
      <h1>Academics</h1>
      <p className="muted">Classes, subjects and terms used across the whole school. Archive an item instead of deleting it, so past records stay intact.</p>
      <div className="cards">
        <NameList kind="classes" title="Classes" items={classes} canEdit={canEdit} />
        <NameList kind="subjects" title="Subjects" items={subjects} canEdit={canEdit} />
        <NameList kind="terms" title="Terms" items={terms} canEdit={canEdit} />
      </div>
    </>
  );
}

function NameList({ kind, title, items, canEdit }: { kind: Kind; title: string; items: NamedItem[]; canEdit: boolean }) {
  const { tenantId, uid, tenant, reload } = useTenant();
  const { busy, error, setError, run } = useAction();
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [dating, setDating] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const base = `tenants/${tenantId}/${kind}`;
  const exists = (n: string, exceptId?: string) => items.some((i) => i.id !== exceptId && i.name.toLowerCase() === n.toLowerCase());

  async function save(ops: Op[], action: string, target: string) {
    const { db } = firebase();
    await applyOps(db, [...ops, auditOp(tenantId, uid, newId(), action, target)]);
    await reload();
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const n = name.replace(/\s+/g, ' ').trim();
    if (!n) return setError('Enter a name.');
    if (n.length > 100) return setError('That name is too long (max 100).');
    if (exists(n)) return setError(`"${n}" already exists.`);
    const id = slugify(n) || newId();
    if (items.some((i) => i.id === id)) return setError('A similar name already exists.');
    const order = items.reduce((m, i) => Math.max(m, i.order ?? 0), -1) + 1;
    const data: Record<string, unknown> = { tenantId, name: n, order, status: 'ACTIVE', createdAt: serverTimestamp() };
    if (kind === 'terms') data.session = tenant.settings.academicSession;
    const ok = await run(`add ${kind}`, async () => { await save([{ kind: 'set', path: `${base}/${id}`, data }], `${kind}.created`, `${base}/${id}`); return true; });
    if (ok) setName('');
  }

  async function rename(id: string) {
    const n = editName.replace(/\s+/g, ' ').trim();
    if (!n) return setError('Enter a name.');
    if (n.length > 100) return setError('That name is too long (max 100).');
    if (exists(n, id)) return setError(`"${n}" already exists.`);
    const ok = await run(`rename ${kind}`, async () => { await save([{ kind: 'update', path: `${base}/${id}`, data: { name: n, updatedAt: serverTimestamp() } }], `${kind}.renamed`, `${base}/${id}`); return true; });
    if (ok) setEditing(null);
  }

  /** Term dates drive the 'term' attendance report. */
  async function saveDates(id: string) {
    if (from && !isValidIsoDate(from)) return setError('Enter a valid start date.');
    if (to && !isValidIsoDate(to)) return setError('Enter a valid end date.');
    if ((from && !to) || (!from && to)) return setError('Enter both the start and the end date.');
    if (from && to && to < from) return setError('The end date cannot be before the start date.');
    const ok = await run('termDates', async () => { await save([{ kind: 'update', path: `${base}/${id}`, data: { startDate: from, endDate: to, updatedAt: serverTimestamp() } }], 'terms.dates_set', `${base}/${id}`); return true; });
    if (ok) setDating(null);
  }

  async function setStatus(id: string, status: 'ACTIVE' | 'ARCHIVED') {
    await run(`status ${kind}`, () => save([{ kind: 'update', path: `${base}/${id}`, data: { status, updatedAt: serverTimestamp() } }], `${kind}.${status === 'ARCHIVED' ? 'archived' : 'restored'}`, `${base}/${id}`));
  }

  return (
    <Card title={title}>
      {error && <Alert>{error}</Alert>}
      {items.length === 0 && <p className="muted">None yet.</p>}
      <ul className="plain">
        {items.map((i) => (
          <li key={i.id} className="row between">
            {editing === i.id ? (
              <>
                <Field label={`Rename ${i.name}`} value={editName} onChange={(e) => setEditName(e.target.value)} />
                <Button busy={busy} onClick={() => void rename(i.id)}>Save</Button>
                <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              </>
            ) : dating === i.id ? (
              <>
                <Field label={`Start date for ${i.name}`} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                <Field label={`End date for ${i.name}`} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                <Button busy={busy} onClick={() => void saveDates(i.id)}>Save dates</Button>
                <Button variant="ghost" onClick={() => setDating(null)}>Cancel</Button>
              </>
            ) : (
              <>
                <span>{i.name} {!isActiveItem(i) && <Badge tone="muted">archived</Badge>}
                  {kind === 'terms' && <small className="muted"> {i.startDate && i.endDate ? `${i.startDate} to ${i.endDate}` : 'no dates set'}</small>}</span>
                {canEdit && (
                  <span className="row">
                    {kind === 'terms' && <Button variant="ghost" onClick={() => { setDating(i.id); setFrom(i.startDate ?? ''); setTo(i.endDate ?? ''); setError(null); }} aria-label={`Set dates for ${i.name}`}>Dates</Button>}
                    <Button variant="ghost" onClick={() => { setEditing(i.id); setEditName(i.name); setError(null); }} aria-label={`Rename ${i.name}`}>Rename</Button>
                    {isActiveItem(i)
                      ? <Button variant="ghost" busy={busy} onClick={() => void setStatus(i.id, 'ARCHIVED')} aria-label={`Archive ${i.name}`}>Archive</Button>
                      : <Button variant="ghost" busy={busy} onClick={() => void setStatus(i.id, 'ACTIVE')} aria-label={`Restore ${i.name}`}>Restore</Button>}
                  </span>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <form onSubmit={add} className="row" noValidate>
          <Field label={`New ${title.toLowerCase().replace(/e?s$/, '')} name`} value={name} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" busy={busy}>Add</Button>
        </form>
      )}
    </Card>
  );
}
