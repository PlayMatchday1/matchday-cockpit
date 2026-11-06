// POST /api/pushes/:id/send. See src/lib/pushesMoveRoute.ts.
import { moveRoute } from "@/lib/pushesMoveRoute";

export const dynamic = "force-dynamic";
export const POST = moveRoute("send");
