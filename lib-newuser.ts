import { createUserWithEmailAndPassword, deleteUser, signOut } from 'firebase/auth';
import { secondaryAuth } from './lib-firebase';
import { logTechnical } from './lib-errors';

/**
 * Creates a login account for someone else, runs `run(uid)` (which writes the school records),
 * and ROLLS BACK the account if that fails — otherwise a half-created account would block the
 * email address from ever being used again. The admin stays signed in throughout.
 */
export async function withNewAccount<T>(email: string, password: string, run: (uid: string) => Promise<T>): Promise<T> {
  const auth = secondaryAuth();
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  try {
    return await run(cred.user.uid);
  } catch (e) {
    try { await deleteUser(cred.user); } catch (d) { logTechnical('rollbackAccount', d); }
    throw e;
  } finally {
    try { await signOut(auth); } catch (s) { logTechnical('secondarySignOut', s); }
  }
}
