"use server";

import { revalidatePath } from "next/cache";
import { AdminPortalError, updateAdminEntitlement } from "@/lib/admin";
import { auth0 } from "@/lib/auth0";

export interface AdminEntitlementActionState {
  status: "idle" | "error" | "success";
  message: string;
}

export async function updateEntitlementAction(
  _previousState: AdminEntitlementActionState,
  formData: FormData,
): Promise<AdminEntitlementActionState> {
  const session = await auth0.getSession();
  if (!session?.user || !session.tokenSet.idToken) {
    return {
      status: "error",
      message: "Your session is no longer available. Refresh the page and sign in again.",
    };
  }

  try {
    await updateAdminEntitlement(session.tokenSet.idToken, formData);
    revalidatePath("/admin");
    revalidatePath("/dashboard");
    return { status: "success", message: "The entitlement metadata was updated." };
  } catch (error) {
    return {
      status: "error",
      message: error instanceof AdminPortalError
        ? error.message
        : "The entitlement could not be updated.",
    };
  }
}
