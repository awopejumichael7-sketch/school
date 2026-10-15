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
  /** Prefix for generated admission numbers, e.g. "SCA". Defaults from the school name. */
  admissionPrefix?: string;
  pastSessions?: string[];
  /** How Late / Excused count in attendance percentages (see lib-attendance). */
  attendance?: { lateCountsAsPresent?: boolean; excusedCountsAsAbsent?: boolean };
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
  /** Sign-in name for accounts without a real email (e.g. students). */
  loginId?: string;
  /** True until the user replaces the admin-issued temporary password. */
  mustChangePassword?: boolean;
  /** Teachers: classes/subjects they are assigned to (used by security rules). */
  classIds?: string[];
  subjectIds?: string[];
}

export type RecordStatus = 'ACTIVE' | 'INACTIVE';
export type StudentStatus = 'ACTIVE' | 'INACTIVE' | 'GRADUATED' | 'TRANSFERRED';
export type Gender = 'MALE' | 'FEMALE';

export interface NamedItem { id: string; name: string; status?: string; order?: number; startDate?: string; endDate?: string }

export interface StudentDoc {
  tenantId: string;
  studentId: string;
  admissionNumber: string;
  firstName: string;
  middleName: string;
  lastName: string;
  gender: Gender;
  dateOfBirth: string; // YYYY-MM-DD
  photo: string | null;
  classId: string;
  parentIds: string[];
  phone: string;
  email: string;
  address: string;
  admissionDate: string; // YYYY-MM-DD
  status: StudentStatus;
  academicSession: string;
  uid: string | null;
}

export interface TeacherDoc {
  tenantId: string;
  teacherId: string;
  uid: string;
  name: string;
  photo: string | null;
  phone: string;
  email: string;
  loginId: string;
  subjects: string[];
  classes: string[];
  status: RecordStatus;
}

export interface ParentDoc {
  tenantId: string;
  uid: string;
  name: string;
  phone: string;
  email: string;
  loginId: string;
  childIds: string[];
  status: RecordStatus;
}

export type FeeCategory = 'TUITION' | 'BOOKS' | 'UNIFORM' | 'TRANSPORT' | 'EXAMINATION' | 'OTHER';
export type FeeStatus = 'UNPAID' | 'PARTIAL' | 'PAID' | 'CANCELLED';

/** A fee type applied to classes (e.g. "Tuition - Term 1 - JSS 1"). Invoices are generated from it. */
export interface FeeItemDoc {
  tenantId: string; name: string; category: FeeCategory; amount: number; classIds: string[];
  termId: string; session: string; status: 'ACTIVE' | 'ARCHIVED';
}

/** One student's bill. All money values are integers in minor units (kobo/cents). */
export interface FeeDoc {
  tenantId: string; studentId: string; studentName: string; classId: string; itemId: string | null;
  description: string; category: FeeCategory; amount: number; amountPaid: number; balance: number;
  status: FeeStatus; session: string; termId: string; dueDate: string;
}

export interface PaymentDoc {
  tenantId: string; feeId: string; studentId: string; studentName: string; classId: string; description: string;
  amount: number; balanceAfter: number; kind: 'PAYMENT' | 'REVERSAL'; method: string; reference: string; note: string;
  paymentDate: string; receiptNumber: string; reverses: string | null; reversed: boolean; reversedBy: string | null;
  recordedBy: string; recordedByName: string;
}
