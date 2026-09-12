/* 墨锭试磨室前端：纯原生 JS，无依赖 */
"use strict";

const STATUSES = ["待试磨", "试磨中", "已试磨", "重点观察"];
const EVENT_LABEL = {
  create: "建档",
  checkout: "领用",
  test: "试磨",
  return: "归还",
  watch: "标记重点观察",
  unwatch: "取消重点观察",
  note: "备注",
};

let state = { items: [], stats: null, filter: "", q: "" };
let lastOperator = localStorage.getItem("ink.operator") || "";

const $ = (sel) => document.querySelector(sel);
const cardsEl = $("#cards");
const statsEl = $("#stats");
const legendEl = $("#legend");
const filterEl = $("#statusFilter");
const searchEl = $("#search");
const modalMask = $("#modalMask");
const modalBox = $("#modalBox");
const toastEl = $("#toast");

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function fmtTime(at) {
  if (!at) return "";
  const d = new Date(at);
  if (isNaN(d)) return at;
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function uid() {
  return "web-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

let toastTimer = null;
function toast(message, isErr) {
  toastEl.textContent = message;
  toastEl.className = "show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.className = ""), 3200);
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json" };
  // 所有变更请求带幂等键；网络层自动重试时也只会成功一次
  if (options.method && options.method !== "GET") {
    headers["X-Idempotency-Key"] = uid();
  }
  let res;
  try {
    res = await fetch(path, { ...options, headers });
  } catch (e) {
    throw new Error("网络错误，数据未提交：" + e.message);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    throw new Error(data?.message || data?.error || `请求失败（${res.status}）`);
  }
  return data;
}

async function load() {
  try {
    const q = state.q ? `&q=${encodeURIComponent(state.q)}` : "";
    const f = state.filter ? `&status=${encodeURIComponent(state.filter)}` : "";
    const data = await api(`/api/items?${f}${q}`);
    state.items = data.items;
    state.stats = data.stats;
    render();
  } catch (e) {
    toast(e.message, true);
  }
}

function renderStats() {
  const s = state.stats;
  if (!s) return;
  const cards = [
    ["全部", s.total, ""],
    ...STATUSES.map((st) => [st, s[st], st]),
  ];
  statsEl.innerHTML = cards
    .map(
      ([label, n, key]) =>
        `<div class="stat ${state.filter === key ? "active" : ""}" data-s="${esc(key)}">
           <strong>${n}</strong><span>${esc(label)}</span></div>`
    )
    .join("");
  statsEl.querySelectorAll(".stat").forEach((el) => {
    el.onclick = () => {
      state.filter = el.dataset.s || "";
      filterEl.value = state.filter;
      load();
    };
  });
}

function lastEventSummary(item) {
  const e = item.lastEvent;
  if (!e) return "暂无操作";
  let detail = "";
  if (e.type === "checkout") detail = `领至 ${e.position}`;
  else if (e.type === "return") detail = `归还至 ${e.position}`;
  else if (e.type === "test") detail = `${e.paper} · 评分 ${e.score}`;
  else if (e.note) detail = e.note;
  return `${EVENT_LABEL[e.type] || e.type} · ${e.operator} · ${fmtTime(e.at)}${detail ? " · " + detail : ""}`;
}

function cardHtml(item) {
  const holder =
    item.status === "试磨中" && item.holder
      ? `<div class="meta">🧾 ${esc(item.holder.operator)} 领用，位置：${esc(item.holder.position)}，自 ${fmtTime(item.holder.since)}</div>`
      : "";
  const scoreLine = item.testCount
    ? `<div class="meta">试磨 ${item.testCount} 次 · 最近评分 <b>${esc(item.lastScore)}</b></div>`
    : "";
  return `
  <article class="card" data-code="${esc(item.code)}">
    <div class="top">
      <h3>${esc(item.code)}</h3>
      <span class="pill ${esc(item.status)}">${esc(item.status)}</span>
    </div>
    <dl class="kv">
      <dt>烟料</dt><dd>${esc(item.smokeSource)}</dd>
      <dt>胶比</dt><dd>${esc(item.glueRatio)}</dd>
      <dt>年限</dt><dd>${esc(item.ageYears === "" ? "" : item.ageYears + " 年")}</dd>
      <dt>库位</dt><dd>${esc(item.storage)}</dd>
    </dl>
    ${holder}
    ${scoreLine}
    <div class="meta">最近操作：${esc(lastEventSummary(item))}</div>
    <div class="actions">
      ${item.status === "试磨中" ? actionButtonsInUse(item) : actionButtonsIdle(item)}
    </div>
    <button type="button" class="ghost" data-act="history">操作履历（${item.events.length}）</button>
  </article>`;
}

function actionButtonsInUse() {
  return `
    <button type="button" data-act="test">＋追加试磨</button>
    <button type="button" data-act="return">归还</button>`;
}

function actionButtonsIdle(item) {
  const watchBtn =
    item.status === "重点观察"
      ? `<button type="button" class="ghost" data-act="unwatch">取消观察</button>`
      : `<button type="button" class="watch" data-act="watch">重点观察</button>`;
  return `
    <button type="button" data-act="checkout">领用</button>
    ${watchBtn}`;
}

function render() {
  renderStats();
  if (!state.items.length) {
    cardsEl.innerHTML = `<div class="empty" style="grid-column:1/-1;">没有符合条件的墨锭</div>`;
  } else {
    cardsEl.innerHTML = state.items.map(cardHtml).join("");
  }
  legendEl.innerHTML = `流转：<b>${STATUSES.map(esc).join(" → ")}</b>（已试磨 / 重点观察可再次领用复测）；共 ${state.stats?.total ?? 0} 锭`;
}

/* ---------------- 弹窗表单 ---------------- */

function closeModal() {
  modalMask.classList.remove("show");
  modalBox.innerHTML = "";
}
modalMask.addEventListener("click", (e) => {
  if (e.target === modalMask) closeModal();
});

function openModal(title, bodyHtml, submitLabel, onSubmit, opts = {}) {
  modalBox.innerHTML = `
    <h2>${esc(title)}<button type="button" class="close" aria-label="关闭">×</button></h2>
    <form id="modalForm">
      ${bodyHtml}
      ${opts.extra || ""}
      <div class="modal-foot">
        <button type="button" class="ghost" id="modalCancel">取消</button>
        <button type="submit" class="${opts.primaryClass || ""}">${esc(submitLabel)}</button>
      </div>
    </form>`;
  modalBox.querySelector(".close").onclick = closeModal;
  modalBox.querySelector("#modalCancel").onclick = closeModal;
  const form = modalBox.querySelector("#modalForm");
  const op = form.querySelector('[name="operator"]');
  if (op && lastOperator) op.value = lastOperator;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const payload = Object.fromEntries(new FormData(form).entries());
    if (payload.operator) localStorage.setItem("ink.operator", payload.operator.trim());
    if (lastOperator !== payload.operator) lastOperator = (payload.operator || "").trim();
    try {
      const btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      await onSubmit(payload);
      closeModal();
      await load();
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
    }
  };
  modalMask.classList.add("show");
  const first = modalBox.querySelector("input,select,textarea");
  if (first) first.focus();
}

function commonFields(extra = "") {
  return `
    <label>操作人 *</label><input name="operator" required value="${esc(lastOperator)}" placeholder="姓名">
    ${extra}
    <label>备注</label><textarea name="note" placeholder="可选"></textarea>`;
}

function openCheckout(item) {
  openModal(
    `领用 ${item.code}`,
    commonFields(`
      <label>领用后位置（试磨台）*</label>
      <input name="position" required placeholder="如 一号试磨台">`),
    "确认领用",
    (payload) => api(`/api/items/${encodeURIComponent(item.code)}/checkout`, {
      method: "POST",
      body: JSON.stringify(payload),
    }).then(() => toast(`已领用 ${item.code}`))
  );
}

function openReturn(item) {
  openModal(
    `归还 ${item.code}`,
    commonFields(`
      <label>归还位置 *</label>
      <input name="position" required value="${esc(item.storage)}" placeholder="如 恒湿柜B">
      <label>归还后状态 *</label>
      <select name="toStatus">
        <option value="已试磨">已试磨（试磨完成）</option>
        <option value="重点观察">重点观察（墨色/沉淀异常需留观）</option>
      </select>`),
    "确认归还",
    (payload) => api(`/api/items/${encodeURIComponent(item.code)}/return`, {
      method: "POST",
      body: JSON.stringify(payload),
    }).then(() => toast(`已归还 ${item.code}`))
  );
}

function openTest(item) {
  openModal(
    `追加试磨 · ${item.code}`,
    commonFields(`
      <div class="row">
        <div><label>试磨纸张 *</label><input name="paper" required placeholder="如 净皮宣纸"></div>
        <div><label>加水量 *</label><input name="water" required placeholder="如 20滴"></div>
      </div>
      <div class="row">
        <div><label>出墨速度 *</label>
          <select name="speed" required>
            <option value="">请选择</option><option>快</option><option>中</option><option>慢</option>
          </select></div>
        <div><label>评分（0–100）*</label><input name="score" type="number" min="0" max="100" step="1" required></div>
      </div>
      <label>墨色层次 *</label><input name="colorLayer" required placeholder="如 焦浓重淡清分明 / 偏暖 / 发灰">
      <label>沉淀情况 *</label><input name="sediment" required placeholder="如 无 / 少量细沙感">`),
    "保存试磨记录",
    async (payload) => {
      await api(`/api/items/${encodeURIComponent(item.code)}/tests`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      toast(`试磨记录已追加（${payload.paper}，评分 ${payload.score}）`);
    }
  );
}

function openWatch(item, unwatch) {
  openModal(
    unwatch ? `取消重点观察 · ${item.code}` : `标记重点观察 · ${item.code}`,
    commonFields(`
      <input type="hidden" name="unwatch" value="${unwatch ? "true" : "false"}">
      <label>位置（可选）</label><input name="position" placeholder="如 观察架A">`),
    unwatch ? "取消观察（回到待试磨）" : "标记重点观察",
    (payload) =>
      api(`/api/items/${encodeURIComponent(item.code)}/watch`, {
        method: "POST",
        body: JSON.stringify({ ...payload, unwatch }),
      }).then(() => toast(unwatch ? "已取消重点观察" : "已列入重点观察")),
    { primaryClass: unwatch ? "ghost" : "watch" }
  );
}

function openHistory(item) {
  const rows = item.events
    .slice()
    .reverse()
    .map((e) => {
      let detail = "";
      if (e.type === "checkout") detail = `领至 <b>${esc(e.position)}</b>`;
      if (e.type === "return") detail = `归还至 <b>${esc(e.position)}</b>${e.fromPosition ? "（自 " + esc(e.fromPosition) + "）" : ""}`;
      if (e.type === "test")
        detail = `纸张：${esc(e.paper)}｜加水：${esc(e.water)}｜出墨：${esc(e.speed)}｜层次：${esc(e.colorLayer)}｜沉淀：${esc(e.sediment)}｜评分：<b>${esc(e.score)}</b>`;
      if (e.note) detail += (detail ? "<br>" : "") + "备注：" + esc(e.note);
      return `<li>
        <span class="tag ${esc(e.type)}">${esc(EVENT_LABEL[e.type] || e.type)}</span>
        ${esc(e.operator || "")}${e.position && e.type !== "checkout" && e.type !== "return" ? " · " + esc(e.position) : ""}
        <div class="t-time">${fmtTime(e.at)}</div>
        ${detail}
      </li>`;
    })
    .join("");
  modalBox.innerHTML = `
    <h2>操作履历 · ${esc(item.code)}<button type="button" class="close" aria-label="关闭">×</button></h2>
    <ul class="timeline">${rows || "<li>暂无记录</li>"}</ul>`;
  modalBox.querySelector(".close").onclick = closeModal;
  modalMask.classList.add("show");
}

cardsEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const code = btn.closest(".card").dataset.code;
  const item = state.items.find((i) => i.code === code);
  if (!item) return;
  switch (btn.dataset.act) {
    case "checkout": openCheckout(item); break;
    case "return": openReturn(item); break;
    case "test": openTest(item); break;
    case "watch": openWatch(item, false); break;
    case "unwatch": openWatch(item, true); break;
    case "history": openHistory(item); break;
  }
});

/* ---------------- 建档 / 筛选 ---------------- */

$("#createForm").onsubmit = async (e) => {
  e.preventDefault();
  const form = e.target;
  const payload = Object.fromEntries(new FormData(form).entries());
  try {
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    await api("/api/items", { method: "POST", body: JSON.stringify(payload) });
    form.reset();
    toast(`墨锭 ${payload.code} 已建档`);
    await load();
  } catch (err) {
    toast(err.message, true);
    form.querySelector('button[type="submit"]').disabled = false;
  }
};

filterEl.onchange = () => {
  state.filter = filterEl.value;
  load();
};
let searchTimer = null;
searchEl.oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = searchEl.value.trim();
    load();
  }, 250);
};
$("#clearFilter").onclick = () => {
  state.filter = "";
  state.q = "";
  filterEl.value = "";
  searchEl.value = "";
  load();
};
$("#reloadBtn").onclick = () => load();

load();
