"use client";

import { useActionState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { ACCOUNT_DELETION_CONFIRMATION } from "@/lib/account-lifecycle";
import {
  cancelAccountDeletion,
  requestAccountDeletion,
  type AccountDeletionActionState,
} from "./account-actions";

const initialActionState: AccountDeletionActionState = {
  status: "idle",
  message: "",
};

function SubmitButton({
  children,
  className,
  pendingLabel,
}: {
  children: ReactNode;
  className: string;
  pendingLabel: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button className={className} disabled={pending} type="submit">
      {pending ? pendingLabel : children}
    </button>
  );
}

function ActionMessage({ state }: { state: AccountDeletionActionState }) {
  if (state.status === "idle") return null;
  return (
    <p
      aria-live={state.status === "error" ? "assertive" : "polite"}
      className={`lifecycle-message ${state.status === "error" ? "message-error" : "message-success"}`}
      role={state.status === "error" ? "alert" : "status"}
    >
      {state.message}
    </p>
  );
}

export function AccountLifecycle({
  deletionRequestedAt,
  deletionRequestedAtLabel,
}: {
  deletionRequestedAt: string | null;
  deletionRequestedAtLabel: string | null;
}) {
  const pending = deletionRequestedAt !== null;
  const [requestState, requestAction] = useActionState(requestAccountDeletion, initialActionState);
  const [cancelState, cancelAction] = useActionState(cancelAccountDeletion, initialActionState);

  return (
    <section className={`portal-section lifecycle-section ${pending ? "lifecycle-pending" : ""}`} id="account-lifecycle">
      <div className="section-heading">
        <div>
          <p className="section-kicker">ACCOUNT LIFECYCLE</p>
          <h2>{pending ? "Deletion request pending" : "Request account deletion"}</h2>
        </div>
        <span className={`state-pill ${pending ? "state-warning" : "state-muted"}`}>
          {pending ? "Pending" : "No request"}
        </span>
      </div>

      {pending ? (
        <div className="lifecycle-body">
          <p className="lifecycle-summary">
            This is a request for account deletion, not an immediate deletion. Your account and data have not been deleted by this action.
          </p>
          <dl className="lifecycle-details">
            <div>
              <dt>Requested at</dt>
              <dd>
                <time dateTime={deletionRequestedAt}>{deletionRequestedAtLabel}</time>
              </dd>
            </div>
            <div><dt>Current status</dt><dd>Awaiting deletion review</dd></div>
          </dl>
          <form action={cancelAction} className="lifecycle-form compact-form">
            <p>Cancelling clears this pending request and leaves the account unchanged.</p>
            <SubmitButton className="lifecycle-button secondary-button" pendingLabel="Cancelling request…">
              Cancel deletion request
            </SubmitButton>
            <ActionMessage state={cancelState} />
          </form>
        </div>
      ) : (
        <div className="lifecycle-body">
          <p className="lifecycle-summary" id="deletion-request-explanation">
            This sends a deletion request for review. It does not immediately delete your account, identity, devices, or any other data.
          </p>
          <form action={requestAction} className="lifecycle-form">
            <label className="confirmation-row">
              <input
                aria-describedby="deletion-request-explanation"
                name="confirmDeletion"
                required
                type="checkbox"
                value={ACCOUNT_DELETION_CONFIRMATION}
              />
              <span>I understand this creates a pending request and is not immediate deletion.</span>
            </label>
            <SubmitButton className="lifecycle-button danger-button" pendingLabel="Requesting deletion…">
              Request account deletion
            </SubmitButton>
            <ActionMessage state={requestState} />
          </form>
        </div>
      )}
    </section>
  );
}
