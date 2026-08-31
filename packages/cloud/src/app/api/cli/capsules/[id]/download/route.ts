import { createCapsuleDownloadRoute } from "@/lib/capsule-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createCapsuleDownloadRoute();
export const POST = route.POST;
