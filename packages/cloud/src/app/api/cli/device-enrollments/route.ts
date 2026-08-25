import { createEnrollmentsRoute } from "@/lib/device-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createEnrollmentsRoute();
export const GET = route.GET;
