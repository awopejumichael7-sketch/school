# School Platform — Batch 2 (Phases 1–9)

Multi-tenant, white-label school platform on **Firebase Spark (no Cloud Functions, no Storage)**.
One codebase serves every school. **Flat layout: every project file lives in this one folder.**

**Built:** licensing, onboarding, branded login, product-owner console, and (new in this batch) school settings,
academics (classes/subjects/terms), students, teachers, parents, user management, CSV import, first-login password
change, teacher class-scoping and role-based navigation.
**Not built yet:** attendance, fees, assignments, exams, results, Drive, notifications, analytics, PWA (Phases 10–18).

## 1. Upgrading from Batch 1 (do these in order)
1. Replace all project files with this batch (keep your `.env`, or re-enter the 4 variables on GitHub).
2. **Publish the new `firestore.rules`** (Firebase Console → Firestore → Rules → paste → Publish). Without this the new
   screens will show "You don't have permission". Existing schools keep working: nothing in their data changes.
3. Redeploy the site (GitHub: upload the files; Firebase Hosting: `npm run deploy`).
4. Run the rules tests (section 6) before putting real schools on it.

## 2. Quick start
```bash
npm install
cp .env.example .env        # fill in the 4 Firebase values
npm run dev                 # http://localhost:5173
npm test                    # 151 tests, no Firebase needed
npm run typecheck && npm run build
```
Firebase setup (Spark): create project → add Web app → enable Email/Password → create Firestore (production mode) →
publish `firestore.rules` → create your owner account (Authentication → Add user; then Firestore collection
`platformAdmins`, document ID = that user's UID, any field). Optional but recommended: App Check (reCAPTCHA v3) and set
`VITE_APPCHECK_SITE_KEY`.

## 3. What each role can do
| Role | Sees |
|---|---|
| SCHOOL_ADMIN | Everything: Academics, Students, Teachers, Parents, Users, Import, Settings |
| PRINCIPAL | Academics (edit), Students and Teachers (read-only) |
| TEACHER | Overview and **My classes** (only assigned classes, enforced by rules) |
| ACCOUNTANT / STAFF | Students (read); STAFF also Teachers (read) |
| STUDENT / PARENT | Overview now; portals arrive in later phases |

The matrix lives in `lib-permissions.ts` (UI) and `firestore.rules` (enforcement); `rules-lint.test.ts` keeps what the
app writes aligned with what the rules accept.

## 4. How accounts work on Spark
Spark has no Admin SDK, so the browser creates other people's logins using a **second Firebase app instance**
(the admin is never signed out). The admin sets nothing: a random 12-character temporary password is generated and
shown **once**. The new account has **no data access** (enforced in `hasRole`) until the person replaces it on first
sign-in. If saving the school records fails, the new login is deleted again (rollback).
- Teachers/parents with a real email sign in with it. Students (and parents without email) sign in with a username:
  the admission number / generated `parent-xxxxxx`, mapped to a private address `…@<school>.login.invalid`.
- "Forgot password?" works for real emails. Username-only accounts cannot be reset on Spark: create a new account.
- Admission numbers: `<PREFIX>-<YEAR>-<0001>` from a counter that only moves forward; the document ID **is** the
  admission number, so duplicates are impossible. Custom numbers are stored upper-case.

## 5. Honest limitations (read before selling)
1. **No server-side rate limiting** on license attempts (key space 80 bits + App Check; client backoff is cosmetic).
2. **Audit logs are client-written** (append-only, actor forced by rules) so a malicious admin could skip an entry.
3. **A school admin knows each new user's temporary password** until they change it (the app forces the change).
4. **No password reset for username-only accounts.**
5. **Rule lookups are billed reads** (~2 per guarded request). The quota is shared by all schools in one project.
6. **All members can read their school's tenant document**, which contains internal ids (license hash, owner id).
   No student data or key is in it. Splitting it would need a second document (planned hardening).
7. **No server-side referential integrity**: e.g. deleting/archiving a class does not check students (we archive
   instead of delete). The UI offers only active classes for new records.
8. **Bulk import writes in batches of 8** and reports per-row failures; a failure mid-import leaves earlier batches saved.
9. **Offline cache is wiped on sign-out** (shared school computers).
10. Photos/logos are small inline images (≤ 28 KB / 60 KB) because Spark has no Cloud Storage.

### Assumptions I could not verify without a live project (please check in your test school)
- Firebase Auth accepts the reserved `.invalid` domain for username accounts. (If not, student/parent username
  sign-in needs a different suffix: one constant in `lib-accounts.ts`.)
- Teacher-scoped student queries (`where classId == X`) satisfy the rule that compares against the teacher's
  `classIds`. Covered by `rules.test.ts`; run it.
- A 9-operation batch stays under the rules' 20 document-access-call limit (designed with margin; emulator test needed).

## 6. Testing — what was actually run
| Suite | Command | Status in my sandbox |
|---|---|---|
| Logic: keys, hashing, grading, CSV, validation, permissions, accounts, plans | `npm test` | ✅ pass |
| UI + flows against an in-memory Firestore: every screen above, role gating, imports, failures | `npm test` | ✅ pass |
| Rules lint: syntax balance, undefined helpers, **app writes ⊆ rules-allowed keys** (mutation-checked) | `npm test` | ✅ pass |
| Strict TypeScript / production build | `npm run typecheck` / `npm run build` | ✅ pass |
| **Firestore rules against the emulator (isolation, activation, accounts, students, counters…)** | `npm run test:rules` | ⚠️ **Written, NOT executed** (emulator download blocked in my sandbox). **Run before going live.** |

Never tested: real browsers/devices, live Firebase, screen readers, real email delivery.
Run the emulator tests: install Java, `npm install`, `npm run test:rules`. Paste any failure to me.

## 7. Deploying
- **Firebase Hosting (private source, recommended for resale):** `npx firebase login`, `npx firebase use <id>`, `npm run deploy`.
- **GitHub Pages:** push to `main`; set Settings → Pages → Source = GitHub Actions; add the 4 `VITE_FIREBASE_*` values under
  Settings → Secrets and variables → Actions → **Variables**; add `<user>.github.io` to Firebase Authorized domains.
  Public repos expose your source; private repos need a paid GitHub plan for Pages. Pages ignores `firebase.json` headers
  and never deploys Firestore rules.

## 8. Files (flat)
`firestore.rules` · `firestore.indexes.json` · `firebase.json` · `lib-*.ts` (logic) · `ctx-auth.tsx`, `ctx-tenant.tsx` ·
`page-*.tsx` (screens) · `ui.tsx`, `ui-editors.tsx` · `use-action.ts` · `styles.css` · `*.test.ts(x)` · `test-store.ts` (test fake) ·
`.github/workflows/deploy.yml` (GitHub requires this exact path) · `.env.example`, `.gitignore` (dotfiles: show hidden files).

## 9. Phase status
| Phase | State |
|---|---|
| 1–6 Architecture, Firebase, Auth, Tenancy, License, Onboarding | Built (rules need your emulator run) |
| 7 Admin dashboard · 8 Students · 9 Teachers (+ parents, users, settings, import) | **Built this batch** |
| 10 Attendance · 11 Fees · 12 Assignments · 13 Exams · 14 Results | Not started |
| 15 Drive · 16 Notifications · 17 Analytics · 18 PWA · 19 Security audit · 20 Testing · 21 Deploy | Not started |
