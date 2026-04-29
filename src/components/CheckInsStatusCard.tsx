"use client";

import type { ManagerStatus } from "@/lib/checkIns";

export default function CheckInsStatusCard({
  status,
}: {
  status: ManagerStatus;
}) {
  const { manager, entry, submitted } = status;

  if (!entry) {
    return (
      <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-5 shadow-md shadow-deep-green/10">
        <div className="flex items-start justify-between gap-3 border-b border-cream-line pb-3">
          <div>
            <div className="text-base font-bold text-deep-green">
              {manager.name}
            </div>
            <div className="mt-0.5 text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
              {manager.city}
            </div>
          </div>
          <span className="inline-flex shrink-0 rounded-full bg-muted-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-muted ring-1 ring-inset ring-cream-line">
            No Response
          </span>
        </div>
        <div className="mt-3 text-sm italic text-deep-green/45">
          Awaiting first monthly check-in.
        </div>
      </div>
    );
  }

  const ratingPct = Math.max(0, Math.min(100, (entry.rating / 5) * 100));
  const tsStr = entry.timestamp
    .toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
    .toUpperCase();

  return (
    <div className="rounded-2xl border-[1.5px] border-cream-line bg-white p-5 shadow-md shadow-deep-green/10">
      <div className="flex items-start justify-between gap-3 border-b border-cream-line pb-3">
        <div>
          <div className="text-base font-bold text-deep-green">
            {manager.name}
          </div>
          <div className="mt-0.5 text-[10px] font-bold uppercase tracking-wider text-deep-green/55">
            {manager.city}
          </div>
        </div>
        {submitted ? (
          <span className="inline-flex shrink-0 rounded-full bg-mint-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-deep-green ring-1 ring-inset ring-mint/40">
            Submitted
          </span>
        ) : (
          <span className="inline-flex shrink-0 rounded-full bg-coral-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-coral ring-1 ring-inset ring-coral/40">
            Overdue
          </span>
        )}
      </div>

      {entry.rating > 0 && (
        <div className="mt-4">
          <div className="text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
            Overall rating
          </div>
          <div className="mt-1.5 flex items-baseline gap-3">
            <div className="text-3xl font-extrabold tabular-nums text-deep-green">
              {entry.rating.toFixed(1)}
            </div>
            <div
              className="h-1.5 flex-1 overflow-hidden rounded-full bg-cream-soft ring-1 ring-inset ring-cream-line"
              role="img"
              aria-label={`Rating ${entry.rating.toFixed(1)} of 5`}
            >
              <div
                className="h-full rounded-full"
                style={{
                  width: `${ratingPct}%`,
                  background: "linear-gradient(90deg, #FF6955, #2CDB87)",
                }}
              />
            </div>
            <div className="text-[10px] font-bold tabular-nums uppercase tracking-wider text-deep-green/45">
              / 5
            </div>
          </div>
        </div>
      )}

      {entry.win && (
        <Section label="Biggest win">
          <Quote>{entry.win}</Quote>
        </Section>
      )}
      {entry.challenge && (
        <Section label="Biggest challenge">
          <Quote>{entry.challenge}</Quote>
        </Section>
      )}
      {entry.focus && (
        <Section label="Next month focus">
          <Body>{entry.focus}</Body>
        </Section>
      )}
      {(entry.fieldsContacted || entry.fieldsList) && (
        <Section
          label={
            entry.fieldsContacted
              ? `New fields contacted (${entry.fieldsContacted})`
              : "New fields contacted"
          }
        >
          {entry.fieldsList && <Body>{entry.fieldsList}</Body>}
        </Section>
      )}
      {entry.fieldProgress && (
        <Section label="Field progress">
          <Body>{entry.fieldProgress}</Body>
        </Section>
      )}
      {entry.matchManager && (
        <Section label="Match manager team">
          <Body>{entry.matchManager}</Body>
        </Section>
      )}
      {entry.marketingChannels && (
        <Section label="Marketing channels">
          <div className="mt-1 font-mono text-[11px] uppercase tracking-wider text-deep-green/65">
            {entry.marketingChannels}
          </div>
        </Section>
      )}
      {entry.marketingResults && (
        <Section label="Marketing results">
          <Body>{entry.marketingResults}</Body>
        </Section>
      )}

      <div className="mt-5 border-t border-cream-line/60 pt-3 text-[10px] font-bold uppercase tracking-wider text-deep-green/45">
        Submitted {tsStr}
      </div>
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-4">
      <div className="text-[10px] font-bold uppercase tracking-wider text-deep-green/60">
        {label}
      </div>
      {children}
    </div>
  );
}

function Body({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-1 text-sm leading-relaxed text-deep-green/85">
      {children}
    </div>
  );
}

function Quote({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-1 border-l-2 border-cream-line pl-3 text-sm italic leading-relaxed text-deep-green/75">
      {children}
    </div>
  );
}
