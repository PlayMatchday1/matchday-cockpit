import { sb } from "./_session_runner.mjs";
const HALT=(m)=>{console.log("\n*** HALT ***\n"+m);process.exit(1);};

// pre-checks
const hcmsExist = await sb.from("fin_venues").select("id").ilike("venue_name","%hill country%");
if (hcmsExist.data.length) HALT("HCMS already in fin_venues: "+JSON.stringify(hcmsExist.data));
const map1453 = await sb.from("fin_venue_fields").select("*").eq("mdapi_field_id",1453);
if (map1453.data.length) HALT("field 1453 already mapped: "+JSON.stringify(map1453.data));
const map1 = await sb.from("fin_venue_fields").select("*").eq("mdapi_field_id",1);
if (map1.data.length) HALT("field 1 already mapped (Westlake): "+JSON.stringify(map1.data));
// confirm #49 exists and is unchanged baseline
const v49pre = await sb.from("fin_venues").select("id, venue_name, per_match_rate, cost_per_match, max_spots").eq("id",49);
if (!v49pre.data.length) HALT("fin_venues #49 not found");
console.log("#49 baseline (must stay unchanged):", JSON.stringify(v49pre.data[0]));

// (a) HCMS registration
const w1 = await sb.from("fin_venues").insert({
  city:"Austin", venue_name:"Hill Country Middle School", billing_type:"per_match",
  per_match_rate:135, cost_per_match:135, max_spots:18, is_active:true, charge_on_cancel:true,
}).select("id, city, venue_name, billing_type, per_match_rate, cost_per_match, max_spots, is_active, charge_on_cancel");
if (w1.error) HALT("(a Write1) HCMS fin_venues insert failed: "+w1.error.message);
if (w1.data.length!==1) HALT("(a Write1) expected 1 row");
const hcmsId = w1.data[0].id;
console.log("\n(a) HCMS fin_venues OK:", JSON.stringify(w1.data[0]));

const w2 = await sb.from("fin_venue_fields").insert({
  fin_venue_id:hcmsId, mdapi_field_id:1453, field_title_at_link:"Hill Country Middle School",
}).select("*");
if (w2.error) HALT(`(a Write2) HCMS fin_venue_fields failed: ${w2.error.message}. NOTE fin_venues ${hcmsId} written.`);
console.log("(a) HCMS fin_venue_fields OK:", JSON.stringify(w2.data[0]));

// (b) Westlake field mapping -> existing #49
const w3 = await sb.from("fin_venue_fields").insert({
  fin_venue_id:49, mdapi_field_id:1, field_title_at_link:"Westlake HS Field 3",
}).select("*");
if (w3.error) HALT("(b) Westlake mapping insert failed: "+w3.error.message);
console.log("\n(b) Westlake fin_venue_fields OK:", JSON.stringify(w3.data[0]));

// verify #49 untouched
const v49post = await sb.from("fin_venues").select("id, venue_name, per_match_rate, cost_per_match, max_spots").eq("id",49);
const same = JSON.stringify(v49post.data[0])===JSON.stringify(v49pre.data[0]);
if (!same) HALT("#49 changed! before="+JSON.stringify(v49pre.data[0])+" after="+JSON.stringify(v49post.data[0]));
console.log("\n#49 unchanged:", same);

// verification join
const ver = await sb.from("fin_venues")
  .select("id, city, venue_name, billing_type, per_match_rate, cost_per_match, max_spots, is_active, charge_on_cancel, fin_venue_fields(mdapi_field_id, field_title_at_link)")
  .in("id",[hcmsId,49]).order("id");
console.log("\n=== REGISTRATION VERIFICATION ===\n"+JSON.stringify(ver.data,null,2));
console.log("\nHCMS venue id =",hcmsId,"| Westlake venue id = 49 (field 1 now mapped)");
