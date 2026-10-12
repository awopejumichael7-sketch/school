import type { Timestamp } from 'firebase/firestore';

export type Role =
  | 'SCHOOL_ADMIN' | 'PRINCIPAL' | 'TEACHER' | 'STUDENT'
  | 'PARENT' | 'ACCOUNTANT' | 'STAFF';

export type LicenseStatus = 'UNUSED' | 'ACTIVE' | 'DEACTIVATED' | 'RESET';
export type TenantStatus = 'ACTIVE' | 'SUSPENDED';
export type BillingCycle = 'LIFETIME' | 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';

/** Stored at /licenses/{sha256(normalizedKey)}. The raw key is never stored. */
export interface LicenseDoc {
  product: string;
  plan: string;
  billingCycle: BillingCycle;
  status: LicenseStatus;
  tenantId: string | null;
  installationId: string | null;
  activationCount: number;
  maxActivations: number;
  createdAt: Timestamp;
  createdBy: string;
  activatedAt: Timestamp | null;
  activatedBy: string | null;
  lastValidated: Timestamp | null;
  expiresAt: Timestamp | null;
  note: string;
}

export interface GradeBand { min: number; max: number; grade: string; remark: string }
export interface AssessmentWeight { key: string; label: string; weight: number }

export interface SchoolProfile {
  name: string;
  motto: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  footer: string;
  emailSenderName: string;
}

export interface SchoolSettings {
  academicSession: string;
  terms: string[];
  currency: string;
  timezone: string;
  grading: GradeBand[];
  assessment: AssessmentWeight[];
}

export interface TenantDoc {
  name: string;
  ownerUid: string;
  licenseId: string;
  plan: string;
  status: TenantStatus;
  installationId: string;
  expiresAt: Timestamp | null;
  profile: SchoolProfile;
  settings: SchoolSettings;
  setupComplete: boolean;
  createdAt: Timestamp;
}

export interface PublicProfile {
  tenantId: string;
  slug: string;
  name: string;
  motto: string;
  logoDataUrl: string | null;
  primaryColor: string;
  secondaryColor: string;
}

export interface MemberDoc {
  uid: string;
  tenantId: string;
  role: Role;
  status: 'ACTIVE' | 'DISABLED';
  displayName: string;
  email: string;
}
