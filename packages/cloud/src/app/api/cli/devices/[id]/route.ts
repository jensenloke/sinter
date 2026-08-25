import { createDevicePatchRoute } from "@/lib/device-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createDevicePatchRoute();
export const PATCH = route.PATCH;
