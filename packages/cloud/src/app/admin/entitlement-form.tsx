"use client";

import { useActionState } from "react";
import {
  ADMIN_REASON_LIMITS,
  ADMIN_UPDATE_CONFIRMATION_PREFIX,
  type AdminEntitlementMetadata,
} from "@/lib/admin-contract";
import { CLOUD_SAFETY_CAPS } from "@/lib/cloud-quota";
import {
  updateEntitlementAction,
  type AdminEntitlementActionState,
} from "./actions";

const INITIAL_STATE: AdminEntitlementActionState = { status: "idle", message: "" };

export function EntitlementForm({ entitlement }: { entitlement: AdminEntitlementMetadata }) {
  const [state, action, pending] = useActionState(updateEntitlementAction, INITIAL_STATE);
  const id = entitlement.account_id;
  const confirmation = `${ADMIN_UPDATE_CONFIRMATION_PREFIX} ${id}`;

  return (
    <form className="admin-entitlement-form" action={action}>
      <input type="hidden" name="target_account_id" value={id} />
      <input type="hidden" name="uploads_enabled" value="false" />
      <div className="admin-form-grid">
        <label htmlFor={`plan-${id}`}>Plan code
          <input id={`plan-${id}`} name="plan_code" defaultValue={entitlement.plan_code} maxLength={64} pattern="[a-z0-9][a-z0-9_-]{0,63}" required />
        </label>
        <label htmlFor={`status-${id}`}>Status
          <select id={`status-${id}`} name="status" defaultValue={entitlement.status} required>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
          </select>
        </label>
        <label htmlFor={`storage-${id}`}>Storage limit (bytes; blank if unmetered)
          <input id={`storage-${id}`} name="storage_limit_bytes" type="number" min="0" step="1" defaultValue={entitlement.storage_limit_bytes ?? ""} />
        </label>
        <label htmlFor={`sessions-${id}`}>Cloud session limit (blank if unmetered)
          <input id={`sessions-${id}`} name="session_limit" type="number" min="0" step="1" defaultValue={entitlement.session_limit ?? ""} />
        </label>
        <label htmlFor={`capsule-${id}`}>Per-capsule cap (bytes)
          <input id={`capsule-${id}`} name="capsule_size_limit_bytes" type="number" min="0" max={CLOUD_SAFETY_CAPS.capsuleSizeBytes} step="1" defaultValue={entitlement.capsule_size_limit_bytes} required />
        </label>
        <label htmlFor={`devices-${id}`}>Device cap
          <input id={`devices-${id}`} name="device_limit" type="number" min="0" max={CLOUD_SAFETY_CAPS.devices} step="1" defaultValue={entitlement.device_limit} required />
        </label>
      </div>
      <div className="admin-control-row">
        <label className="confirmation-row" htmlFor={`unmetered-${id}`}>
          <input id={`unmetered-${id}`} name="unmetered" type="checkbox" value="true" defaultChecked={entitlement.unmetered} />
          Unmetered storage and session counts
        </label>
        <label className="confirmation-row locked-control">
          <input type="checkbox" checked={false} disabled readOnly />
          Uploads enabled (locked off globally)
        </label>
      </div>
      <label htmlFor={`reason-${id}`}>Required audit reason
        <input id={`reason-${id}`} name="reason" minLength={ADMIN_REASON_LIMITS.minimum} maxLength={ADMIN_REASON_LIMITS.maximum} required />
      </label>
      <label htmlFor={`confirmation-${id}`}>Type <code>{confirmation}</code> to confirm
        <input id={`confirmation-${id}`} name="confirmation" autoComplete="off" required />
      </label>
      <div className="admin-submit-row">
        <button className="lifecycle-button secondary-button" type="submit" disabled={pending}>
          {pending ? "Checking authorization…" : "Update entitlement metadata"}
        </button>
        {state.status !== "idle" && (
          <p className={`lifecycle-message ${state.status === "error" ? "message-error" : "message-success"}`} role="status" aria-live="polite">
            {state.message}
          </p>
        )}
      </div>
      <p className="quota-authority">These browser limits mirror service constraints for feedback only. The account-scoped database RPC remains authoritative.</p>
    </form>
  );
}
