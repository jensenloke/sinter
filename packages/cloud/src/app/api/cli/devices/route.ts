import { createDevicesRoute } from "@/lib/device-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createDevicesRoute();
export const GET = route.GET;
export const POST = route.POST;
