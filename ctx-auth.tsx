import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut as fbSignOut, type User } from 'firebase/auth';
import { clearIndexedDbPersistence, doc, getDoc, terminate } from 'firebase/firestore';
import { firebase, isConfigured } from './lib-firebase';
import { logAudit } from './lib-audit';
import { logTechnical } from './lib-errors';
import type { MemberDoc, TenantDoc } from './types';

export interface Session {
  status: 'loading' | 'signedOut' | 'ready';
  user: User | null;
  isPlatformAdmin: boolean;
  tenantId: string | null;
  member: MemberDoc | null;
  tenant: TenantDoc | null;
}

interface Ctx extends Session {
  refresh: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const EMPTY: Session = { status: 'loading', user: null, isPlatformAdmin: false, tenantId: null, member: null, tenant: null };
const AuthContext = createContext<Ctx | null>(null);

async function safeGet<T>(path: string): Promise<T | null> {
  try {
    const snap = await getDoc(doc(firebase().db, path));
    return snap.exists() ? (snap.data() as T) : null;
  } catch (e) {
    logTechnical(`get ${path}`, e);
    return null;
  }
}

async function loadSession(user: User): Promise<Session> {
  const [admin, dir] = await Promise.all([
    safeGet<object>(`platformAdmins/${user.uid}`),
    safeGet<{ tenantId: string }>(`userDirectory/${user.uid}`),
  ]);
  const tenantId = dir?.tenantId ?? null;
  let member: MemberDoc | null = null;
  let tenant: TenantDoc | null = null;
  if (tenantId) {
    [member, tenant] = await Promise.all([
      safeGet<MemberDoc>(`tenants/${tenantId}/members/${user.uid}`),
      safeGet<TenantDoc>(`tenants/${tenantId}`),
    ]);
  }
  return { status: 'ready', user, isPlatformAdmin: admin !== null, tenantId, member, tenant };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session>(
    isConfigured ? EMPTY : { ...EMPTY, status: 'signedOut' },
  );
  const seq = useRef(0);

  const load = useCallback(async (user: User | null) => {
    const mine = ++seq.current;
    if (!user) {
      if (mine === seq.current) setSession({ ...EMPTY, status: 'signedOut' });
      return;
    }
    const s = await loadSession(user);
    if (mine === seq.current) setSession(s); // ignore out-of-date loads
  }, []);

  useEffect(() => {
    if (!isConfigured) return;
    return onAuthStateChanged(firebase().auth, (u) => { void load(u); });
  }, [load]);

  const refresh = useCallback(async () => {
    if (!isConfigured) return;
    await load(firebase().auth.currentUser);
  }, [load]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { auth, db } = firebase();
    const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
    const s = await loadSession(cred.user);
    setSession(s);
    if (s.tenantId && s.member) await logAudit(db, s.tenantId, cred.user.uid, 'auth.login', `members/${cred.user.uid}`);
  }, []);

  const signOut = useCallback(async () => {
    const { auth, db } = firebase();
    const u = auth.currentUser;
    if (u && session.tenantId && session.member) {
      await logAudit(db, session.tenantId, u.uid, 'auth.logout', `members/${u.uid}`);
    }
    await fbSignOut(auth);
    // Shared school computers: wipe the offline cache so the next person can't see cached data.
    try {
      await terminate(db);
      await clearIndexedDbPersistence(db);
    } catch (e) {
      logTechnical('clearCache', e);
    }
    window.location.assign(`${window.location.pathname}#/`);
    window.location.reload();
  }, [session.tenantId, session.member]);

  const value = useMemo<Ctx>(() => ({ ...session, refresh, signIn, signOut }), [session, refresh, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): Ctx {
  const c = useContext(AuthContext);
  if (!c) throw new Error('useAuth must be used inside <AuthProvider>');
  return c;
}
