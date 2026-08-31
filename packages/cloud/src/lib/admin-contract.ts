export const ADMIN_UPDATE_CONFIRMATION_PREFIX = "UPDATE";
export const ADMIN_REASON_LIMITS = Object.freeze({ minimum: 1, maximum: 500 });

export interface AdminEntitlementMetadata {
  account_id: string;
  plan_code: string;
  status: string;
  uploads_enabled: boolean;
  unmetered: boolean;
  storage_limit_bytes: number | null;
  session_limit: number | null;
  capsule_size_limit_bytes: number;
  device_limit: number;
  updated_at: string;
}

export interface AdminAccountMetadata extends AdminEntitlementMetadata {
  account_email: string | null;
  account_created_at: string;
  deletion_requested_at: string | null;
  retained_storage_bytes: number;
  capsule_count: number;
  reserved_storage_bytes: number;
  reserved_capsule_count: number;
  monthly_egress_bytes: number;
  usage_period_started_at: string | null;
  usage_updated_at: string;
  active_device_count: number;
  total_device_count: number;
  pending_enrollment_count: number;
}
