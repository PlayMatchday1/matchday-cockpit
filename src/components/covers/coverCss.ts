// One scoped stylesheet for the cover components, so they look the same in the Field panel, the match panel and
// the local cover page. Tokens are MatchPanel's (.mp) palette, redeclared on .fc so the components stand alone.
export const COVER_CSS = `
.fc{--ink:#0e1a13;--ink2:#3d5349;--ink3:#4a6157;--line:#dde6e1;--line2:#cbd8d1;--card:#fff;--grn:#146c43;--grn2:#e7f4ec;--red:#a4231e;--focus:#0b6bcb;
  font:14px/1.45 ui-sans-serif,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink)}
.fc *{box-sizing:border-box}
.fc-lb{display:flex;align-items:baseline;gap:6px;font-size:9.5px;font-weight:800;letter-spacing:.11em;color:var(--ink3);margin-bottom:5px}
.fc-lb em{margin-left:auto;font-style:normal;font-size:10.5px;font-weight:600;letter-spacing:0;color:var(--ink3)}
.fc-new{display:inline-block;border-radius:5px;padding:1px 6px;font-size:9px;letter-spacing:.08em;background:var(--grn2);color:var(--grn)}
.fc-note{margin:0 0 12px;font-size:12.5px;color:var(--ink2)}
.fc-bad{display:block;color:var(--red);font-size:12px;margin-top:4px}
.fc-f{display:block;margin-bottom:12px}
.fc input[type=text],.fc input:not([type]),.fc input[type=file]{width:100%;border:1px solid var(--line2);border-radius:9px;padding:8px 10px;font:inherit;font-size:13.5px;background:#fbfdfc;color:var(--ink)}
.fc-btn{border:1px solid var(--line2);background:#fff;color:var(--ink);border-radius:999px;padding:7px 14px;font:inherit;font-size:13px;font-weight:700;cursor:pointer;min-height:36px}
.fc-btn.pri{background:#5fd68f;border-color:#5fd68f;color:#0b2e1c}
.fc-btn:disabled{opacity:.5;cursor:not-allowed}
.fc-link{border:0;background:none;padding:0;font:inherit;font-size:13px;font-weight:700;color:var(--grn);cursor:pointer}
.fc-link.red{color:var(--red)}
.fc-link:disabled{color:var(--ink3);cursor:not-allowed}
.fc-verdict{margin:10px 0 0;font-size:12.5px;padding:8px 10px;border-radius:8px;border:1px solid var(--line)}
.fc-verdict.ok{background:var(--grn2);border-color:#bfe3cd;color:#0f4d30}
.fc-verdict.bad{background:#fff4f3;border-color:#f0c3bf;color:var(--red)}
.fc-why{font-size:12px;color:var(--ink3);margin:6px 0 0}

/* field panel */
.fc-sec{padding:4px 0}
.fc-default{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:16px;align-items:start;padding-bottom:16px;border-bottom:1px solid var(--line)}
.fc-default img,.fc-card img{width:100%;aspect-ratio:358/214.5;object-fit:cover;border-radius:12px;display:block;background:#e9efec}
.fc-default h4{margin:0 0 6px;font-size:17px;display:flex;align-items:center;gap:8px}
.fc-pill{font-size:9.5px;font-weight:800;letter-spacing:.08em;border-radius:999px;padding:2px 8px;background:var(--grn2);color:var(--grn)}
.fc-default p{margin:0 0 10px;font-size:12.5px;color:var(--ink2)}
.fc-sub{font-size:10.5px;font-weight:800;letter-spacing:.12em;color:var(--ink3);margin:16px 0 10px}
.fc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}
.fc-card{border:1px solid var(--line);border-radius:14px;padding:10px;background:var(--card)}
.fc-card .fc-name{font-weight:800;margin:8px 0 2px;word-break:break-word}
.fc-card .fc-count{font-size:12px;color:var(--ink3);margin-bottom:8px}
.fc-card .fc-acts{display:flex;gap:14px;flex-wrap:wrap}
.fc-card input{margin:6px 0}
.fc-add{border:1.5px dashed var(--line2);border-radius:14px;min-height:190px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:#fbfdfc;color:var(--ink);font:inherit;font-weight:700;cursor:pointer}
.fc-add:disabled{cursor:not-allowed;opacity:.55}
.fc-add i{font-style:normal;width:34px;height:34px;border-radius:50%;background:#eef4f1;display:flex;align-items:center;justify-content:center;font-size:20px}
.fc-confirm{border:1px solid #f0c3bf;background:#fff8f7;border-radius:10px;padding:10px;margin-top:8px;font-size:12.5px}
.fc-confirm .fc-acts{margin-top:8px}

/* match panel */
.fc-pick{border:1.5px solid var(--grn);border-radius:12px;padding:8px;display:flex;gap:12px;align-items:center;background:#fff}
.fc-pick img,.fc-opt img{width:96px;aspect-ratio:358/214.5;object-fit:cover;border-radius:8px;display:block;background:#e9efec;flex:0 0 auto}
.fc-pick .fc-t{flex:1;min-width:0}
.fc-pick b,.fc-opt b{display:block}
.fc-pick span,.fc-opt span{font-size:12px;color:var(--ink3)}
.fc-opts{border:1px solid var(--line);border-radius:12px;margin-top:6px;overflow:hidden;background:#fff}
.fc-opt{display:flex;gap:12px;align-items:center;padding:8px;border:0;border-bottom:1px solid var(--line);background:#fff;width:100%;text-align:left;font:inherit;color:inherit;cursor:pointer}
.fc-opt.on{background:var(--grn2)}
.fc-opt .fc-tick{margin-left:auto;color:var(--grn);font-weight:800}
.fc-opts-f{padding:8px 10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.fc-opts-f a{margin-left:auto;font-size:12.5px;font-weight:700;color:var(--grn);text-decoration:none}
.fc-apply{border:1px solid var(--line);border-radius:12px;padding:10px;margin-top:10px;background:#fbfdfc}
.fc-apply ul{list-style:none;margin:8px 0;padding:0;max-height:220px;overflow:auto}
.fc-apply li label{display:flex;gap:8px;align-items:center;padding:4px 0;font-size:13px}
/* Inside MatchPanel, ".mp input" makes every input full-width and 40px tall. Checkboxes are not text boxes. */
.fc input[type=checkbox]{width:16px;height:16px;min-height:0;min-width:16px;padding:0;margin:0;flex:0 0 auto}
.fc-apply li em{font-style:normal;color:var(--ink3);font-size:12px}

/* upload dialog */
.fc-modal-bg{position:fixed;inset:0;background:rgba(10,20,15,.45);display:flex;align-items:center;justify-content:center;z-index:2000;padding:16px}
.fc-modal{background:#fff;border-radius:14px;width:min(860px,100%);max-height:92vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.25)}
.fc-modal-h{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--line);font-size:16px}
.fc-x{border:0;background:none;font-size:16px;cursor:pointer;color:var(--ink2)}
.fc-modal-b{padding:16px;overflow:auto}
.fc-modal-f{padding:12px 16px;border-top:1px solid var(--line);display:flex;justify-content:flex-end;gap:8px}
.fc-prev{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.2fr);gap:16px;margin-top:6px}
.fc-full{position:relative;border-radius:10px;overflow:hidden;background:#e9efec}
.fc-full img{width:100%;height:100%;display:block;object-fit:fill}
.fc-safe{position:absolute;border:2px dashed #fff;box-shadow:0 0 0 9999px rgba(0,0,0,.35);display:flex;align-items:flex-start;justify-content:center}
.fc-safe span{margin-top:6px;font-size:11px;font-weight:800;color:#fff;background:rgba(0,0,0,.45);border-radius:6px;padding:2px 6px}
.fc-check{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--ink2);margin-top:6px}
.fc-shapes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-content:start}
.fc-shape{margin:0}
.fc-frame{width:100%;border-radius:10px;background-size:cover;background-position:center;background-color:#e9efec;border:1px solid var(--line)}
.fc-shape figcaption{font-size:12px;margin-top:4px;display:flex;flex-direction:column}
.fc-shape figcaption span{color:var(--ink3)}
@media (max-width:640px){.fc-default,.fc-prev{grid-template-columns:1fr}.fc-shapes{grid-template-columns:1fr}}
`;
