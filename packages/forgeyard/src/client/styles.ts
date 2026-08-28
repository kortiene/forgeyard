/** Rendered declaratively inside DSH-owned slot trees; no global DOM mutation. */
export const FORGEYARD_CSS = String.raw`
:root {
  --fy-ink: #17211d;
  --fy-muted: #63706a;
  --fy-line: rgba(26, 50, 40, .14);
  --fy-paper: #f5f4ee;
  --fy-panel: #fffef9;
  --fy-green: #156b4b;
  --fy-green-strong: #0b5037;
  --fy-green-soft: #dcece3;
  --fy-amber: #b87815;
  --fy-red: #a43f35;
  --fy-shadow: 0 24px 80px rgba(8, 22, 16, .22);
}

.fy-sidebar-action {
  width: 100%; min-height: 34px; display: flex; align-items: center; gap: 10px;
  border: 0; border-radius: 8px; padding: 6px 8px; color: inherit;
  background: transparent; cursor: pointer; font: inherit; text-align: left;
}
.fy-sidebar-action:hover, .fy-sidebar-action[aria-pressed="true"] { background: color-mix(in srgb, currentColor 8%, transparent); }
.fy-sidebar-mark, .fy-brand-mark {
  display: inline-grid; place-items: center; flex: 0 0 auto; border-radius: 7px;
  background: var(--fy-green); color: #fff; font: 700 9px/1 ui-monospace, monospace;
  letter-spacing: -.04em;
}
.fy-sidebar-mark { width: 20px; height: 20px; }
.fy-sidebar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.fy-return-action {
  display: inline-flex; align-items: center; gap: 5px; min-height: 28px;
  border: 1px solid var(--fy-line); border-radius: 7px; padding: 4px 9px;
  background: color-mix(in srgb, var(--fy-green-soft) 60%, transparent);
  color: var(--fy-green-strong); cursor: pointer; font: 600 12px/1.2 inherit;
}
.fy-return-action:hover { border-color: color-mix(in srgb, var(--fy-green) 50%, transparent); }

.fy-overlay { position: absolute; inset: 0; z-index: 1; display: grid; padding: 14px; color: var(--fy-ink); pointer-events: auto; }
.fy-backdrop { position: absolute; inset: 0; border: 0; background: rgba(10, 20, 16, .34); backdrop-filter: blur(5px); cursor: default; }
.fy-cockpit {
  position: relative; width: min(1320px, 100%); height: 100%; min-height: 0; margin: auto;
  display: grid; grid-template-rows: auto auto auto minmax(0, 1fr); overflow: hidden;
  border: 1px solid rgba(255, 255, 255, .45); border-radius: 18px;
  background: var(--fy-paper); box-shadow: var(--fy-shadow);
}
.fy-header {
  display: grid; grid-template-columns: minmax(220px, 1fr) auto minmax(220px, 1fr);
  align-items: center; gap: 18px; min-height: 66px; padding: 10px 14px 10px 18px;
  border-bottom: 1px solid var(--fy-line); background: rgba(255, 254, 249, .9);
}
.fy-brand { display: flex; align-items: center; gap: 11px; }
.fy-brand-mark { width: 34px; height: 34px; font-size: 12px; }
.fy-brand > span:last-child { display: grid; gap: 2px; }
.fy-brand strong { font-size: 15px; letter-spacing: -.015em; }
.fy-brand small, .fy-header-view small { color: var(--fy-muted); font-size: 10px; }
.fy-header-view { display: grid; justify-items: center; gap: 2px; font-size: 13px; font-weight: 650; }
.fy-header-actions { display: flex; justify-content: flex-end; gap: 7px; }
.fy-icon-button {
  width: 34px; height: 34px; border: 1px solid var(--fy-line); border-radius: 9px;
  background: var(--fy-panel); color: var(--fy-ink); cursor: pointer; font-size: 19px;
}
.fy-icon-button:hover { border-color: var(--fy-green); color: var(--fy-green); }
.fy-icon-button:disabled { opacity: .45; cursor: default; }
.fy-alert, .fy-progress { display: flex; align-items: center; gap: 10px; padding: 8px 18px; font-size: 12px; }
.fy-alert { justify-content: space-between; color: #762a22; background: #f7dfdc; border-bottom: 1px solid rgba(164, 63, 53, .2); }
.fy-alert button { border: 0; background: none; color: inherit; cursor: pointer; font-weight: 700; }
.fy-progress { color: var(--fy-green-strong); background: var(--fy-green-soft); border-bottom: 1px solid rgba(21, 107, 75, .15); }
.fy-spinner { width: 11px; height: 11px; border: 2px solid rgba(21, 107, 75, .25); border-top-color: var(--fy-green); border-radius: 50%; animation: fy-spin .8s linear infinite; }
@keyframes fy-spin { to { transform: rotate(360deg); } }
.fy-content { min-height: 0; overflow: auto; scrollbar-gutter: stable; }
.fy-view { width: min(1160px, calc(100% - 40px)); margin: 0 auto; padding: 34px 0 48px; }
.fy-view-heading, .fy-detail-hero, .fy-section-title { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
.fy-view-heading { margin-bottom: 24px; }
.fy-view h1, .fy-view h2, .fy-view p { margin: 0; }
.fy-view h1 { margin-top: 3px; font-size: clamp(26px, 3vw, 40px); line-height: 1.08; letter-spacing: -.045em; }
.fy-view h2 { font-size: 20px; letter-spacing: -.025em; }
.fy-view-heading p:last-child, .fy-detail-hero p:last-child { max-width: 720px; margin-top: 9px; color: var(--fy-muted); line-height: 1.55; }
.fy-eyebrow { color: var(--fy-green); font-size: 10px; font-weight: 800; letter-spacing: .13em; text-transform: uppercase; }
.fy-count { display: inline-flex; align-items: center; min-height: 28px; padding: 0 10px; border: 1px solid var(--fy-line); border-radius: 999px; color: var(--fy-muted); font-size: 11px; white-space: nowrap; }

.fy-mission-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(270px, 340px); gap: 20px; align-items: start; }
.fy-card-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.fy-mission-card {
  min-height: 190px; display: flex; flex-direction: column; align-items: stretch; gap: 13px;
  padding: 18px; border: 1px solid var(--fy-line); border-radius: 14px; background: var(--fy-panel);
  color: inherit; cursor: pointer; text-align: left; box-shadow: 0 1px 0 rgba(255,255,255,.7) inset;
}
.fy-mission-card:hover { transform: translateY(-1px); border-color: rgba(21, 107, 75, .45); box-shadow: 0 8px 24px rgba(18, 52, 37, .08); }
.fy-card-topline, .fy-card-meta { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: var(--fy-muted); font-size: 10px; }
.fy-mission-card > strong { font-size: 18px; line-height: 1.2; letter-spacing: -.025em; }
.fy-card-objective { min-height: 42px; color: var(--fy-muted); font-size: 12px; line-height: 1.45; }
.fy-card-meta { margin-top: auto; }
.fy-card-meta code { max-width: 70%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fy-create-panel { border: 1px solid var(--fy-line); border-radius: 14px; overflow: hidden; background: rgba(255, 254, 249, .64); }
.fy-create-toggle { width: 100%; display: flex; align-items: center; gap: 12px; padding: 15px; border: 0; color: inherit; background: transparent; text-align: left; cursor: pointer; }
.fy-create-toggle > span:last-child { display: grid; gap: 3px; }
.fy-create-toggle small { color: var(--fy-muted); line-height: 1.35; }
.fy-plus { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 50%; background: var(--fy-green-soft); color: var(--fy-green); font-size: 20px; }
.fy-form { display: grid; gap: 12px; padding: 0 15px 15px; }
.fy-form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.fy-field { display: grid; gap: 5px; min-width: 0; color: var(--fy-muted); font-size: 10px; font-weight: 700; letter-spacing: .04em; }
.fy-field input, .fy-field textarea {
  width: 100%; box-sizing: border-box; border: 1px solid var(--fy-line); border-radius: 8px;
  padding: 8px 9px; resize: vertical; background: var(--fy-panel); color: var(--fy-ink); font: 12px/1.4 inherit;
}
.fy-field input:focus, .fy-field textarea:focus { outline: 2px solid rgba(21, 107, 75, .18); border-color: var(--fy-green); }

.fy-primary, .fy-secondary, .fy-danger, .fy-verify {
  min-height: 34px; border-radius: 8px; padding: 7px 12px; font: 700 11px/1 inherit; cursor: pointer;
}
.fy-primary { border: 1px solid var(--fy-green); background: var(--fy-green); color: #fff; }
.fy-primary:hover { background: var(--fy-green-strong); }
.fy-secondary, .fy-verify { border: 1px solid var(--fy-line); background: var(--fy-panel); color: var(--fy-ink); }
.fy-danger { border: 1px solid rgba(164, 63, 53, .35); background: #fff7f5; color: var(--fy-red); }
.fy-primary:disabled, .fy-secondary:disabled, .fy-danger:disabled, .fy-verify:disabled { opacity: .45; cursor: default; }
.fy-breadcrumb { display: inline-flex; align-items: center; gap: 7px; margin-bottom: 18px; border: 0; padding: 0; background: none; color: var(--fy-green); cursor: pointer; font: 700 11px/1.2 inherit; }
.fy-detail-hero { align-items: flex-end; padding-bottom: 26px; border-bottom: 1px solid var(--fy-line); }
.fy-hero-actions { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; }
.fy-facts, .fy-summary-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; overflow: hidden; margin: 18px 0; border: 1px solid var(--fy-line); border-radius: 12px; background: var(--fy-line); }
.fy-fact { min-width: 0; display: grid; gap: 5px; padding: 13px; background: var(--fy-panel); }
.fy-fact > span { color: var(--fy-muted); font-size: 9px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.fy-fact strong, .fy-fact code { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.fy-section { margin-top: 18px; padding: 18px; border: 1px solid var(--fy-line); border-radius: 14px; background: rgba(255, 254, 249, .7); }
.fy-section-title { align-items: center; margin-bottom: 15px; }
.fy-node-list { display: grid; gap: 12px; }
.fy-node-card { display: grid; gap: 13px; padding: 16px; border: 1px solid var(--fy-line); border-radius: 12px; background: var(--fy-panel); }
.fy-node-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.fy-node-header h3 { margin-top: 5px; font-size: 15px; }
.fy-node-header > div:first-child > p:last-child { max-width: 680px; margin-top: 6px; color: var(--fy-muted); font-size: 11px; line-height: 1.5; }
.fy-node-statuses { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.fy-node-statuses > span { display: inline-flex; align-items: center; gap: 6px; color: var(--fy-muted); font-size: 9px; font-weight: 700; text-transform: uppercase; }
.fy-node-meta { display: flex; flex-wrap: wrap; gap: 12px; color: var(--fy-muted); font-size: 10px; }
.fy-node-reason { padding: 9px 11px; border-left: 3px solid var(--fy-amber); background: #fff9ec; color: #72521b; font-size: 10px; line-height: 1.5; }
.fy-node-warning { display: grid; gap: 3px; padding: 10px 11px; border-left: 3px solid var(--fy-red); background: #fff5f4; color: #6d3b34; font-size: 10px; line-height: 1.5; }
.fy-node-warning strong { font-size: 10px; }
.fy-node-actions { display: flex; justify-content: flex-end; }
.fy-table, .fy-check-list, .fy-evidence-list { display: grid; gap: 7px; }
.fy-attempt-row {
  display: grid; grid-template-columns: 42px minmax(120px, 1fr) auto auto 20px; align-items: center; gap: 12px;
  width: 100%; padding: 11px; border: 1px solid var(--fy-line); border-radius: 10px;
  background: var(--fy-panel); color: inherit; cursor: pointer; text-align: left;
}
.fy-attempt-row:hover { border-color: rgba(21, 107, 75, .4); }
.fy-attempt-number { color: var(--fy-green); font: 800 11px/1 ui-monospace, monospace; }
.fy-attempt-row > span:nth-child(2) { display: grid; gap: 2px; }
.fy-attempt-row small, .fy-verification-ratio { color: var(--fy-muted); font-size: 10px; }
.fy-status, .fy-check-status { display: inline-flex; align-items: center; justify-content: center; width: fit-content; border-radius: 999px; font-size: 9px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; }
.fy-status { min-height: 23px; padding: 0 8px; background: #e8e9e5; color: #58605b; }
.fy-status[data-state="good"] { background: var(--fy-green-soft); color: var(--fy-green-strong); }
.fy-status[data-state="bad"] { background: #f5dedb; color: var(--fy-red); }
.fy-status[data-state="active"] { background: #f4e8cf; color: #87580e; }

.fy-review-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(260px, 330px); gap: 18px; align-items: start; }
.fy-review-main { min-width: 0; }
.fy-decision-panel { position: sticky; top: 18px; display: grid; gap: 13px; margin-top: 18px; padding: 18px; border: 1px solid var(--fy-line); border-radius: 14px; background: var(--fy-panel); }
.fy-decision-panel > p { color: var(--fy-muted); font-size: 11px; line-height: 1.5; }
.fy-decision-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
.fy-verify { width: 100%; }
.fy-review-identifiers, .fy-command-evidence { display: grid; gap: 7px; margin: 0; }
.fy-review-identifiers > div, .fy-command-evidence > div { display: grid; grid-template-columns: 70px minmax(0, 1fr); gap: 8px; font-size: 10px; }
.fy-review-identifiers dt, .fy-command-evidence dt { color: var(--fy-muted); }
.fy-review-identifiers dd, .fy-command-evidence dd { min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; }
.fy-review-summary .fy-summary-stats { grid-template-columns: repeat(4, minmax(0, 1fr)); margin-bottom: 0; }
.fy-meter { height: 7px; overflow: hidden; border-radius: 999px; background: #e4e5df; }
.fy-meter > span { display: block; height: 100%; border-radius: inherit; background: var(--fy-green); transition: width .2s ease; }
.fy-check { display: grid; grid-template-columns: 58px minmax(0, 1fr); gap: 12px; padding: 12px; border: 1px solid var(--fy-line); border-radius: 10px; background: var(--fy-panel); }
.fy-check > div { display: grid; gap: 4px; min-width: 0; }
.fy-check code, .fy-check p { color: var(--fy-muted); font-size: 10px; }
.fy-check-status { min-height: 22px; padding: 0 7px; background: #ecece8; color: #59605c; }
.fy-check-status[data-status="PASS"] { background: var(--fy-green-soft); color: var(--fy-green-strong); }
.fy-check-status[data-status="FAIL"], .fy-check-status[data-status="ERROR"] { background: #f5dedb; color: var(--fy-red); }
.fy-check-status[data-status="INCOMPLETE"] { background: #f4e8cf; color: #87580e; }
.fy-evidence { overflow: hidden; border: 1px solid var(--fy-line); border-radius: 10px; background: var(--fy-panel); }
.fy-evidence summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px; cursor: pointer; font-size: 10px; }
.fy-evidence summary > span:first-child { display: grid; gap: 3px; }
.fy-evidence summary small, .fy-evidence summary > span:last-child { color: var(--fy-muted); }
.fy-evidence-body, .fy-command-evidence { padding: 0 12px 12px; }
.fy-evidence-body ul { display: grid; gap: 5px; margin: 0 0 10px; padding: 0; list-style: none; }
.fy-evidence-body li { display: flex; gap: 8px; font-size: 10px; }
.fy-evidence-body pre { max-height: 360px; overflow: auto; margin: 0; padding: 12px; border-radius: 8px; background: #17211d; color: #dfeae3; font: 10px/1.5 ui-monospace, monospace; white-space: pre-wrap; }
.fy-promotion[data-promotion-status="eligible"] { border-color: color-mix(in srgb, var(--fy-green) 45%, transparent); }
.fy-promotion-reason { padding: 0 12px; color: var(--fy-muted); font-size: 11px; }
.fy-promotion .fy-command-evidence code { overflow-wrap: anywhere; }
.fy-promotion-confirm { display: grid; gap: 10px; padding: 0 12px 12px; }
.fy-promotion-confirm p { color: var(--fy-muted); font-size: 11px; }
.fy-promotion-confirm code { overflow-wrap: anywhere; }
.fy-promote { margin: 0 12px 12px; }
.fy-empty { min-height: 140px; display: grid; place-items: center; align-content: center; gap: 7px; padding: 20px; color: var(--fy-muted); text-align: center; }
.fy-empty > span { color: var(--fy-green); font-size: 22px; }
.fy-empty strong { color: var(--fy-ink); font-size: 13px; }
.fy-empty p { font-size: 11px; }

@media (max-width: 900px) {
  .fy-overlay { padding: 0; }
  .fy-cockpit { border-radius: 0; border: 0; }
  .fy-header { grid-template-columns: 1fr auto; }
  .fy-header-view { display: none; }
  .fy-mission-layout, .fy-review-grid { grid-template-columns: 1fr; }
  .fy-create-panel { order: -1; }
  .fy-decision-panel { position: static; }
}
@media (max-width: 620px) {
  .fy-view { width: min(100% - 24px, 1160px); padding-top: 22px; }
  .fy-brand small { display: none; }
  .fy-card-grid, .fy-facts, .fy-summary-stats, .fy-review-summary .fy-summary-stats { grid-template-columns: 1fr; }
  .fy-detail-hero, .fy-node-header { align-items: flex-start; flex-direction: column; }
  .fy-node-statuses { justify-content: flex-start; }
  .fy-node-actions .fy-primary { width: 100%; }
  .fy-attempt-row { grid-template-columns: 34px minmax(100px, 1fr) auto; }
  .fy-attempt-row > :nth-child(4), .fy-attempt-row > :nth-child(5) { display: none; }
  .fy-form-row { grid-template-columns: 1fr; }
}
`
