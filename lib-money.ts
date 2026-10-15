/**
 * Money is stored as WHOLE MINOR UNITS (kobo/cents) in integers, so 0.1 + 0.2 style errors cannot happen.
 * The platform assumes 2 decimal places.
 */
export const MAX_MINOR = 100_000_000_000; // 1 billion major units: far above any school fee, below 2^53

/** "50,000.50" -> 5000050. Rejects negatives, 3+ decimals, text, zero-length and absurd values. */
export function parseMoney(input: string): number | null {
  // Remove spaces/thousand separators and ONE leading currency symbol or 3-letter code. Anything else (including a
  // minus sign) is left in place so it fails validation instead of being silently "fixed".
  const s = input.trim().replace(/[\s,]/g, '').replace(/^(?:[₦$€£¥₵]|[A-Za-z]{3})/, '');
  if (!/^(\d+(\.\d{1,2})?|\.\d{1,2})$/.test(s)) return null;
  const [whole = '', frac = ''] = s.split('.');
  const minor = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2));
  return Number.isSafeInteger(minor) && minor <= MAX_MINOR ? minor : null;
}

export function formatMoney(minor: number, currency: string, locale?: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(minor / 100);
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
}

/** Plain "50000.00" for inputs and CSV. */
export const toPlain = (minor: number): string => `${Math.trunc(minor / 100)}.${String(Math.abs(minor % 100)).padStart(2, '0')}`;

// ------------------------------------------------------------- payment providers (modular)
export interface PaymentMethod { id: string; label: string; referenceRequired: boolean }
export interface PaymentProvider { id: string; name: string; methods: PaymentMethod[] }

/**
 * The basic version records payments taken outside the app. A future gateway (Paystack, Flutterwave...) is added by
 * registering another provider here; nothing else in the fee code changes.
 */
export const MANUAL_PROVIDER: PaymentProvider = {
  id: 'manual', name: 'Recorded manually',
  methods: [
    { id: 'CASH', label: 'Cash', referenceRequired: false },
    { id: 'BANK_TRANSFER', label: 'Bank transfer', referenceRequired: true },
    { id: 'POS', label: 'POS / card', referenceRequired: true },
    { id: 'CHEQUE', label: 'Cheque', referenceRequired: true },
    { id: 'OTHER', label: 'Other', referenceRequired: false },
  ],
};
export const PROVIDERS: PaymentProvider[] = [MANUAL_PROVIDER];
export const allMethods = (): PaymentMethod[] => PROVIDERS.flatMap((p) => p.methods);
export const findMethod = (id: string) => allMethods().find((m) => m.id === id);
