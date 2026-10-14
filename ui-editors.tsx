import { useId, useState } from 'react';
import { Alert, Button, Field } from './ui';
import { fileToPhotoDataUrl } from './lib-image';
import { friendlyError, logTechnical } from './lib-errors';
import { slugify, DEFAULT_GRADING } from './lib-config';
import type { AssessmentWeight, GradeBand } from './types';

export function AssessmentEditor({ value, onChange }: { value: AssessmentWeight[]; onChange: (v: AssessmentWeight[]) => void }) {
  return (
    <>
      <h3>Assessment weights</h3>
      <p className="muted">Total must be 100.</p>
      {value.map((a, i) => (
        <div className="grid3" key={i}>
          <Field label="Name" value={a.label} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, label: e.target.value, key: slugify(e.target.value) || `a${i}` } : x)))} />
          <Field label="Weight %" type="number" min={0} max={100} step="any" value={a.weight}
            onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, weight: Number(e.target.value) } : x)))} />
          <Button type="button" variant="ghost" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={`Remove ${a.label || 'assessment'}`}>Remove</Button>
        </div>
      ))}
      <Button type="button" variant="secondary" onClick={() => onChange([...value, { key: `a${value.length}`, label: '', weight: 0 }])}>Add assessment</Button>
    </>
  );
}

export function GradingEditor({ value, onChange }: { value: GradeBand[]; onChange: (v: GradeBand[]) => void }) {
  return (
    <>
      <h3>Grading bands</h3>
      <p className="muted">Bands must cover 0-100 with no gaps or overlaps. Edit freely: nothing is tied to any country.</p>
      {value.map((b, i) => (
        <div className="grid5" key={i}>
          <Field label="From" type="number" step="any" value={b.min} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, min: Number(e.target.value) } : x)))} />
          <Field label="To" type="number" step="any" value={b.max} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, max: Number(e.target.value) } : x)))} />
          <Field label="Grade" value={b.grade} maxLength={4} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, grade: e.target.value } : x)))} />
          <Field label="Remark" value={b.remark} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, remark: e.target.value } : x)))} />
          <Button type="button" variant="ghost" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={`Remove grade ${b.grade}`}>Remove</Button>
        </div>
      ))}
      <div className="row">
        <Button type="button" variant="secondary" onClick={() => onChange([...value, { min: 0, max: 0, grade: '', remark: '' }])}>Add band</Button>
        <Button type="button" variant="ghost" onClick={() => onChange(DEFAULT_GRADING)}>Reset to defaults</Button>
      </div>
    </>
  );
}

export function PhotoInput({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const id = useId();
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="field">
      <label htmlFor={id}>Photo (optional)</label>
      <input id={id} type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        setErr(null);
        fileToPhotoDataUrl(f).then(onChange).catch((x) => { logTechnical('photo', x); setErr(friendlyError(x)); });
      }} />
      {err && <small className="err">{err}</small>}
      {value && (
        <div className="row">
          <img className="photo" src={value} alt="Photo preview" />
          <Button type="button" variant="ghost" onClick={() => onChange(null)}>Remove photo</Button>
        </div>
      )}
    </div>
  );
}

export function CheckGroup({ legend, options, value, onChange }:
  { legend: string; options: { id: string; name: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <fieldset className="checks">
      <legend>{legend}</legend>
      {options.length === 0 && <span className="muted">Nothing to choose yet (add some under Academics).</span>}
      {options.map((o) => (
        <label key={o.id}>
          <input type="checkbox" checked={value.includes(o.id)}
            onChange={(e) => onChange(e.target.checked ? [...value, o.id] : value.filter((x) => x !== o.id))} />
          {o.name}
        </label>
      ))}
    </fieldset>
  );
}

export interface Cred { name: string; loginId: string; password: string }

/** One-time display: the password is never stored, so it cannot be shown again. */
export function Credentials({ creds, onClose }: { creds: Cred[]; onClose: () => void }) {
  const text = creds.map((c) => `${c.name}\nSign-in: ${c.loginId}\nTemporary password: ${c.password}`).join('\n\n');
  const [copied, setCopied] = useState(false);
  return (
    <Alert kind="success">
      <strong>Account{creds.length > 1 ? 's' : ''} created. Give these sign-in details to the person now. The password cannot be shown again.</strong>
      <div className="cred" tabIndex={0}>{creds.map((c) => (
        <p key={c.loginId}>{c.name}<br />Sign-in: <code>{c.loginId}</code><br />Temporary password: <code>{c.password}</code></p>
      ))}</div>
      <p>They will be asked to choose their own password the first time they sign in.</p>
      <div className="row">
        <Button type="button" onClick={() => { void navigator.clipboard.writeText(text).then(() => setCopied(true)); }}>{copied ? 'Copied' : 'Copy'}</Button>
        <Button type="button" variant="ghost" onClick={onClose}>I have saved it — hide</Button>
      </div>
    </Alert>
  );
}
