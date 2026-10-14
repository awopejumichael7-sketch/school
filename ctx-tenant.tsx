import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { collection, doc, getDoc, getDocs, limit, orderBy, query } from 'firebase/firestore';
import { firebase } from './lib-firebase';
import { logTechnical } from './lib-errors';
import { applyBranding, resetBranding } from './lib-theme';
import type { MemberDoc, NamedItem, PublicProfile, TenantDoc } from './types';

export interface TenantCtx {
  tenantId: string;
  uid: string;
  tenant: TenantDoc;
  member: MemberDoc;
  profile: PublicProfile | null;
  /** The school's web address (needed to build student/parent usernames). */
  slug: string | null;
  classes: NamedItem[];
  subjects: NamedItem[];
  terms: NamedItem[];
  ready: boolean;
  reload: () => Promise<void>;
}

const Ctx = createContext<TenantCtx | null>(null);
export const isActiveItem = (i: NamedItem) => (i.status ?? 'ACTIVE') === 'ACTIVE';

async function names(tenantId: string, col: string): Promise<NamedItem[]> {
  try {
    const snap = await getDocs(query(collection(firebase().db, `tenants/${tenantId}/${col}`), orderBy('order'), limit(200)));
    return snap.docs.map((d) => ({
      id: d.id, name: String(d.get('name') ?? ''), status: d.get('status') as string | undefined, order: d.get('order') as number | undefined,
    }));
  } catch (e) {
    logTechnical(`load ${col}`, e);
    return [];
  }
}

export function TenantProvider({ tenantId, uid, tenant, member, children }:
  { tenantId: string; uid: string; tenant: TenantDoc; member: MemberDoc; children: ReactNode }) {
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [classes, setClasses] = useState<NamedItem[]>([]);
  const [subjects, setSubjects] = useState<NamedItem[]>([]);
  const [terms, setTerms] = useState<NamedItem[]>([]);
  const [ready, setReady] = useState(false);

  const reload = useCallback(async () => {
    const [c, s, t, p] = await Promise.all([
      names(tenantId, 'classes'), names(tenantId, 'subjects'), names(tenantId, 'terms'),
      getDoc(doc(firebase().db, `publicProfiles/${tenantId}`)).then((x) => (x.exists() ? (x.data() as PublicProfile) : null)).catch((e) => { logTechnical('profile', e); return null; }),
    ]);
    setClasses(c); setSubjects(s); setTerms(t); setProfile(p); setReady(true);
    if (p) applyBranding(p.primaryColor, p.secondaryColor);
  }, [tenantId]);

  useEffect(() => {
    void reload();
    return () => resetBranding();
  }, [reload]);

  const value = useMemo<TenantCtx>(() => ({
    tenantId, uid, tenant, member, profile, slug: profile?.slug ?? null, classes, subjects, terms, ready, reload,
  }), [tenantId, uid, tenant, member, profile, classes, subjects, terms, ready, reload]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTenant(): TenantCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useTenant must be used inside <TenantProvider>');
  return c;
}
