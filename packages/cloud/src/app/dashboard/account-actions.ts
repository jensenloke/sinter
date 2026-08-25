"use server";

import { revalidatePath } from "next/cache";
import { type AccountDeletionOperation } from "@/lib/account-lifecycle";
import { auth0 } from "@/lib/auth0";
import {
  changeAccountDeletionRequest,
  DashboardDataError,
} from "@/lib/supabase/auth0";

export interface AccountDeletionActionState {
  status: "idle" | "error" | "success";
  message: string;
}

async function changeDeletionRequest(
  operation: AccountDeletionOperation,
  confirmation: string | null,
): Promise<AccountDeletionActionState> {
  const session = await auth0.getSession();
  if (!session?.user || !session.tokenSet.idToken) {
    return {
      status: "error",
      message: "Your session is no longer available. Refresh the page and sign in again.",
    };
  }

  try {
    await changeAccountDeletionRequest(session.tokenSet.idToken, operation, confirmation);
    revalidatePath("/dashboard");
    return {
      status: "success",
      message: operation === "request"
        ? "Your account deletion request is pending."
        : "Your account deletion request was cancelled.",
    };
  } catch (error) {
    console.error("Sinter account lifecycle boundary", {
      operation,
      code: error instanceof DashboardDataError ? error.code : "unexpected",
    });
    return {
      status: "error",
      message: error instanceof DashboardDataError
        ? error.message
        : "Your deletion request could not be changed. Try again after refreshing the page.",
    };
  }
}

export async function requestAccountDeletion(
  _previousState: AccountDeletionActionState,
  formData: FormData,
): Promise<AccountDeletionActionState> {
  const confirmation = formData.get("confirmDeletion");
  return changeDeletionRequest(
    "request",
    typeof confirmation === "string" ? confirmation : null,
  );
}

export async function cancelAccountDeletion(
  _previousState: AccountDeletionActionState,
  _formData: FormData,
): Promise<AccountDeletionActionState> {
  return changeDeletionRequest("cancel", null);
}
