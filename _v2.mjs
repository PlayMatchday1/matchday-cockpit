import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
const url=process.env.NEXT_PUBLIC_SUPABASE_URL, svc=process.env.SUPABASE_SERVICE_ROLE_KEY, anon=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const ref=url.replace("https://","").split(".")[0];
const sb=createClient(url,svc,{auth:{persistSession:false}});
const {data:l}=await sb.auth.admin.generateLink({type:"magiclink",email:"rmancuso@playmatchday.com"});
const cli=createClient(url,anon,{auth:{persistSession:false}});const {data:s}=await cli.auth.verifyOtp({type:"email",token_hash:l.properties.hashed_token});
const b=await chromium.launch();
const ctx=await b.newContext({viewport:{width:1280,height:2200}});
await ctx.addInitScript(([k,v])=>{try{localStorage.setItem(k,v)}catch(e){}},[`sb-${ref}-auth-token`,JSON.stringify(s.session)]);
const pg=await ctx.newPage();
await pg.goto("http://localhost:3111/match-ops/slate-review",{waitUntil:"networkidle"});
await pg.locator('button:has-text("Austin")').first().click();
await pg.waitForSelector("text=MATCH P&L BY FIELD",{timeout:20000}); await pg.waitForTimeout(9000);
// tight range label: the element whose text ends with "completed weeks only"
const rangeOf=()=>pg.evaluate(()=>{const el=[...document.querySelectorAll("div")].find(d=>d.children.length===0&&/completed weeks only/.test(d.textContent||""));return el?el.textContent.trim():"?";});
// contrast within the actual card (the rounded-2xl containing the h2)
const cardContrast=async()=>pg.evaluate(()=>{const h2=[...document.querySelectorAll("h2")].find(e=>/MATCH P&L BY FIELD/.test(e.textContent||""));let card=h2;while(card&&!/rounded-2xl/.test(card.className||""))card=card.parentElement;function ebg(e){while(e){const c=getComputedStyle(e).backgroundColor;if(c&&!/rgba?\(0, 0, 0, 0\)|transparent/.test(c))return c;e=e.parentElement;}return "rgb(255,255,255)";}function lum(rgb){const m=rgb.match(/[\d.]+/g).slice(0,3).map(x=>x/255).map(v=>v<=.03928?v/12.92:Math.pow((v+.055)/1.055,2.4));return .2126*m[0]+.7152*m[1]+.0722*m[2];}let min=99,who="";for(const e of card.querySelectorAll("*")){if(![...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim()))continue;const f=getComputedStyle(e).color,g=ebg(e);const l1=lum(f),l2=lum(g);const r=(Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05);if(r<min){min=r;who=e.textContent.trim().slice(0,24)+" "+f;}}return {min:+min.toFixed(2),who};});
// footing + shares for ALL open-able fields across windows
async function allFields(){
  return pg.evaluate(()=>{
    const out=[];
    const rows=[...document.querySelectorAll("tr")].filter(r=>{const td=r.querySelectorAll("td");return td.length===5 && /\$/.test(td[2]?.textContent||"") && !/—/.test(td[2]?.textContent||"");});
    for(const r of rows){const td=[...r.querySelectorAll("td")].map(x=>x.textContent.replace(/\s+/g," ").trim());out.push({field:td[0].replace(/^\d+/,"").trim(),matches:td[1],rev:td[2],cost:td[3],net:td[4]});}
    return out;
  });
}
for(const [w,name] of [[4,"4 weeks"],[2,"2 weeks"],[1,"1 week"]]){
  await pg.getByRole("button",{name,exact:true}).click(); await pg.waitForTimeout(3500);
  console.log(`\n=== ${name} — range: ${await rangeOf()} ===`);
  const fs=await allFields();
  // open each & check footing/shares
  for(const f of fs){
    await pg.locator(`tr:has-text("${f.field.split(" ")[0]}")`).first().click().catch(()=>{});
    await pg.waitForTimeout(250);
    const d=await pg.evaluate(()=>{const din=[...document.querySelectorAll("div")].find(d=>/Where one match at/.test(d.textContent||""));if(!din)return null;const shares=[...din.querySelectorAll("div")].filter(x=>x.children.length===4&&/DPP|Membership|Promo/.test(x.children[0].textContent||"")).map(x=>parseFloat(x.children[3].textContent));const sum=Math.round(shares.reduce((a,b)=>a+(b||0),0)*10)/10;const foots=/✓ foots/.test(din.textContent);return {sharesSum:sum,foots};});
    console.log(`  ${f.field.padEnd(10)} m=${f.matches} rev=${f.rev} cost=${f.cost} net=${f.net} | sharesSum=${d?.sharesSum} foots=${d?.foots}`);
    await pg.locator(`tr:has-text("${f.field.split(" ")[0]}")`).first().click().catch(()=>{});
    await pg.waitForTimeout(150);
  }
}
console.log("\ncard lowest contrast:",JSON.stringify(await cardContrast()));
await b.close();
