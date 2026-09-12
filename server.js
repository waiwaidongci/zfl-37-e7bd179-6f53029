import http from "node:http";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  open,
  unlink,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPage } from "./public/page.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.INK_DB
  ? process.env.INK_DB
  : join(__dirname, "data", "ink-stick-testing.json");
const port = Number(process.env.PORT || 3037);

const STATUS = {
  PENDING: "待试磨",
  IN_USE: "试磨中",
  DONE: "已试磨",
  WATCH: "重点观察",
};
const STATUSES = [STATUS.PENDING, STATUS.IN_USE, STATUS.DONE, STATUS.WATCH];

const seed = {
  version: 2,
  items: [
    {
      code: "IS-001",
      smokeSource: "黄山松烟",
      glueRatio: "7.5%",
      ageYears: 8,
      storage: "恒湿柜B",
      status: STATUS.DONE,
      holder: null,
      events: [
        {
          id: "evt-seed-1",
          at: "2026-06-11T02:10:00.000Z",
          type: "checkout",
          operator: "周师傅",
          position: "一号试磨台",
          note: "例行试磨",
        },
        {
          id: "evt-seed-2",
          at: "2026-06-11T03:20:00.000Z",
          type: "test",
          operator: "周师傅",
          paper: "净皮宣纸",
          water: "20滴",
          speed: "快",
          colorLayer: "焦浓重淡清层次分明",
          sediment: "无",
          score: 86,
          note: "",
        },
        {
          id: "evt-seed-3",
          at: "2026-06-11T03:25:00.000Z",
          type: "return",
          operator: "周师傅",
          position: "恒湿柜B",
          note: "试磨完成归位",
        },
      ],
    },
    {
      code: "IS-002",
      smokeSource: "桐油烟",
      glueRatio: "8%",
      ageYears: 3,
      storage: "试样盒C",
      status: STATUS.WATCH,
      holder: null,
      events: [
        {
          id: "evt-seed-4",
          at: "2026-06-21T03:40:00.000Z",
          type: "checkout",
          operator: "林学徒",
          position: "二号试磨台",
          note: "初测",
        },
        {
          id: "evt-seed-5",
          at: "2026-06-21T03:50:28.907Z",
          type: "test",
          operator: "林学徒",
          paper: "棉连纸",
          water: "18滴",
          speed: "中",
          colorLayer: "偏暖",
          sediment: "少量细沙感",
          score: 79,
          note: "",
        },
        {
          id: "evt-seed-6",
          at: "2026-06-21T04:00:00.000Z",
          type: "return",
          operator: "林学徒",
          position: "试样盒C",
          note: "墨色发暖，留观",
        },
        {
          id: "evt-seed-7",
          at: "2026-06-21T04:05:00.000Z",
          type: "watch",
          operator: "周师傅",
          position: "",
          note: "评分79，列入重点观察",
        },
      ],
    },
  ],
  requestIds: {},
};

/* ---------------- 持久化 ---------------- */

// 验证用故障注入：INK_FAIL_WRITES=N 表示服务开始监听后的前 N 次 persist 强制失败
let failWritesLeft = 0;
let writesArmed = false;
// 验证用：INK_SLOW_WRITE_MS=N 让每次落盘先等待 N 毫秒，用于观察写入中的读一致性
const slowWriteMs = Number(process.env.INK_SLOW_WRITE_MS || 0) || 0;

async function persist(db) {
  if (writesArmed && failWritesLeft > 0) {
    failWritesLeft -= 1;
    const err = new Error("模拟磁盘写入失败（INK_FAIL_WRITES 注入）");
    err.code = "INJECTED_WRITE_FAILURE";
    throw err;
  }
  if (slowWriteMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, slowWriteMs));
  }
  await mkdir(dirname(dbPath), { recursive: true });
  const tmp = `${dbPath}.tmp-${process.pid}`;
  const payload = JSON.stringify(db, null, 2);
  const fh = await open(tmp, "w");
  let writeError = null;
  try {
    await fh.writeFile(payload, "utf8");
    // 落盘后再改名，保证任何时刻正式文件要么是旧版要么是新版，不会只写一半
    await fh.sync();
  } catch (err) {
    writeError = err;
  } finally {
    await fh.close().catch(() => {});
  }
  if (writeError) {
    await unlink(tmp).catch(() => {});
    throw writeError;
  }
  try {
    await rename(tmp, dbPath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await persist(seed);
    return { db: structuredClone(seed), migrated: false };
  }
  const raw = await readFile(dbPath, "utf8");
  let db;
  try {
    db = JSON.parse(raw);
  } catch {
    throw new Error(
      `数据文件 ${dbPath} 已损坏，拒绝启动以免覆盖现场；请修复或删除该文件后重试。`
    );
  }
  return migrate(db);
}

/** 旧版（v1：logs/tests、无事件流、无“试磨中”）迁移到 v2 闭环模型，返回 {db, migrated} */
function migrate(db) {
  let migrated = false;
  if (db.version >= 2) {
    db.requestIds ||= {};
    for (const item of db.items || []) {
      item.events ||= [];
      item.holder ??= null;
      if (!STATUSES.includes(item.status)) {
        item.status = STATUS.PENDING;
        migrated = true;
      }
      // 数据修复：非试磨中不应有持有人
      if (item.status !== STATUS.IN_USE) item.holder = null;
    }
    return { db, migrated };
  }
  migrated = true;
  for (const item of db.items || []) {
    const events = [];
    let seq = 0;
    const nextId = () => `${item.code}-mig-${++seq}`;
    const oldLogs = item.logs || [];
    const tests = item.tests || [];
    let testIdx = 0;
    for (const log of oldLogs) {
      if (log.step === "试磨") {
        events.push({
          id: nextId(),
          at: log.at,
          type: "checkout",
          operator: "历史导入",
          position: item.storage || "",
          note: "旧记录补录领用",
        });
        const t = tests[testIdx++];
        events.push({
          id: nextId(),
          at: log.at,
          type: "test",
          operator: "历史导入",
          paper: t?.paper || "",
          water: t?.water || "",
          speed: t?.speed || "",
          colorLayer: t?.colorLayer || "",
          sediment: t?.sediment || "",
          score: Number(log.score ?? t?.score ?? 0) || 0,
          note: t ? "" : log.note || "",
        });
        events.push({
          id: nextId(),
          at: log.at,
          type: "return",
          operator: "历史导入",
          position: item.storage || "",
          note: "旧记录补录归还",
        });
      } else {
        events.push({
          id: nextId(),
          at: log.at,
          type: "note",
          operator: "历史导入",
          note: log.note || "",
        });
      }
    }
    item.events = events;
    item.holder = null;
    if (!STATUSES.includes(item.status)) item.status = STATUS.PENDING;
  }
  db.version = 2;
  db.requestIds ||= {};
  return { db, migrated };
}

/* ---------------- 写入串行化 ---------------- */

let writeChain = Promise.resolve();
/** 所有变更都进同一队列：读-改-写整体串行，杜绝并发请求交叉写入 */
function mutate(worker) {
  const run = writeChain.then(() => worker());
  // 不让单个失败阻塞整条链
  writeChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

const MAX_REQUEST_IDS = 500;

function rememberIdempotency(db, key, status, body) {
  const keys = Object.keys(db.requestIds);
  if (keys.length >= MAX_REQUEST_IDS) {
    delete db.requestIds[keys[0]];
  }
  db.requestIds[key] = { at: new Date().toISOString(), status, body };
}

/* ---------------- 领域规则 ---------------- */

/** 合法流转表：from + action -> to */
const TRANSITIONS = {
  checkout: {
    [STATUS.PENDING]: STATUS.IN_USE,
    [STATUS.DONE]: STATUS.IN_USE,
    [STATUS.WATCH]: STATUS.IN_USE,
  },
  return_done: { [STATUS.IN_USE]: STATUS.DONE },
  return_watch: { [STATUS.IN_USE]: STATUS.WATCH },
  watch: {
    [STATUS.PENDING]: STATUS.WATCH,
    [STATUS.DONE]: STATUS.WATCH,
    [STATUS.WATCH]: STATUS.WATCH,
  },
  unwatch: {
    [STATUS.WATCH]: STATUS.PENDING,
  },
};

const ACTION_LABEL = {
  checkout: "领用",
  return_done: "归还（试磨完成）",
  return_watch: "归还（转重点观察）",
  watch: "标记重点观察",
  unwatch: "取消重点观察",
};

/** 校验流转，非法时抛出带中文原因的错误 */
function applyTransition(item, action) {
  const from = item.status;
  const to = TRANSITIONS[action]?.[from];
  if (to) return to;
  const reasons = {
    checkout: {
      [STATUS.IN_USE]: `墨锭 ${item.code} 当前为「试磨中」，已由 ${item.holder?.operator || "他人"} 领走，同一墨锭不能重复领用；请先归还后再操作。`,
    },
    return_done: notInUse(item),
    return_watch: notInUse(item),
    watch: {
      [STATUS.IN_USE]: `墨锭 ${item.code} 正在试磨中，请先归还，归还时可直接转「重点观察」。`,
    },
    unwatch: {
      [STATUS.PENDING]: `墨锭 ${item.code} 已是「待试磨」，无需取消重点观察。`,
      [STATUS.IN_USE]: `墨锭 ${item.code} 正在试磨中，不能取消重点观察。`,
      [STATUS.DONE]: `墨锭 ${item.code} 已试磨完成，不能取消重点观察。`,
    },
  };
  const msg =
    reasons[action]?.[from] ||
    `非法流转：墨锭 ${item.code} 不能从「${from}」执行「${ACTION_LABEL[action] || action}」。`;
  const err = new Error(msg);
  err.code = "INVALID_TRANSITION";
  throw err;
}

function notInUse(item) {
  return {
    [STATUS.PENDING]: `墨锭 ${item.code} 还在「待试磨」，尚未被领用，无法归还。`,
    [STATUS.DONE]: `墨锭 ${item.code} 已试磨并归还，不能重复归还。`,
    [STATUS.WATCH]: `墨锭 ${item.code} 已在重点观察架上（不在试磨中），不能重复归还。`,
  };
}

function evId() {
  return "evt-" + process.pid.toString(36) + "-" + (++evId.seq).toString(36);
}
evId.seq = 0;

function requireText(input, key, label) {
  const v = (input?.[key] ?? "").toString().trim();
  if (!v) {
    const err = new Error(`「${label}」不能为空`);
    err.code = "VALIDATION";
    throw err;
  }
  return v;
}

/** 试磨/归还仅限当前领用人本人；否则 403 并说明当前持有人 */
function requireHolder(item, operator) {
  if (item.status === STATUS.IN_USE && item.holder && item.holder.operator !== operator) {
    throw new HttpError(
      403,
      "holder_mismatch",
      `墨锭 ${item.code} 正由 ${item.holder.operator} 在 ${item.holder.position} 试磨中，仅领用人本人可操作，${operator} 无权试磨或归还。`
    );
  }
}

function summarize(item) {
  const tests = item.events.filter((e) => e.type === "test");
  const last = item.events[item.events.length - 1] || null;
  return {
    code: item.code,
    smokeSource: item.smokeSource || "",
    glueRatio: item.glueRatio || "",
    ageYears: item.ageYears ?? "",
    storage: item.storage || "",
    status: item.status,
    holder: item.holder,
    testCount: tests.length,
    lastScore: tests.length ? tests[tests.length - 1].score : null,
    lastEvent: last,
    events: item.events,
  };
}

function stats(items) {
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const item of items) counts[item.status] = (counts[item.status] || 0) + 1;
  return { total: items.length, ...counts };
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/* ---------------- HTTP 辅助 ---------------- */

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new HttpError(413, "body_too_large", "请求体过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "bad_json", "请求体不是合法 JSON");
  }
}

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

let db;

/* ---------------- 启动 ---------------- */

await mkdir(dirname(dbPath), { recursive: true });
let migrated = false;
({ db, migrated } = await loadDb());
// 旧版数据迁移后立即把升级结果原子落盘，保证磁盘文件与运行模型一致
if (migrated) {
  await mutate(async () => {
    await persist(db);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const { pathname } = url;

    if (req.method === "GET" && pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(renderPage({ statuses: STATUSES }));
    }

    if (req.method === "GET" && pathname === "/api/items") {
      const status = url.searchParams.get("status");
      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      let items = db.items;
      if (status) {
        if (!STATUSES.includes(status)) {
          throw new HttpError(400, "bad_status", `未知状态：${status}`);
        }
        items = items.filter((i) => i.status === status);
      }
      if (q) {
        items = items.filter((i) =>
          JSON.stringify({
            code: i.code,
            smokeSource: i.smokeSource,
            glueRatio: i.glueRatio,
            storage: i.storage,
            events: i.events.map((e) => `${e.operator || ""} ${e.note || ""}`),
          })
            .toLowerCase()
            .includes(q)
        );
      }
      return send(res, 200, {
        stats: stats(db.items),
        items: items.map(summarize),
      });
    }

    if (req.method === "GET" && pathname === "/api/stats") {
      return send(res, 200, stats(db.items));
    }

    if (req.method !== "POST") {
      throw new HttpError(404, "not_found", "接口不存在");
    }

    const input = await readBody(req);
    const idemKey = req.headers["x-idempotency-key"]?.toString().trim();

    const result = await mutate(async () => {
      // 幂等重放：同一 requestId 直接返回首次成功时的快照（深拷贝，与活动状态隔离）
      if (idemKey && db.requestIds[idemKey]) {
        const cached = db.requestIds[idemKey];
        return {
          status: cached.status,
          body: structuredClone(cached.body),
          replayed: true,
        };
      }
      // 事务在草稿副本上完成全部校验与变更：活动 db 在此期间保持旧值，
      // 并发 GET 永远读不到“未提交”状态，业务失败也无需回滚
      const draft = structuredClone(db);
      const out = await route(draft, pathname, input);
      if (idemKey) {
        rememberIdempotency(draft, idemKey, out.status, structuredClone(out.body));
      }
      try {
        await persist(draft);
      } catch (err) {
        // 落盘失败：草稿直接丢弃，活动内存与磁盘都还是旧状态，幂等键也未被占用
        const wrapped = new Error(
          `数据未能写入磁盘，本次操作未生效（内存与磁盘均保持原状，未占用幂等键），请在存储恢复后重试。原因：${err.message}`
        );
        wrapped.code = "WRITE_FAILED";
        throw wrapped;
      }
      // 提交点：落盘成功后才用草稿整体替换活动状态
      db = draft;
      // 返回深拷贝快照：这是“首次成功时”的完整状态，后续操作不改变旧响应
      return { status: out.status, body: structuredClone(out.body) };
    });

    res.setHeader("Idempotent-Replayed", result.replayed ? "true" : "false");
    return send(res, result.status, result.body);
  } catch (error) {
    if (error.code === "WRITE_FAILED") {
      return send(res, 507, { error: "write_failed", message: error.message });
    }
    if (error instanceof HttpError) {
      return send(res, error.status, { error: error.code, message: error.message });
    }
    if (error.code === "INVALID_TRANSITION" || error.code === "VALIDATION") {
      return send(res, 409, { error: error.code, message: error.message });
    }
    return send(res, 500, { error: "internal", message: error.message });
  }
});

/** POST 路由，运行在写入串行队列中，在草稿 db 上变更，返回 {status, body} */
function route(draftDb, pathname, input) {
  let m;

  if (pathname === "/api/items") {
    const code = requireText(input, "code", "墨锭编号").toUpperCase();
    if (!/^[A-Za-z0-9][A-Za-z0-9-_]{0,31}$/.test(code)) {
      throw new HttpError(
        400,
        "bad_code",
        "墨锭编号只能包含字母、数字、中划线，长度 1–32"
      );
    }
    if (draftDb.items.some((i) => i.code === code)) {
      throw new HttpError(409, "duplicate_code", `墨锭编号 ${code} 已存在，编号必须唯一`);
    }
    const item = {
      code,
      smokeSource: (input.smokeSource || "").toString().trim(),
      glueRatio: (input.glueRatio || "").toString().trim(),
      ageYears: input.ageYears === "" || input.ageYears == null ? "" : Number(input.ageYears),
      storage: (input.storage || "").toString().trim(),
      status: STATUS.PENDING, // 新墨锭一律待试磨，不能跳过领用直接试磨
      holder: null,
      events: [
        {
          id: evId(),
          at: new Date().toISOString(),
          type: "create",
          operator: requireText(input, "operator", "操作人"),
          position: (input.storage || "").toString().trim(),
          note: (input.note || "").toString().trim(),
        },
      ],
    };
    draftDb.items.unshift(item);
    return { status: 201, body: summarize(item) };
  }

  m = pathname.match(/^\/api\/items\/([^/]+)\/checkout$/);
  if (m) {
    const item = findItem(draftDb, decodeURIComponent(m[1]));
    const to = applyTransition(item, "checkout");
    const operator = requireText(input, "operator", "操作人");
    const position = requireText(input, "position", "领用位置");
    item.holder = {
      operator,
      since: new Date().toISOString(),
      position,
    };
    item.status = to;
    item.events.push({
      id: evId(),
      at: new Date().toISOString(),
      type: "checkout",
      operator,
      position,
      note: (input.note || "").toString().trim(),
    });
    return { status: 201, body: summarize(item) };
  }

  m = pathname.match(/^\/api\/items\/([^/]+)\/return$/);
  if (m) {
    const item = findItem(draftDb, decodeURIComponent(m[1]));
    const toWatch = input.toStatus === STATUS.WATCH;
    const to = applyTransition(item, toWatch ? "return_watch" : "return_done");
    const operator = requireText(input, "operator", "操作人");
    // 谁领用谁归还：试磨中的墨锭不允许他人代为归还
    requireHolder(item, operator);
    const position = requireText(input, "position", "归还位置");
    const holder = item.holder;
    item.holder = null;
    item.status = to;
    item.events.push({
      id: evId(),
      at: new Date().toISOString(),
      type: "return",
      operator,
      position,
      note: (input.note || "").toString().trim(),
      fromPosition: holder?.position || "",
    });
    return { status: 201, body: summarize(item) };
  }

  m = pathname.match(/^\/api\/items\/([^/]+)\/tests$/);
  if (m) {
    const item = findItem(draftDb, decodeURIComponent(m[1]));
    // 试磨记录只能在“试磨中”追加；归还后想补测请重新领用（已试磨/重点观察都允许再领）
    if (item.status !== STATUS.IN_USE) {
      const err = new Error(
        `墨锭 ${item.code} 当前为「${item.status}」，只有「试磨中」的墨锭才能追加试磨记录；请先领用。`
      );
      err.code = "INVALID_TRANSITION";
      throw err;
    }
    const operator = requireText(input, "operator", "操作人");
    // 试磨记录只能由当前领用人本人追加，他人不能操作正在试磨的墨锭
    requireHolder(item, operator);
    const scoreRaw = requireText(input, "score", "评分");
    const score = Number(scoreRaw);
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      throw new HttpError(400, "bad_score", "评分必须是 0–100 的数字");
    }
    item.events.push({
      id: evId(),
      at: new Date().toISOString(),
      type: "test",
      operator,
      paper: requireText(input, "paper", "试磨纸张"),
      water: requireText(input, "water", "加水量"),
      speed: requireText(input, "speed", "出墨速度"),
      colorLayer: requireText(input, "colorLayer", "墨色层次"),
      sediment: requireText(input, "sediment", "沉淀情况"),
      score,
      note: (input.note || "").toString().trim(),
      // 试磨期间位置沿用领用位置，保证记录可追溯
      position: item.holder?.position || "",
    });
    return { status: 201, body: summarize(item) };
  }

  m = pathname.match(/^\/api\/items\/([^/]+)\/watch$/);
  if (m) {
    const item = findItem(draftDb, decodeURIComponent(m[1]));
    const unwatch = input.unwatch === true;
    const action = unwatch ? "unwatch" : "watch";
    const to = applyTransition(item, action);
    const operator = requireText(input, "operator", "操作人");
    item.status = to;
    item.events.push({
      id: evId(),
      at: new Date().toISOString(),
      type: unwatch ? "unwatch" : "watch",
      operator,
      position: (input.position || "").toString().trim(),
      note: (input.note || "").toString().trim(),
    });
    return { status: 201, body: summarize(item) };
  }

  throw new HttpError(404, "not_found", "接口不存在");
}

function findItem(targetDb, code) {
  const item = targetDb.items.find((i) => i.code === code);
  if (!item) {
    throw new HttpError(404, "item_not_found", `墨锭 ${code} 不存在`);
  }
  return item;
}

server.listen(port, () => {
  // 此时启动阶段的迁移落盘已完成，再启用验证用的写入故障注入
  failWritesLeft = Number(process.env.INK_FAIL_WRITES || 0) || 0;
  writesArmed = true;
  console.log(`墨锭试磨室 listening on http://localhost:${port}`);
  console.log(`数据文件：${dbPath}`);
});
