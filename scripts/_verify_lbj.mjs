import { sb } from "./_session_runner.mjs";

// First, confirm the mdapi_fields table exists / its columns
const probe = await sb.from("mdapi_fields").select("*").limit(1);
if (probe.error) { console.log("mdapi_fields probe ERROR:", probe.error.message); }
else console.log("mdapi_fields columns:", probe.data[0]?Object.keys(probe.data[0]).join(", "):"(table empty)");

// 1. Search mdapi_fields for LBJ / Early College / Johnson
console.log("\n=== (1) mdapi_fields LBJ/Early College/Johnson ===");
{
  const { data, error } = await sb.from("mdapi_fields")
    .select("id, mdapi_field_id, field_title, field_address, city_identifier")
    .or("field_title.ilike.%LBJ%,field_title.ilike.%Early College%,field_title.ilike.%Johnson%")
    .order("field_title");
  if (error) console.log("ERR:", error.message);
  else { console.log(`${data.length} rows`); data.forEach(r=>console.log("  "+JSON.stringify(r))); }
}

// 2. fin_venues same search
console.log("\n=== (2) fin_venues LBJ/Early College/Johnson ===");
{
  const { data, error } = await sb.from("fin_venues")
    .select("id, city, venue_name")
    .or("venue_name.ilike.%LBJ%,venue_name.ilike.%Early College%,venue_name.ilike.%Johnson%");
  if (error) console.log("ERR:", error.message);
  else { console.log(`${data.length} rows`); data.forEach(r=>console.log("  "+JSON.stringify(r))); }
}

// 3. All Austin mdapi_fields
console.log("\n=== (3) mdapi_fields where city_identifier in ATX/austin/Austin ===");
{
  const { data, error } = await sb.from("mdapi_fields")
    .select("id, mdapi_field_id, field_title, city_identifier")
    .in("city_identifier", ["ATX","austin","Austin"])
    .order("field_title");
  if (error) console.log("ERR:", error.message);
  else { console.log(`${data.length} rows`); data.forEach(r=>console.log("  "+JSON.stringify(r))); }
}
