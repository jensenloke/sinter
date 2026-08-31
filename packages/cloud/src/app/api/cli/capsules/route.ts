import { createCapsulesRoute } from "@/lib/capsule-http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createCapsulesRoute();
export const GET = route.GET;
export const POST = route.POST;
