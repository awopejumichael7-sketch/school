/**
 * License key generation, normalisation and hashing.
 *
 * Format: SC-XXXX-XXXX-XXXX-XXXX  (16 symbols x 5 bits = 80 bits of entropy)
 * Alphabet: Crockford base32 (no I, L, O, U) - 32 symbols, so mapping random
 * bytes with `% 32` is unbiased.
 *
 * Only the SHA-256 hash is stored (as the Firestore document ID). Because the
 * key has 80 bits of entropy, an unsalted hash is not brute-forceable, and no
 * server-side secret is needed (important for a Spark-only deployment).
 */
export const KEY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const KEY_PREFIX = 'SC';
const GROUPS = 4;
const GROUP_LEN = 4;
const KEY_SYMBOLS = GROUPS * GROUP_LEN;
const HASH_DOMAIN = 'school-saas/license/v1:';

export type RandomBytes = (n: number) => Uint8Array;

export const secureRandomBytes: RandomBytes = (n) => {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
};

export function generateLicenseKey(rng: RandomBytes = secureRandomBytes): string {
  const bytes = rng(KEY_SYMBOLS);
  if (bytes.length < KEY_SYMBOLS) throw new Error('RNG returned too few bytes');
  let symbols = '';
  for (let i = 0; i < KEY_SYMBOLS; i++) {
    symbols += KEY_ALPHABET[(bytes[i] as number) % 32];
  }
  return formatSymbols(symbols);
}

function formatSymbols(symbols: string): string {
  const parts: string[] = [];
  for (let i = 0; i < GROUPS; i++) parts.push(symbols.slice(i * GROUP_LEN, (i + 1) * GROUP_LEN));
  return `${KEY_PREFIX}-${parts.join('-')}`;
}

/**
 * Accepts user input in any case, with or without dashes/spaces, and
 * tolerates common look-alike typos (O->0, I/L->1). Returns the canonical key
 * or null when the input cannot be a valid key.
 */
export function normalizeLicenseKey(input: string): string | null {
  const cleaned = input.toUpperCase().replace(/[\s-]/g, '');
  if (!cleaned.startsWith(KEY_PREFIX)) return null;
  const body = cleaned
    .slice(KEY_PREFIX.length)
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (body.length !== KEY_SYMBOLS) return null;
  for (const ch of body) if (!KEY_ALPHABET.includes(ch)) return null;
  return formatSymbols(body);
}

/** Hex SHA-256 of the canonical key. This is the Firestore document ID. */
export async function hashLicenseKey(canonicalKey: string): Promise<string> {
  const data = new TextEncoder().encode(HASH_DOMAIN + canonicalKey);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function isLicenseHash(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

/** Never log or display raw keys after creation; use this for UI hints. */
export function maskKey(canonicalKey: string): string {
  return `${KEY_PREFIX}-••••-••••-••••-${canonicalKey.slice(-4)}`;
}
