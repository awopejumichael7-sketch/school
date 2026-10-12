/**
 * Maps technical errors (Firebase etc.) to safe, human messages.
 * Raw error text is never returned to the UI.
 */
const MESSAGES: Record<string, string> = {
  'permission-denied': "You don't have permission to perform this action.",
  unauthenticated: 'Please sign in to continue.',
  'not-found': 'The requested item could not be found.',
  'already-exists': 'That item already exists.',
  'failed-precondition': 'This action cannot be completed right now. Please refresh and try again.',
  aborted: 'The action conflicted with another change. Please try again.',
  unavailable: 'The service is temporarily unavailable. Check your connection and try again.',
  'deadline-exceeded': 'The request took too long. Please try again.',
  'resource-exhausted': 'The system is busy or has reached its daily limit. Please try again later.',
  'invalid-argument': 'Some of the information you entered is not valid.',
  'auth/invalid-credential': 'Incorrect email or password.',
  'auth/wrong-password': 'Incorrect email or password.',
  'auth/user-not-found': 'Incorrect email or password.',
  'auth/invalid-email': 'Please enter a valid email address.',
  'auth/email-already-in-use': 'An account with this email already exists. Try signing in instead.',
  'auth/weak-password': 'Please choose a stronger password (at least 8 characters).',
  'auth/too-many-requests': 'Too many attempts. Please wait a few minutes and try again.',
  'auth/network-request-failed': 'Network problem. Check your connection and try again.',
  'auth/user-disabled': 'This account has been disabled. Contact your school administrator.',
  'auth/requires-recent-login': 'Please sign in again to continue.',
};

export const GENERIC_ERROR = 'Something went wrong. Please try again.';

export function errorCode(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'code' in e) {
    const code = (e as { code: unknown }).code;
    if (typeof code === 'string') return code.replace(/^firestore\//, '');
  }
  return '';
}

export function friendlyError(e: unknown): string {
  if (e instanceof UserFacingError) return e.message;
  return MESSAGES[errorCode(e)] ?? GENERIC_ERROR;
}

/** Errors whose message is safe to show to users as-is (we author the text). */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserFacingError';
  }
}

/** Technical details go to the console only (never to the UI). */
export function logTechnical(context: string, e: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[${context}]`, errorCode(e) || '', e);
}
