import { createCapsuleFinalizeRoute } from "@/lib/capsule-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createCapsuleFinalizeRoute();
export const POST = route.POST;
