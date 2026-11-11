// Staff Credits moved into Finance › Credits on 2026-11-10 (the Staff tab). Old links land there.
import { redirect } from "next/navigation";

export default function Page() {
  redirect("/admin/finance/credits?tab=staff");
}
