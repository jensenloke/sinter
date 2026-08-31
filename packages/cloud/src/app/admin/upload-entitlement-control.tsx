"use client";

import { useState } from "react";

interface UploadEntitlementControlProps {
  entitlementEnabled: boolean;
  featureGateEnabled: boolean;
}

export function UploadEntitlementControl({
  entitlementEnabled,
  featureGateEnabled,
}: UploadEntitlementControlProps) {
  const [enabled, setEnabled] = useState(entitlementEnabled);
  const selectedStatus = enabled ? "enabled" : "disabled";

  return (
    <div className="upload-entitlement-field">
      <input
        type="hidden"
        name="uploads_enabled"
        value={featureGateEnabled ? String(enabled) : "false"}
      />
      <label className={`confirmation-row${featureGateEnabled ? "" : " locked-control"}`}>
        <input
          type="checkbox"
          checked={enabled}
          disabled={!featureGateEnabled}
          onChange={(event) => setEnabled(event.currentTarget.checked)}
        />
        Upload entitlement ({selectedStatus})
      </label>
      <p className="quota-authority">
        {featureGateEnabled
          ? "The global upload feature gate is enabled. This account entitlement can be changed after reauthorization."
          : "The global upload feature gate is off. Effective uploads are disabled, and any submitted update records this entitlement as disabled."}
      </p>
    </div>
  );
}
