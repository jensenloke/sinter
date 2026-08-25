export const CLOUD_DEVELOPMENT_LIMITS = Object.freeze({
  capsuleSizeBytes: 16 * 1024 * 1024,
  devices: 2,
});

export const CLOUD_SAFETY_CAPS = Object.freeze({
  capsuleSizeBytes: 64 * 1024 * 1024,
  devices: 32,
});

export interface CloudEntitlement {
  account_id: string;
  plan_code: string;
  status: string;
  uploads_enabled: boolean;
  unmetered: boolean;
  storage_limit_bytes: number | null;
  session_limit: number | null;
  capsule_size_limit_bytes: number | null;
  device_limit: number | null;
  updated_at: string;
}

export interface CloudUsage {
  account_id: string;
  retained_storage_bytes: number;
  capsule_count: number;
  reserved_storage_bytes: number;
  reserved_capsule_count: number;
  monthly_egress_bytes: number;
  period_started_at: string | null;
  updated_at: string;
}

export function developmentEntitlement(accountId: string): CloudEntitlement {
  return {
    account_id: accountId,
    plan_code: "development",
    status: "active",
    uploads_enabled: false,
    unmetered: false,
    storage_limit_bytes: 0,
    session_limit: 0,
    capsule_size_limit_bytes: CLOUD_DEVELOPMENT_LIMITS.capsuleSizeBytes,
    device_limit: CLOUD_DEVELOPMENT_LIMITS.devices,
    updated_at: new Date(0).toISOString(),
  };
}

export function developmentUsage(accountId: string): CloudUsage {
  return {
    account_id: accountId,
    retained_storage_bytes: 0,
    capsule_count: 0,
    reserved_storage_bytes: 0,
    reserved_capsule_count: 0,
    monthly_egress_bytes: 0,
    period_started_at: null,
    updated_at: new Date(0).toISOString(),
  };
}

export function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 bytes";
  const units = ["bytes", "KiB", "MiB", "GiB", "TiB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / (1024 ** exponent);
  const digits = amount >= 10 || exponent === 0 ? 0 : 1;
  return `${amount.toFixed(digits)} ${units[exponent]}`;
}

function titleCasePlan(value: string) {
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ") || "Development";
}

function boundedSafetyCap(value: number | null, fallback: number, maximum: number) {
  return Math.min(value ?? fallback, maximum);
}

export interface QuotaDisplayData {
  planLabel: string;
  statusLabel: string;
  uploadsLabel: string;
  retainedStorageLabel: string;
  reservedStorageLabel: string;
  storageLimitLabel: string;
  sessionUsageLabel: string;
  reservedSessionLabel: string;
  sessionLimitLabel: string;
  capsuleSafetyLabel: string;
  deviceSafetyLabel: string;
}

export function quotaDisplayData(
  entitlement: CloudEntitlement,
  usage: CloudUsage,
): QuotaDisplayData {
  const unmetered = entitlement.unmetered;
  return {
    planLabel: unmetered ? "Unmetered administrator" : titleCasePlan(entitlement.plan_code),
    statusLabel: titleCasePlan(entitlement.status),
    uploadsLabel: entitlement.uploads_enabled
      ? "Entitled, but disabled globally"
      : "Disabled",
    retainedStorageLabel: formatBytes(usage.retained_storage_bytes),
    reservedStorageLabel: formatBytes(usage.reserved_storage_bytes),
    storageLimitLabel: unmetered
      ? "Unmetered"
      : entitlement.storage_limit_bytes === null
        ? "Not configured"
        : formatBytes(entitlement.storage_limit_bytes),
    sessionUsageLabel: usage.capsule_count.toLocaleString("en"),
    reservedSessionLabel: usage.reserved_capsule_count.toLocaleString("en"),
    sessionLimitLabel: unmetered
      ? "Unmetered"
      : entitlement.session_limit === null
        ? "Not configured"
        : entitlement.session_limit.toLocaleString("en"),
    capsuleSafetyLabel: formatBytes(boundedSafetyCap(
      entitlement.capsule_size_limit_bytes,
      CLOUD_DEVELOPMENT_LIMITS.capsuleSizeBytes,
      CLOUD_SAFETY_CAPS.capsuleSizeBytes,
    )),
    deviceSafetyLabel: boundedSafetyCap(
      entitlement.device_limit,
      CLOUD_DEVELOPMENT_LIMITS.devices,
      CLOUD_SAFETY_CAPS.devices,
    ).toLocaleString("en"),
  };
}
