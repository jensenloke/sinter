import { createCapsuleRoute } from "@/lib/capsule-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createCapsuleRoute();
export const GET = route.GET;
export const DELETE = route.DELETE;
