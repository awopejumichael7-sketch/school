# School Platform — Batch 1 (Phases 1–6)

Multi-tenant, white-label school platform on **Firebase Spark (no Cloud Functions, no Storage)**.
One codebase serves every school. **Flat layout: every project file lives in this one folder.**

> **Status:** Phases 1–6 (architecture, Firebase setup, auth, multi-tenancy, license system, onboarding)
> plus a minimal school dashboard shell and the product-owner console. Student/teacher/attendance/fees/
> assignments/exams/results/Drive/notifications/analytics/PWA arrive in Phases 7–18.

## 1. Quick start

```bash
npm install
cp .env.example .env        # fill in the 4 Firebase values
npm run dev                 # http://localhost:5173
npm test                    # 55 unit/UI tests (no Firebase needed)
npm run typecheck && npm run build
```

### Firebase one-time setup (Spark plan)
1. Console → create project (stay on **Spark**). Add a **Web app**; copy its config into `.env`.
2. Authentication → Sign-in method → enable **Email/Password**.
3. Firestore → Create database (production mode).
4. Deploy rules + indexes: `npx firebase login && npx firebase use <project-id> && npm run deploy:rules`
5. **Create the product-owner account:** Authentication → Add user (your email). Copy its UID.
   Firestore → start collection `platformAdmins` → document ID = that UID → any field (e.g. `x: 1`).
   This is the *only* way to become product owner; no client can write that collection.
6. (Recommended, free) App Check → register reCAPTCHA v3 → put the site key in `VITE_APPCHECK_SITE_KEY`
   → enforce for Firestore and Auth after testing.
7. Hosting: `npm run deploy`.

### Selling to a school
Product owner opens `/#/platform` → Generate licenses → send the key to the customer (it is shown once; only its
hash is stored). Customer opens `/#/activate`, enters the key, creates the first admin, configures the school.
Their staff then sign in at `/#/s/<school-address>`.

## 2. Architecture (Spark-only)

Spark has no server code, so **Firestore Security Rules are the trusted backend.** Everything below is enforced
in `firestore.rules`, never by the browser.

| Concern | Mechanism |
|---|---|
| Tenant identity | Taken from the document **path** (`/tenants/{t}/…`), never from a client field. |
| Who is a member / role | `/tenants/{t}/members/{uid}` — created only in the activation batch by the license activator. |
| Product owner | Existence of `/platformAdmins/{uid}` (console-only). Owner can read tenant *records* but **not** school data. |
| License | Doc ID = `SHA-256(key)`; 80-bit key (`SC-XXXX-XXXX-XXXX-XXXX`, Crockford base32, `crypto.getRandomValues`). |
| One-time activation | Rules allow `UNUSED→ACTIVE`, count 0→1, only in the same atomic batch that creates the tenant owned by the caller. Concurrent attempts: Firestore commits one, the other is denied. |
| Key can never serve another tenant | `tenantId` is immutable once set (even for the owner). |
| Suspend / expire | Every tenant data rule checks `tenant.status` and `tenant.expiresAt` — expiry needs no cron job. |
| Reset installation | Owner sets license `RESET` + tenant `SUSPENDED`; only that tenant's admin, holding the key, can restore. |
| Audit | `/tenants/{t}/auditLogs` append-only; `actorId` forced to caller; server timestamp forced. |

Data model (flat under the tenant, no deep nesting):
`licenses/{hash}`, `licenseEvents/{id}`, `platformAdmins/{uid}`, `slugs/{slug}`, `publicProfiles/{tenantId}`,
`userDirectory/{uid}`, `tenants/{t}` + `members`, `classes`, `subjects`, `terms`, `auditLogs` (more per phase).

## 3. Honest limitations of Spark-only (read before selling)

1. **No server-side rate limiting.** Failed activation attempts cannot be throttled or logged server-side. Defence:
   80-bit keys (infeasible to guess), App Check, and a client-side backoff that is *cosmetic*. 
2. **Audit logs are client-written.** Rules force correct actor/time and make them append-only, but a malicious
   admin using their own session could omit entries. Truly tamper-proof audit needs Cloud Functions (Blaze).
3. **Cannot create/disable Auth users server-side.** Suspension is enforced by rules (members/tenant status),
   not by disabling the Auth account.
4. **Rule `get()` calls count as billed reads.** Each guarded request costs ~2 extra reads (member + tenant).
5. **No Cloud Storage.** Logos are shrunk to ≤60 KB and stored inline; files go to Google Drive (Phase 15).
6. **Quota is shared by all schools in one Firebase project.** Check current Spark quotas in the console. The usage
   dashboard (Phase 17) can only *estimate* from operations the app itself performs.
7. **License-binding is by tenant, not hardware.** "Installation reset" is an owner-controlled transfer, by design.
8. **Setup that fails after activation** can be resumed in the same session; across sessions the dashboard shows
   an "incomplete setup" banner (management screens come in later phases).
9. **Offline cache is wiped on sign-out** (shared school computers); this makes the next login's first reads cold.

## 4. Testing — what was actually run

| Suite | Command | Status in build sandbox |
|---|---|---|
| Logic (keys, hashing, grading, activation/ops plans, errors, theme) | `npm test` | ✅ 28 tests pass |
| UI + wizard flows with mocked Firebase (verification outcomes, race, resume, lock-out, dashboard states) | `npm test` | ✅ 27 tests pass |
| Strict TypeScript | `npm run typecheck` | ✅ clean |
| Production build | `npm run build` | ✅ passes (code-split) |
| **Firestore rules (cross-tenant, activation, owner, audit, public data)** | `npm run test:rules` | ⚠️ **Written, NOT executed** — the sandbox blocks the emulator download. **Run this before going live.** |

Not tested at all yet: real browser/device runs, live Firebase, accessibility audit with a screen reader.

## 5. Phase status

| Phase | State |
|---|---|
| 1 Architecture · 2 Firebase setup · 3 Auth · 4 Multi-tenancy · 5 License · 6 Onboarding | Built (rules need your emulator run) |
| 7 Admin dashboard | Shell only (overview) |
| 8–17 Students … Analytics · 18 PWA · 19 Security audit · 20 Testing · 21 Deploy | Not started |

## 6. Files (flat)
`firestore.rules` · `firestore.indexes.json` · `firebase.json` · `lib-*.ts` (logic) · `ctx-auth.tsx` ·
`page-*.tsx` (screens) · `ui.tsx` · `styles.css` · `*.test.ts(x)` · `rules.test.ts`

## 7. Deploying on GitHub Pages
1. Create a repo, push this folder to `main` (`.env` and `node_modules` are git-ignored; keep `package-lock.json`).
2. Settings → Pages → Source: **GitHub Actions**.
3. Settings → Secrets and variables → Actions → **Variables**: add `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`,
   `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID` (and `VITE_APPCHECK_SITE_KEY`). These are public identifiers.
4. Firebase Console → Authentication → Settings → **Authorized domains**: add `<your-user>.github.io` (and any custom domain).
   Add the same domain to your reCAPTCHA/App Check key.
5. Push. The workflow type-checks, tests, builds and publishes. Pages does NOT deploy Firestore rules:
   run `npm run deploy:rules` yourself whenever `firestore.rules` changes.
Notes: Pages ignores the security headers in `firebase.json` (no clickjacking header). Private repos need a paid GitHub plan for Pages.
A public repo exposes your source code, which matters if you resell it; use a private repo with Firebase Hosting instead.
