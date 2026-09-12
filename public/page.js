import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function renderPage({ statuses }) {
  const appJs = readFileSync(join(__dirname, "app.js"), "utf8");
  const filterOptions = statuses
    .map((s) => `<option value="${s}">${s}</option>`)
    .join("");
  const legend = statuses.join(" → ");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>墨锭试磨室 · 领用闭环</title>
<style>
  :root {
    --bg:#eef1ea; --panel:#fff; --ink:#20231e; --muted:#6a7265; --line:#d3dccf;
    --accent:#4f6b41; --accent-dark:#3e5533; --warn:#9a4636; --watch:#a96a1c;
    --done:#42607a; --use:#6b4f7a; --pending:#69736a;
  }
  * { box-sizing:border-box; }
  html,body { margin:0; padding:0; }
  body { background:var(--bg); color:var(--ink); font-family:-apple-system,"PingFang SC","Microsoft YaHei",Arial,sans-serif; font-size:15px; line-height:1.5; }
  header { padding:18px 24px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; }
  h1 { margin:0; font-size:22px; }
  header .sub { color:var(--muted); font-size:13px; margin-top:2px; }
  main { display:grid; grid-template-columns:360px 1fr; gap:18px; padding:18px 24px; align-items:start; }
  .panel, form.panel, .card, .stat { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:15px; }
  h2 { margin:0 0 10px; font-size:16px; }
  label { display:block; margin:9px 0 4px; color:var(--muted); font-size:13px; }
  input,select,textarea { width:100%; border:1px solid var(--line); border-radius:7px; padding:10px; font:inherit; background:#fff; color:var(--ink); }
  textarea { min-height:60px; resize:vertical; }
  button { border:0; border-radius:7px; background:var(--accent); color:#fff; padding:10px 14px; font-weight:700; font-size:14px; cursor:pointer; min-height:42px; }
  button:hover { background:var(--accent-dark); }
  button.ghost { background:#eef1ea; color:var(--ink); border:1px solid var(--line); }
  button.warn { background:var(--warn); }
  button.watch { background:var(--watch); }
  button:disabled { opacity:.5; cursor:not-allowed; }
  .row { display:flex; gap:8px; flex-wrap:wrap; }
  .row > * { flex:1; }

  .stats { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:10px; margin-bottom:14px; }
  .stat { text-align:center; cursor:pointer; user-select:none; padding:12px 8px; }
  .stat.active { outline:2px solid var(--accent); }
  .stat strong { display:block; font-size:24px; line-height:1.2; }
  .stat span { font-size:13px; color:var(--muted); }
  .stat[data-s="待试磨"] strong { color:var(--pending); }
  .stat[data-s="试磨中"] strong { color:var(--use); }
  .stat[data-s="已试磨"] strong { color:var(--done); }
  .stat[data-s="重点观察"] strong { color:var(--watch); }

  .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:12px; align-items:center; }
  .toolbar input { flex:1; min-width:180px; }
  .legend { color:var(--muted); font-size:12.5px; margin-bottom:12px; }
  .legend b { color:var(--ink); font-weight:600; }

  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; }
  .card { display:flex; flex-direction:column; gap:8px; }
  .card .top { display:flex; justify-content:space-between; align-items:center; gap:8px; }
  .card h3 { margin:0; font-size:17px; }
  .pill { display:inline-block; border-radius:999px; padding:3px 10px; font-size:12px; color:#fff; white-space:nowrap; }
  .pill.待试磨 { background:var(--pending); }
  .pill.试磨中 { background:var(--use); }
  .pill.已试磨 { background:var(--done); }
  .pill.重点观察 { background:var(--watch); }
  .meta { color:var(--muted); font-size:13px; word-break:break-all; }
  .kv { display:grid; grid-template-columns:auto 1fr; gap:2px 10px; font-size:13.5px; }
  .kv dt { color:var(--muted); }
  .kv dd { margin:0; }
  .actions { display:flex; gap:7px; flex-wrap:wrap; margin-top:4px; }
  .actions button { flex:1; min-width:96px; padding:9px 8px; }
  .empty { color:var(--muted); text-align:center; padding:40px 0; }

  /* 弹窗 */
  .modal-mask { position:fixed; inset:0; background:rgba(25,30,22,.45); display:none; align-items:flex-end; justify-content:center; z-index:50; }
  .modal-mask.show { display:flex; }
  .modal { background:#fff; width:100%; max-width:520px; border-radius:14px 14px 0 0; padding:18px 18px calc(18px + env(safe-area-inset-bottom)); max-height:92vh; overflow:auto; }
  .modal h2 { display:flex; justify-content:space-between; align-items:center; }
  .modal .close { background:none; color:var(--muted); font-size:22px; min-height:auto; padding:0 4px; }
  .modal-foot { display:flex; gap:10px; margin-top:14px; }
  .modal-foot button { flex:1; }

  /* 履历时间线 */
  .timeline { list-style:none; margin:8px 0 0; padding:0 0 0 14px; border-left:2px solid var(--line); }
  .timeline li { position:relative; padding:0 0 12px 12px; font-size:13.5px; }
  .timeline li::before { content:""; position:absolute; left:-18px; top:5px; width:8px; height:8px; border-radius:50%; background:var(--accent); }
  .timeline .t-time { color:var(--muted); font-size:12px; }
  .tag { display:inline-block; font-size:11px; border-radius:4px; padding:0 6px; margin-right:6px; color:#fff; background:var(--pending); }
  .tag.checkout { background:var(--use); } .tag.return { background:var(--done); }
  .tag.test { background:var(--accent); } .tag.watch { background:var(--watch); }
  .tag.unwatch,.tag.note,.tag.create { background:var(--pending); }

  #toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%) translateY(20px); opacity:0; pointer-events:none;
    background:#2c332a; color:#fff; padding:11px 18px; border-radius:9px; max-width:90vw; z-index:80; transition:.2s; font-size:14px; }
  #toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
  #toast.err { background:var(--warn); }

  .side > * + * { margin-top:14px; }
  @media (min-width:901px){ .modal-mask{align-items:center;} .modal{border-radius:14px;} }
  @media (max-width:900px){
    header { padding:14px 14px 12px; }
    main { grid-template-columns:1fr; padding:12px; gap:12px; }
    .stats { grid-template-columns:repeat(3,1fr); }
    .stat strong { font-size:20px; }
    .grid { grid-template-columns:1fr; }
  }
</style>
</head>
<body>
<header>
  <div>
    <h1>墨锭试磨室</h1>
    <div class="sub">领用 → 试磨 → 归还 全流程可追溯</div>
  </div>
  <div class="row" style="flex:0 0 auto;">
    <button class="ghost" id="reloadBtn" type="button">刷新</button>
  </div>
</header>
<main>
  <div class="side">
    <form class="panel" id="createForm">
      <h2>新增墨锭（建档即「待试磨」）</h2>
      <label>墨锭编号（唯一）*</label>
      <input name="code" required maxlength="32" placeholder="如 IS-003">
      <div class="row">
        <div><label>烟料来源</label><input name="smokeSource" placeholder="如 黄山松烟"></div>
        <div><label>胶料比例</label><input name="glueRatio" placeholder="如 7.5%"></div>
      </div>
      <div class="row">
        <div><label>存放年限</label><input name="ageYears" type="number" min="0" step="1"></div>
        <div><label>存放位置</label><input name="storage" placeholder="如 恒湿柜B"></div>
      </div>
      <label>操作人 *</label>
      <input name="operator" required placeholder="建档人">
      <label>备注</label>
      <textarea name="note" placeholder="可选"></textarea>
      <div style="margin-top:12px;"><button type="submit">保存墨锭</button></div>
    </form>
    <div class="panel">
      <h2>流转规则</h2>
      <div class="meta">
        <b>${legend}</b><br>
        · 待试磨 / 已试磨 / 重点观察 → 领用 → 试磨中<br>
        · 试磨中可连续追加多次试磨记录<br>
        · 归还时选择「试磨完成」或「转重点观察」<br>
        · 试磨中不可重复领用、不可直接改状态
      </div>
    </div>
  </div>

  <section>
    <div class="stats" id="stats"></div>
    <div class="toolbar">
      <select id="statusFilter"><option value="">全部状态</option>${filterOptions}</select>
      <input id="search" placeholder="搜索编号 / 烟料 / 位置">
      <button class="ghost" type="button" id="clearFilter">清除筛选</button>
    </div>
    <div class="legend" id="legend"></div>
    <div class="grid" id="cards"></div>
  </section>
</main>

<div class="modal-mask" id="modalMask">
  <div class="modal" id="modalBox"></div>
</div>
<div id="toast"></div>

<script>
${appJs}
</script>
</body>
</html>`;
}
