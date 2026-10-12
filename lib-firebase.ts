import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';
import {
  getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager, type Firestore,
} from 'firebase/firestore';

const cfg = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string | undefined,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
};

/** False until .env is filled in; the UI shows a setup screen instead of crashing. */
export const isConfigured = Boolean(cfg.apiKey && cfg.projectId && cfg.appId);

interface Services { app: FirebaseApp; auth: Auth; db: Firestore }
let services: Services | null = null;

export function firebase(): Services {
  if (services) return services;
  if (!isConfigured) throw new Error('Firebase is not configured');
  const app = initializeApp(cfg);

  const siteKey = import.meta.env.VITE_APPCHECK_SITE_KEY as string | undefined;
  if (siteKey) {
    // Free abuse protection: blocks requests not coming from this genuine web app.
    initializeAppCheck(app, { provider: new ReCaptchaV3Provider(siteKey), isTokenAutoRefreshEnabled: true });
  }

  let db: Firestore;
  try {
    // Local cache cuts repeat reads (free-tier friendly) and gives read-only offline use.
    db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
  } catch {
    db = getFirestore(app);
  }
  services = { app, auth: getAuth(app), db };
  return services;
}
