import { createEnrollmentApprovalRoute } from "@/lib/device-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createEnrollmentApprovalRoute();
export const POST = route.POST;
