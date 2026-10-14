/**
 * Test-only in-memory stand-in for Firestore + the helpers that talk to it.
 * It supports what the pages use: doc/collection/query with where(==, in, array-contains), limit,
 * startAfter, documentId(), transactions, serverTimestamp/arrayUnion/arrayRemove sentinels.
 * It does NOT evaluate security rules (that is rules.test.ts / rules-lint.test.ts).
 */
// NOTE: only a TYPE import here. A value import would deadlock: the test mocks 'firebase/firestore' with a
// factory that imports this file.
import type { Timestamp as TimestampType } from 'firebase/firestore';
import type { Op } from './lib-ops';

type Data = Record<string, unknown>;
export const store = new Map<string, Data>();
export const writeLog: Op[][] = [];
export const accounts: { email: string; password: string; uid: string }[] = [];
export const hooks: { failBatch?: (ops: Op[], index: number) => unknown; failAccount?: unknown } = {};
let uidCounter = 0;
export const resetStore = () => {
  store.clear(); writeLog.length = 0; accounts.length = 0; uidCounter = 0;
  delete hooks.failBatch; delete hooks.failAccount;
};
export const seed = (path: string, data: Data) => { store.set(path, structuredCloneSafe(data)); };
function structuredCloneSafe<T>(v: T): T { return v; }

let realTimestamp: typeof TimestampType | null = null;
interface Sentinel { __s: 'ts' | 'union' | 'remove'; v?: unknown[] }
const isSentinel = (x: unknown): x is Sentinel => typeof x === 'object' && x !== null && '__s' in (x as object);

function resolve(prev: unknown, val: unknown): unknown {
  if (isSentinel(val)) {
    if (val.__s === 'ts') return (realTimestamp as typeof TimestampType).now();
    const arr = Array.isArray(prev) ? (prev as unknown[]) : [];
    if (val.__s === 'union') return [...arr, ...(val.v ?? []).filter((x) => !arr.includes(x))];
    return arr.filter((x) => !(val.v ?? []).includes(x));
  }
  return val;
}
function resolveAll(prev: Data, next: Data): Data {
  const out: Data = {};
  for (const [k, v] of Object.entries(next)) out[k] = resolve(prev[k], v);
  return out;
}

const snap = (path: string) => {
  const data = store.get(path);
  return {
    id: path.split('/').pop() as string, ref: { path }, exists: () => data !== undefined,
    data: () => (data ? { ...data } : undefined), get: (f: string) => data?.[f],
  };
};

/** Replaces lib-ops' applyOps: writes land in the in-memory store; `hooks.failBatch` can inject failures. */
export async function applyOpsFake(_db: unknown, ops: Op[]): Promise<void> {
  const index = writeLog.length;
  writeLog.push(ops);
  const err = hooks.failBatch?.(ops, index);
  if (err) throw err;
  // all-or-nothing, like a real batch
  const staged = new Map<string, Data>();
  for (const op of ops) {
    const cur = staged.get(op.path) ?? store.get(op.path);
    if (op.kind === 'update') {
      if (!cur) throw { code: 'not-found' };
      staged.set(op.path, { ...cur, ...resolveAll(cur, op.data) });
    } else staged.set(op.path, resolveAll({}, op.data));
  }
  for (const [p, d] of staged) store.set(p, d);
}

export async function withNewAccountFake<T>(email: string, password: string, run: (uid: string) => Promise<T>): Promise<T> {
  if (hooks.failAccount) throw hooks.failAccount;
  if (accounts.some((a) => a.email === email)) throw { code: 'auth/email-already-in-use' };
  const uid = `uid-${++uidCounter}`;
  accounts.push({ email, password, uid });
  try { return await run(uid); } catch (e) { accounts.pop(); throw e; }
}

export function firestoreMock(real: typeof import('firebase/firestore')) {
  realTimestamp = real.Timestamp;
  return {
    ...real,
    doc: (_d: unknown, path: string) => ({ path, id: path.split('/').pop() }),
    collection: (_d: unknown, path: string) => ({ __col: path, cs: [] as unknown[] }),
    query: (c: { __col: string; cs: unknown[] }, ...cs: unknown[]) => ({ __col: c.__col, cs: [...c.cs, ...cs] }),
    where: (field: string, op: string, value: unknown) => ({ t: 'where', field, op, value }),
    orderBy: (field: string, dir = 'asc') => ({ t: 'order', field, dir }),
    limit: (n: number) => ({ t: 'limit', n }),
    startAfter: (s: { id: string }) => ({ t: 'after', id: s.id }),
    documentId: () => '__name__',
    serverTimestamp: () => ({ __s: 'ts' }),
    arrayUnion: (...v: unknown[]) => ({ __s: 'union', v }),
    arrayRemove: (...v: unknown[]) => ({ __s: 'remove', v }),
    getDoc: async (ref: { path: string }) => snap(ref.path),
    getDocs: async (q: { __col: string; cs: { t: string; [k: string]: unknown }[] }) => {
      let docs = [...store.keys()]
        .filter((k) => k.startsWith(`${q.__col}/`) && !k.slice(q.__col.length + 1).includes('/'))
        .sort().map(snap);
      for (const c of q.cs) {
        if (c.t === 'where') {
          const f = c.field as string; const v = c.value; const op = c.op as string;
          const val = (d: ReturnType<typeof snap>) => (f === '__name__' ? d.id : d.get(f));
          docs = docs.filter((d) => op === '==' ? val(d) === v : op === 'in' ? (v as unknown[]).includes(val(d))
            : op === 'array-contains' ? Array.isArray(val(d)) && (val(d) as unknown[]).includes(v) : false);
        }
      }
      const order = q.cs.find((c) => c.t === 'order');
      if (order) docs.sort((a, b) => String(a.get(order.field as string) ?? '').localeCompare(String(b.get(order.field as string) ?? ''), undefined, { numeric: true }));
      const after = q.cs.find((c) => c.t === 'after');
      if (after) { const i = docs.findIndex((d) => d.id === after.id); docs = docs.slice(i + 1); }
      const lim = q.cs.find((c) => c.t === 'limit');
      if (lim) docs = docs.slice(0, lim.n as number);
      return { docs, empty: docs.length === 0, size: docs.length };
    },
    runTransaction: async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn({
      get: async (ref: { path: string }) => snap(ref.path),
      set: (ref: { path: string }, data: Data) => { store.set(ref.path, data); },
    }),
  };
}

export const fakeFirebase = () => ({
  isConfigured: true,
  firebase: () => ({ db: {}, auth: { currentUser: { uid: 'admin1', email: 'admin@x.com' } } }),
  secondaryAuth: () => ({}),
});
