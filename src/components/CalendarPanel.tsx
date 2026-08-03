"use client";

// "This week" calendar panel — placeholder / not-connected state ONLY. No
// Google integration this round: no googleapis, no GOOGLE_* env, no sync route,
// no calendar tables, no week ‹ › navigation. Everyone sees this; nobody has
// data, so "not connected yet" is accurate for everyone. Heading, body copy and
// privacy fine print are verbatim from public/mockups/home-goals-v3.html.

export default function CalendarPanel() {
  return (
    <div
      className="overflow-hidden rounded-[14px] border"
      style={{
        background: "#f2f4f3",
        borderColor: "#e2e9e6",
        boxShadow: "0 1px 2px rgba(7,42,32,.05), 0 12px 30px -20px rgba(7,42,32,.45)",
      }}
    >
      <div
        className="flex items-center gap-[10px] border-b px-[18px] py-[15px]"
        style={{ borderColor: "#e2e9e6" }}
      >
        <h3 className="text-[14.5px] font-bold tracking-[-0.008em] text-[#12241d]">
          This week
        </h3>
      </div>
      <div className="px-[22px] pb-6 pt-[30px] text-center">
        <div
          className="mx-auto mb-3 flex h-[42px] w-[42px] items-center justify-center rounded-[12px] text-[19px]"
          style={{ background: "#e0f2e7", color: "#1a7a52" }}
        >
          ◷
        </div>
        <h4 className="mb-[7px] text-[14px] font-bold text-[#12241d]">
          Calendar not connected yet
        </h4>
        <p className="mx-auto mb-[14px] max-w-[38ch] text-[12.5px] leading-[1.6] text-[#6d7b74]">
          Once a Workspace admin authorizes access, your meetings for the week
          show up here — with topics and action items shared by everyone on the
          invite.
        </p>
        <div
          className="rounded-[10px] border px-[13px] py-[11px] text-left text-[11.5px] leading-[1.6]"
          style={{ background: "#f5f9f6", borderColor: "#e2eee8", color: "#5f7d6f" }}
        >
          Only meetings with{" "}
          <b style={{ color: "#14563c" }}>2 or more people</b> are ever stored.
          Anything you mark <b style={{ color: "#14563c" }}>Private</b> in Google
          Calendar is skipped entirely. Descriptions and locations are never
          saved.
        </div>
      </div>
    </div>
  );
}
