import { useState } from 'react';
import { collection, documentId, getDocs, limit, query, where } from 'firebase/firestore';
import { firebase } from './lib-firebase';
import { isActiveItem, useTenant } from './ctx-tenant';
import { Alert, Button, Card, Select } from './ui';
import { Credentials, type Cred } from './ui-editors';
import { useAction } from './use-action';
import { applyOps, chunkOps, newId, type Op } from './lib-ops';
import { auditOp, buildMemberOps, generatePassword } from './lib-accounts';
import { withNewAccount } from './lib-newuser';
import { reserveAdmissionNumbers } from './lib-numbers';
import { credentialsCsv, hasBlockingHeaderErrors, parseImport, templateCsv, type ImportContext, type ImportKind, type ImportResult } from './lib-csv';
import { buildStudentDoc, buildTeacherDoc, defaultAdmissionPrefix, type StudentInput, type TeacherInput } from './lib-people';
import { uniqueIds } from './lib-activation';
import { friendlyError, logTechnical } from './lib-errors';
import { serverTimestamp } from 'firebase/firestore';

type AnyResult = ImportResult<StudentInput> | ImportResult<TeacherInput> | ImportResult<{ name: string }>;
interface Summary { imported: number; failed: { line: number; reason: string }[] }
const BATCH = 8; // 2 rules-access calls per write, 20 allowed per batch
const LABEL: Record<ImportKind, string> = { students: 'Students', teachers: 'Teachers', subjects: 'Subjects', classes: 'Classes' };

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

export default function ImportPage() {
  const { tenantId, uid, tenant, classes, subjects, reload } = useTenant();
  const { busy, error, setError, run } = useAction();
  const [kind, setKind] = useState<ImportKind>('students');
  const [text, setText] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [result, setResult] = useState<AnyResult | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [creds, setCreds] = useState<Cred[] | null>(null);

  const reset = () => { setText(null); setFileName(''); setResult(null); setSummary(null); setProgress(null); setError(null); };

  async function buildContext(csv: string): Promise<ImportContext> {
    const { db } = firebase();
    const lower = (xs: { name: string }[]) => new Set(xs.map((x) => x.name.toLowerCase()));
    const byName = (xs: { id: string; name: string; status?: string }[]) => new Map(xs.filter(isActiveItem).map((x) => [x.name.toLowerCase(), x.id]));
    const ctx: ImportContext = {
      classIdByName: byName(classes), subjectIdByName: byName(subjects),
      existingAdmissionNumbers: new Set(), existingEmails: new Set(),
      existingNames: kind === 'classes' ? lower(classes) : kind === 'subjects' ? lower(subjects) : new Set(),
    };
    if (kind === 'teachers') {
      const snap = await getDocs(query(collection(db, `tenants/${tenantId}/teachers`), limit(500)));
      return { ...ctx, existingEmails: new Set(snap.docs.map((d) => String(d.get('email')).toLowerCase())) };
    }
    if (kind === 'students') {
      // Only rows that bring their own admission number can collide; look those up in groups of 30.
      const custom = parseImport('students', csv, ctx).rows
        .map((r) => (r.value as StudentInput | null)?.admissionNumber ?? '').filter(Boolean);
      const taken = new Set<string>();
      for (let i = 0; i < custom.length; i += 30) {
        const snap = await getDocs(query(collection(db, `tenants/${tenantId}/students`), where(documentId(), 'in', custom.slice(i, i + 30))));
        snap.docs.forEach((d) => taken.add(d.id.toLowerCase()));
      }
      return { ...ctx, existingAdmissionNumbers: taken };
    }
    return ctx;
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    reset();
    await run('readCsv', async () => {
      const csv = await file.text();
      const ctx = await buildContext(csv);
      setText(csv); setFileName(file.name);
      setResult(parseImport(kind as 'students', csv, ctx) as AnyResult);
    });
  }

  async function runImport() {
    if (!result) return;
    setSummary(null); setCreds(null);
    const { db } = firebase();
    const failed: Summary['failed'] = [];
    let imported = 0;
    const valid = result.rows.filter((r) => r.value);
    await run('import', async () => {
      if (kind === 'subjects' || kind === 'classes') {
        const items = kind === 'classes' ? classes : subjects;
        const used = new Set(items.map((i) => i.id));
        const names = valid.map((r) => (r.value as { name: string }).name);
        const ids = uniqueIds(names, kind).map((id) => { let x = id, n = 2; while (used.has(x)) x = `${id}-${n++}`; used.add(x); return x; });
        const start = items.reduce((m, i) => Math.max(m, i.order ?? 0), -1) + 1;
        const ops: Op[] = names.map((name, i) => ({
          kind: 'set', path: `tenants/${tenantId}/${kind}/${ids[i]}`,
          data: { tenantId, name, order: start + i, status: 'ACTIVE', createdAt: serverTimestamp() },
        }));
        await runBatches(ops, valid.map((r) => r.line));
      } else if (kind === 'students') {
        const rowsV = valid.map((r) => ({ line: r.line, v: r.value as StudentInput }));
        const need = rowsV.filter((x) => !x.v.admissionNumber).length;
        const prefix = tenant.settings.admissionPrefix ?? defaultAdmissionPrefix(tenant.name);
        const auto = need ? await reserveAdmissionNumbers(db, tenantId, new Date().getFullYear(), prefix, need) : [];
        let k = 0;
        const ops: Op[] = rowsV.map(({ v }) => {
          const adm = v.admissionNumber || (auto[k++] as string);
          return { kind: 'set', path: `tenants/${tenantId}/students/${adm}`,
            data: buildStudentDoc(v, { tenantId, admissionNumber: adm, academicSession: tenant.settings.academicSession, photo: null, uid: null, createdBy: uid }) };
        });
        await runBatches(ops, rowsV.map((x) => x.line));
      } else {
        const out: Cred[] = [];
        let n = 0;
        for (const r of valid) {
          const v = r.value as TeacherInput;
          setProgress(`Creating accounts… ${++n} of ${valid.length}`);
          const password = generatePassword();
          try {
            await withNewAccount(v.email, password, async (newUid) => {
              await applyOps(db, [
                { kind: 'set', path: `tenants/${tenantId}/teachers/${newUid}`, data: buildTeacherDoc(v, { tenantId, uid: newUid, photo: null, createdBy: uid }) },
                ...buildMemberOps({ tenantId, uid: newUid, role: 'TEACHER', displayName: v.name, email: v.email, loginId: v.email, classIds: v.classes, subjectIds: v.subjects }),
              ]);
            });
            out.push({ name: v.name, loginId: v.email, password });
            imported++;
          } catch (e) {
            logTechnical('importTeacher', e);
            failed.push({ line: r.line, reason: friendlyError(e) });
          }
        }
        if (out.length) setCreds(out);
      }
      if (imported > 0) {
        await applyOps(db, [auditOp(tenantId, uid, newId(), `${kind}.imported`, `tenants/${tenantId}/${kind}`, { count: imported })]).catch((e) => logTechnical('importAudit', e));
      }
      await reload();
      setSummary({ imported, failed });
      setProgress(null);
    });

    async function runBatches(ops: Op[], lines: number[]) {
      const chunks = chunkOps(ops, BATCH);
      let offset = 0;
      for (const chunk of chunks) {
        setProgress(`Saving… ${Math.min(offset + chunk.length, ops.length)} of ${ops.length}`);
        try {
          await applyOps(firebase().db, chunk);
          imported += chunk.length;
        } catch (e) {
          logTechnical('importBatch', e);
          const reason = friendlyError(e);
          lines.slice(offset, offset + chunk.length).forEach((line) => failed.push({ line, reason }));
        }
        offset += chunk.length;
      }
    }
  }

  const blocked = result ? hasBlockingHeaderErrors(result.headerErrors) : false;
  const invalidRows = result?.rows.filter((r) => !r.value) ?? [];
  return (
    <>
      <h1>Import</h1>
      <p className="muted">Add many records at once from a spreadsheet saved as CSV. Nothing is saved until you have seen the preview and confirmed.</p>
      {error && <Alert>{error}</Alert>}
      {creds && <Credentials creds={creds} onClose={() => setCreds(null)} />}
      {creds && <Button variant="secondary" onClick={() => download('teacher-logins.csv', credentialsCsv(creds.map((c) => ({ name: c.name, loginId: c.loginId, password: c.password }))))}>Download logins as CSV</Button>}
      <Card title="1. Choose what to import">
        <div className="toolbar">
          <Select label="Type" value={kind} onChange={(e) => { setKind(e.target.value as ImportKind); reset(); }}>
            {(Object.keys(LABEL) as ImportKind[]).map((k) => <option key={k} value={k}>{LABEL[k]}</option>)}
          </Select>
          <Button variant="secondary" onClick={() => download(`${kind}-template.csv`, templateCsv(kind))}>Download template</Button>
        </div>
        {kind === 'students' && <p className="muted">Classes must already exist (the <code>className</code> column must match a class name). Leave <code>admissionNumber</code> empty to generate numbers.</p>}
        {kind === 'teachers' && <p className="muted">Each teacher gets a login (their email) with a temporary password. You will be shown the passwords once, after the import.</p>}
        <div className="field">
          <label htmlFor="csv">2. Choose your CSV file</label>
          <input id="csv" type="file" accept=".csv,text/csv" onChange={(e) => void onFile(e.target.files?.[0])} />
        </div>
      </Card>
      {result && (
        <Card title={`3. Preview${fileName ? ` — ${fileName}` : ''}`}>
          {result.headerErrors.map((h) => <Alert key={h} kind={h.startsWith('Unknown column') ? 'info' : 'error'}>{h}</Alert>)}
          {!blocked && (
            <>
              <p><strong>{result.valid}</strong> valid · <strong>{result.invalid}</strong> with errors</p>
              {invalidRows.length > 0 && (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Line</th><th>Problems (these rows will be skipped)</th></tr></thead>
                    <tbody>{invalidRows.slice(0, 50).map((r) => (
                      <tr key={r.line}><td>{r.line}</td><td><ul className="errlist">{r.errors.map((e) => <li key={e}>{e}</li>)}</ul></td></tr>
                    ))}</tbody>
                  </table>
                  {invalidRows.length > 50 && <p className="muted">…and {invalidRows.length - 50} more.</p>}
                </div>
              )}
              <div className="row">
                <Button busy={busy} disabled={result.valid === 0 || !!summary} onClick={() => void runImport()}>Import {result.valid} valid record{result.valid === 1 ? '' : 's'}</Button>
                <Button variant="ghost" onClick={reset}>Cancel</Button>
              </div>
            </>
          )}
          {text === null && null}
        </Card>
      )}
      {progress && <Alert kind="info">{progress}</Alert>}
      {summary && (
        <Alert kind={summary.failed.length ? 'error' : 'success'}>
          Imported {summary.imported} record{summary.imported === 1 ? '' : 's'}.
          {summary.failed.length > 0 && (
            <> {summary.failed.length} could not be saved:
              <ul className="errlist">{summary.failed.slice(0, 20).map((f) => <li key={f.line}>Line {f.line}: {f.reason}</li>)}</ul>
            </>
          )}
        </Alert>
      )}
    </>
  );
}
