import { isValidHexColor } from './lib-config';

export const DEFAULT_PRIMARY = '#1d4ed8';
export const DEFAULT_SECONDARY = '#0f766e';

/** Relative luminance per WCAG 2.x */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * (ch[0] as number) + 0.7152 * (ch[1] as number) + 0.0722 * (ch[2] as number);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Picks black or white text, whichever is more readable on the given background. */
export function readableTextOn(bg: string): '#ffffff' | '#111827' {
  return contrastRatio(bg, '#ffffff') >= contrastRatio(bg, '#111827') ? '#ffffff' : '#111827';
}

export function applyBranding(primary: string, secondary: string): void {
  const p = isValidHexColor(primary) ? primary : DEFAULT_PRIMARY;
  const s = isValidHexColor(secondary) ? secondary : DEFAULT_SECONDARY;
  const root = document.documentElement.style;
  root.setProperty('--primary', p);
  root.setProperty('--on-primary', readableTextOn(p));
  root.setProperty('--secondary', s);
  root.setProperty('--on-secondary', readableTextOn(s));
}

export function resetBranding(): void {
  applyBranding(DEFAULT_PRIMARY, DEFAULT_SECONDARY);
}
