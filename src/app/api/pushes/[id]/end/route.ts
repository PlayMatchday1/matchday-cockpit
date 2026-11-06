// POST /api/pushes/:id/end. See src/lib/pushesMoveRoute.ts.
import { moveRoute } from "@/lib/pushesMoveRoute";

export const dynamic = "force-dynamic";
export const POST = moveRoute("end");
