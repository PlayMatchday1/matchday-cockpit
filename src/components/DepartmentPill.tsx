import {
  DEPARTMENT_LABEL,
  DEPARTMENT_PILL_CLASS,
  deptKey,
  type Department,
} from "@/lib/topics";

type Size = "xs" | "sm";

export default function DepartmentPill({
  department,
  size = "xs",
}: {
  department: Department | null;
  size?: Size;
}) {
  const key = deptKey(department);
  const sizeCls =
    size === "xs"
      ? "px-1.5 py-0.5 text-[9px]"
      : "px-2 py-0.5 text-[10px]";
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full font-bold uppercase tracking-wider ring-1 ring-inset ${DEPARTMENT_PILL_CLASS[key]} ${sizeCls}`}
    >
      {DEPARTMENT_LABEL[key]}
    </span>
  );
}
