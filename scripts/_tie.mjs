/* SEPTEMBER TIE-OUT. fin_txn (Central month) vs tmp/stripe-sep-2026-itemized.csv, to the cent. */
import { readFileSync } from "node:fs";
process.loadEnvFile(".env.local");
const { createClient } = await import("@supabase/supabase-js");
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth:{persistSession:false} });

// ── THE EXPORT ────────────────────────────────────────────────────────────────────────────────
function parse(s){const R=[];let w=[],c="",q=false;for(let i=0;i<s.length;i++){const ch=s[i];
if(q){if(ch==='"'){if(s[i+1]==='"'){c+='"';i++;}else q=false;}else c+=ch;}
else if(ch==='"')q=true;else if(ch===","){w.push(c);c="";}else if(ch==="\r"){}
else if(ch==="\n"){w.push(c);R.push(w);w=[];c="";}else c+=ch;}
if(c!==""||w.length){w.push(c);R.push(w);}return R;}
const all=parse(readFileSync("tmp/stripe-sep-2026-itemized.csv","utf8"));
const ix=Object.fromEntries(all[0].map((h,i)=>[h,i]));
const D=all.slice(1).filter(r=>r.length>5);
const num=v=>{const n=Number(String(v??"").trim());return Number.isFinite(n)?n:0;};
const C=(r,k)=>r[ix[k]];
const CAT={charge:"charge",refund:"refund",charge_failure:"failed",dispute:"dispute",fee:"fee"};
const csv=new Map();
for (const r of D) {
  const k = CAT[C(r,"reporting_category")] ?? "fee";
  const e = csv.get(k) ?? { n:0, gross:0, fee:0 };
  e.n++; e.gross += Math.round(num(C(r,"gross"))*100); e.fee += Math.round(num(C(r,"fee"))*100);
  csv.set(k,e);
}

// ── fin_txn, CENTRAL MONTH. The Central day is derived here exactly as the model derives it. ──
const rows=[]; for(let f=0;;f+=1000){
  const {data,error}=await sb.from("fin_txn")
    .select("kind,gross_cents,fee_cents,created_at_utc,source,field_id,city")
    .gte("created_at_utc","2026-08-25").lt("created_at_utc","2026-10-08").order("id").range(f,f+999);
  if(error){console.log("read failed:",error.message);process.exit(1);}
  rows.push(...data); if(data.length<1000)break;
}
const cd = iso => new Intl.DateTimeFormat("en-CA",{timeZone:"America/Chicago"}).format(new Date(iso));
const SEP = rows.filter(r => cd(r.created_at_utc).startsWith("2026-09"));
const db = new Map();
// STRIPE ONLY in the per-kind lines: they are compared with Stripe's export, which has no Venmo.
for (const r of SEP.filter(r => r.source === "Stripe")) { const e = db.get(r.kind) ?? { n:0, gross:0, fee:0 }; e.n++; e.gross += r.gross_cents; e.fee += r.fee_cents; db.set(r.kind,e); }

const $ = c => (c/100).toFixed(2);
const pad = s => String(s).padStart(12);
console.log("kind       │ export rows   export gross │  fin_txn rows  fin_txn gross │ verdict");
console.log("───────────┼────────────────────────────┼──────────────────────────────┼────────");
let allTie = true;
for (const k of ["charge","refund","failed","dispute","fee"]) {
  const a = csv.get(k) ?? {n:0,gross:0,fee:0}, b = db.get(k) ?? {n:0,gross:0,fee:0};
  const tie = a.n===b.n && a.gross===b.gross;
  if (!tie) allTie = false;
  console.log(`${k.padEnd(10)} │ ${pad(a.n)} ${pad($(a.gross))} │ ${pad(b.n)} ${pad($(b.gross))} │ ${tie?"TIES":"** "+$(b.gross-a.gross)+" **"}`);
}
const cFee = csv.get("charge").fee + (csv.get("dispute")?.fee ?? 0) + (csv.get("failed")?.fee ?? 0);
const dFee = (db.get("charge")?.fee ?? 0) + (db.get("dispute")?.fee ?? 0) + (db.get("failed")?.fee ?? 0);
console.log(`\nfees on those rows  export ${$(cFee)}  ·  fin_txn ${$(dFee)}  ${cFee===dFee?"TIES":"** "+$(dFee-cFee)+" **"}`);
const feeRows = csv.get("fee").gross;
console.log(`all Stripe fees     export ${$(-(cFee - feeRows))}  (fee-on-txn ${$(cFee)} + fee rows ${$(feeRows)})`);
console.log(`\nRYAN'S STATED FIGURES`);
const chk=(l,got,want)=>{const ok=got===want;if(!ok)allTie=false;console.log(`  ${ok?"✓":"✗"} ${l.padEnd(32)} ${$(got).padStart(12)}   stated ${$(want)}`);};
const chkN=(l,got,want)=>{const ok=got===want;if(!ok)allTie=false;console.log(`  ${ok?"✓":"✗"} ${l.padEnd(32)} ${String(got).padStart(12)}   stated ${want}`);};
chkN("charges — rows", db.get("charge")?.n ?? 0, 5451);
chk ("charges — gross", db.get("charge")?.gross ?? 0, 8808466);
chkN("refunds — rows", db.get("refund")?.n ?? 0, 4);
chk ("refunds — gross", db.get("refund")?.gross ?? 0, -22896);
chkN("failed — rows", db.get("failed")?.n ?? 0, 1);
chk ("failed — gross", db.get("failed")?.gross ?? 0, -1299);
chkN("disputes — rows", db.get("dispute")?.n ?? 0, 13);
chk ("disputes — gross", db.get("dispute")?.gross ?? 0, -81210);
// ALL STRIPE FEES, AS A COST: the fee on every charge, dispute and failure (stored positive, so
// negated) plus Stripe's own fee rows (stored negative). -$4,275.92 + -$576.21 = -$4,852.13.
chk ("all Stripe fees", -dFee + (db.get("fee")?.gross ?? 0), -485213);
const VEN = SEP.filter(r => r.source === "Venmo");
chkN("Venmo — rows", VEN.length, 2);
chk ("Venmo — gross", VEN.reduce((t, r) => t + r.gross_cents, 0), 20000);
console.log(`\n  fin_txn September rows total: ${SEP.length}`);
console.log(`  rows carrying a field_id:     ${SEP.filter(r=>r.field_id!=null).length}`);
console.log(`\n${allTie ? "SEPTEMBER TIES TO THE CENT" : "** DOES NOT TIE — see the marked lines **"}`);
