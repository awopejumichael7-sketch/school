import type { AssessmentWeight, GradeBand } from './types';

/** Neutral defaults - NOT tied to any country. Schools edit these in onboarding/settings. */
export const DEFAULT_GRADING: GradeBand[] = [
  { min: 80, max: 100, grade: 'A', remark: 'Excellent' },
  { min: 65, max: 79.99, grade: 'B', remark: 'Very Good' },
  { min: 50, max: 64.99, grade: 'C', remark: 'Good' },
  { min: 40, max: 49.99, grade: 'D', remark: 'Pass' },
  { min: 0, max: 39.99, grade: 'F', remark: 'Fail' },
];

export const DEFAULT_ASSESSMENT: AssessmentWeight[] = [
  { key: 'ca', label: 'CA / Test', weight: 40 },
  { key: 'exam', label: 'Exam', weight: 60 },
];

export const DEFAULT_TERMS = ['Term 1', 'Term 2', 'Term 3'];

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/** Must match the slug rule in firestore.rules. */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]{2,39}$/.test(slug);
}

export function isValidHexColor(v: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(v);
}

/** Splits comma/newline separated text into trimmed, de-duplicated, non-empty items. */
export function parseList(text: string, max = 200): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\n,;]+/)) {
    const item = raw.trim().replace(/\s+/g, ' ');
    const k = item.toLowerCase();
    if (item && !seen.has(k)) {
      seen.add(k);
      out.push(item);
      if (out.length >= max) break;
    }
  }
  return out;
}

export interface ValidationResult { ok: boolean; errors: string[] }

/** Bands must be valid, ordered ranges that cover 0..100 without gaps/overlap (0.01 resolution). */
export function validateGrading(bands: GradeBand[]): ValidationResult {
  const errors: string[] = [];
  if (bands.length < 2) errors.push('Add at least two grade bands.');
  const sorted = [...bands].sort((a, b) => a.min - b.min);
  for (const b of sorted) {
    if (!b.grade.trim()) errors.push('Every band needs a grade label.');
    if (!(b.min >= 0 && b.max <= 100 && b.min <= b.max)) {
      errors.push(`Band "${b.grade || '?'}" has an invalid range.`);
    }
  }
  if (errors.length === 0) {
    const first = sorted[0] as GradeBand;
    const last = sorted[sorted.length - 1] as GradeBand;
    if (first.min !== 0) errors.push('Lowest band must start at 0.');
    if (last.max !== 100) errors.push('Highest band must end at 100.');
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1] as GradeBand;
      const cur = sorted[i] as GradeBand;
      const gap = Math.round((cur.min - prev.max) * 100) / 100;
      if (gap > 0.01) errors.push(`Gap between "${prev.grade}" and "${cur.grade}".`);
      if (gap < 0.01) errors.push(`Overlap between "${prev.grade}" and "${cur.grade}".`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateAssessment(items: AssessmentWeight[]): ValidationResult {
  const errors: string[] = [];
  if (items.length === 0) errors.push('Add at least one assessment type.');
  const keys = new Set<string>();
  let total = 0;
  for (const it of items) {
    if (!it.label.trim()) errors.push('Every assessment needs a name.');
    if (!(it.weight >= 0 && it.weight <= 100)) errors.push(`Weight for "${it.label}" must be 0-100.`);
    if (keys.has(it.key)) errors.push(`Duplicate assessment "${it.label}".`);
    keys.add(it.key);
    total += it.weight;
  }
  if (items.length > 0 && Math.round(total * 100) !== 10000) {
    errors.push(`Weights must add up to 100 (currently ${total}).`);
  }
  return { ok: errors.length === 0, errors };
}

/** Looks up the grade for a 0-100 score using the school's own bands. */
export function gradeFor(score: number, bands: GradeBand[]): GradeBand | null {
  if (Number.isNaN(score)) return null;
  const s = Math.min(100, Math.max(0, score));
  return bands.find((b) => s >= b.min && s <= b.max) ?? null;
}

/** Percentage helper used by attendance/analytics later: 42/45 -> 93.33 */
export function percentage(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 10000) / 100;
}
