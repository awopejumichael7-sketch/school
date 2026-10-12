/**
 * Client-side backoff for repeated failed license attempts.
 * IMPORTANT: this is a usability/politeness control only. A determined attacker
 * can bypass it. Real protection on Spark is the 80-bit key space plus
 * Firebase App Check. See README "Known limitations".
 */
export const FREE_ATTEMPTS = 5;
export const MAX_LOCKOUT_MS = 15 * 60 * 1000;

export function lockoutMs(failures: number): number {
  if (failures < FREE_ATTEMPTS) return 0;
  return Math.min(MAX_LOCKOUT_MS, 30_000 * 2 ** (failures - FREE_ATTEMPTS));
}

const KEY = 'ss.licenseAttempts';
interface State { failures: number; last: number }

function read(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { failures: 0, last: 0 };
    const p = JSON.parse(raw) as Partial<State>;
    return { failures: Number(p.failures) || 0, last: Number(p.last) || 0 };
  } catch {
    return { failures: 0, last: 0 };
  }
}
function write(s: State): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

/** Seconds the user must still wait (0 = allowed). */
export function secondsLocked(now = Date.now()): number {
  const s = read();
  const wait = lockoutMs(s.failures) - (now - s.last);
  return wait > 0 ? Math.ceil(wait / 1000) : 0;
}
export function recordFailure(now = Date.now()): void {
  const s = read();
  write({ failures: s.failures + 1, last: now });
}
export function recordSuccess(): void { write({ failures: 0, last: 0 }); }
