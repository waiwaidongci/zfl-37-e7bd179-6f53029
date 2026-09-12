/**
 * 端到端验证：启动真实 HTTP 服务，覆盖状态机、领用闭环、并发/幂等、
 * 连续试磨、筛选统计、原子持久化与重启一致性、旧数据迁移。
 * 用法：node verify.mjs
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
const failures = [];

function ok(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(name + (extra ? ` — ${extra}` : ""));
    console.log(`  ❌ ${name} ${extra}`);
  }
}

function startServer(port, dbPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server.js"], {
      env: { ...process.env, PORT: String(port), INK_DB: dbPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      if (buf.includes("listening")) resolve(child);
    });
    child.stderr.on("data", (d) => process.stderr.write(d));
    setTimeout(() => reject(new Error("server start timeout")), 8000);
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    child.on("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 3000);
  });
}

async function req(base, method, path, body, key) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (key) headers["X-Idempotency-Key"] = key;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, replayed: res.headers.get("Idempotent-Replayed") };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "ink-verify-"));
  const dbPath = join(dir, "test-db.json");
  const PORT = 3199;
  const base = `http://127.0.0.1:${PORT}`;

  console.log("\n① 启动服务（全新数据文件，使用内置种子）");
  let server = await startServer(PORT, dbPath);

  console.log("\n② 页面与基础接口");
  const home = await fetch(base + "/");
  const html = await home.text();
  ok("首页 200 且为中文页面", home.status === 200 && html.includes("墨锭试磨室"));
  ok("页面含四个状态", ["待试磨", "试磨中", "已试磨", "重点观察"].every((s) => html.includes(s)));

  let r = await req(base, "GET", "/api/items");
  ok("列表含统计 stats，四状态齐全", r.status === 200 &&
    ["待试磨", "试磨中", "已试磨", "重点观察"].every((s) => typeof r.json.stats[s] === "number"));
  ok("种子总数=2，已试磨1、重点观察1",
    r.json.stats.total === 2 &&
    r.json.stats["已试磨"] === 1 && r.json.stats["重点观察"] === 1);
  ok("列表项带最近操作 lastEvent", r.json.items.every((i) => i.lastEvent && i.lastEvent.type));

  console.log("\n③ 建档：编号唯一与必填校验");
  r = await req(base, "POST", "/api/items", {
    code: "IS-T1", smokeSource: "油烟", glueRatio: "8%", ageYears: 2,
    storage: "试样盒A", operator: "测试员", note: "",
  });
  ok("新建 IS-T1 成功，初始状态=待试磨", r.status === 201 && r.json.status === "待试磨");
  r = await req(base, "POST", "/api/items", { code: "IS-T1", operator: "测试员" });
  ok("重复编号被拒（409 duplicate_code）", r.status === 409 && r.json.error === "duplicate_code" && /已存在/.test(r.json.message));
  r = await req(base, "POST", "/api/items", { code: "IS-T3" });
  ok("缺操作人被拒并说明原因", r.status === 409 && r.json.error === "VALIDATION" && /操作人/.test(r.json.message));
  r = await req(base, "POST", "/api/items", { code: "bad code!", operator: "测试员" });
  ok("非法编号格式被拒", r.status === 400 && r.json.error === "bad_code");

  console.log("\n④ 非法跳转必须拒绝并说明原因");
  r = await req(base, "POST", "/api/items/IS-T1/return", { operator: "测试员", position: "X" });
  ok("待试磨直接归还→409，原因明确", r.status === 409 && /尚未被领用|待试磨/.test(r.json.message));
  r = await req(base, "POST", "/api/items/IS-T1/tests", {
    operator: "测试员", paper: "宣纸", water: "10滴", speed: "快",
    colorLayer: "分明", sediment: "无", score: 90,
  });
  ok("未领用就试磨→409，提示先领用", r.status === 409 && /只有「试磨中」|先领用/.test(r.json.message));

  console.log("\n⑤ 并发领用：8 个同时请求只能成功一次");
  const concurrent = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      req(base, "POST", "/api/items/IS-T1/checkout", {
        operator: `并发用户${i}`, position: `试磨台${i}`, note: `c${i}`,
      }, `ck-t1-${i}`)
    )
  );
  const success = concurrent.filter((x) => x.status === 201);
  const rejected = concurrent.filter((x) => x.status === 409);
  ok("恰好 1 个领用成功", success.length === 1, `成功 ${success.length} 个`);
  ok("其余 7 个被拒绝", rejected.length === 7, `拒绝 ${rejected.length} 个`);
  ok("拒绝原因提示不可重复领用及当前持有人", rejected.every((x) => /不能重复领用/.test(x.json.message)));
  r = await req(base, "GET", "/api/items?status=试磨中");
  const t1 = r.json.items.find((i) => i.code === "IS-T1");
  ok("IS-T1 状态=试磨中，且有唯一持有人", t1 && t1.status === "试磨中" && t1.holder && t1.holder.operator);
  const t1Full = (await req(base, "GET", "/api/items")).json.items.find((i) => i.code === "IS-T1");
  ok("履历中只有 1 条领用事件", t1Full.events.filter((e) => e.type === "checkout").length === 1);

  console.log("\n⑥ 同一 requestId 重复请求幂等（只生效一次）");
  r = await req(base, "POST", "/api/items", { code: "IS-IDEM", operator: "测试员" }, "fixed-key-001");
  ok("首次建档 201", r.status === 201);
  r = await req(base, "POST", "/api/items", { code: "IS-IDEM", operator: "测试员" }, "fixed-key-001");
  ok("同 key 重放返回首次结果且标记 replayed", r.status === 201 && r.replayed === "true");
  const allItems = (await req(base, "GET", "/api/items")).json.items;
  ok("IS-IDEM 只有一条（没有重复建档）", allItems.filter((i) => i.code === "IS-IDEM").length === 1);

  console.log("\n⑦ 试磨中连续追加试磨记录");
  const testPayload = (paper, score) => ({
    operator: "并发用户0", paper, water: "20滴", speed: "快",
    colorLayer: "焦浓重淡清", sediment: "无", score, note: "",
  });
  r = await req(base, "POST", "/api/items/IS-T1/tests", testPayload("净皮宣纸", 92), "k-test-1");
  ok("第一次试磨 201，状态保持试磨中", r.status === 201 && r.json.status === "试磨中" && r.json.testCount === 1);
  r = await req(base, "POST", "/api/items/IS-T1/tests", testPayload("棉连纸", 77), "k-test-2");
  ok("第二次追加试磨成功，testCount=2，最近评分=77",
    r.status === 201 && r.json.testCount === 2 && r.json.lastScore === 77);
  r = await req(base, "POST", "/api/items/IS-T1/tests", {
    ...testPayload("x", 120),
  }, "k-test-3");
  ok("评分越界（120）被拒", r.status === 400 && r.json.error === "bad_score");
  r = await req(base, "POST", "/api/items/IS-T1/tests", {
    operator: "并发用户0", paper: "", water: "", speed: "", colorLayer: "", sediment: "", score: 80,
  }, "k-test-4");
  ok("试磨必填字段缺失被拒", r.status === 409 && r.json.error === "VALIDATION");
  r = await req(base, "POST", "/api/items/IS-T1/watch", { operator: "并发用户0", note: "" });
  ok("试磨中直接标记重点观察→409，提示先归还", r.status === 409 && /先归还/.test(r.json.message));
  r = await req(base, "POST", "/api/items/IS-T1/checkout", { operator: "别人", position: "台2" });
  ok("试磨中再次领用→409 不可重复领用", r.status === 409 && /不能重复领用/.test(r.json.message));

  console.log("\n⑧ 归还闭环与再领用复测");
  r = await req(base, "POST", "/api/items/IS-T1/return", {
    operator: "并发用户0", position: "试样盒A", toStatus: "已试磨", note: "墨色佳",
  }, "k-ret-1");
  ok("归还为已试磨，holder 清空", r.status === 201 && r.json.status === "已试磨" && r.json.holder === null);
  const t1After = (await req(base, "GET", "/api/items")).json.items.find((i) => i.code === "IS-T1");
  const retEvt = t1After.events.find((e) => e.type === "return");
  ok("归还事件记录操作人/时间/位置/备注", retEvt && retEvt.operator && retEvt.at && retEvt.position === "试样盒A" && retEvt.note === "墨色佳");
  r = await req(base, "POST", "/api/items/IS-T1/checkout", { operator: "复测员", position: "二号台" }, "k-co-2");
  ok("已试磨可再次领用复测", r.status === 201 && r.json.status === "试磨中");
  await req(base, "POST", "/api/items/IS-T1/tests", testPayload("皮纸", 68), "k-test-5");
  r = await req(base, "POST", "/api/items/IS-T1/return", {
    operator: "复测员", position: "观察架A", toStatus: "重点观察",
  }, "k-ret-2");
  ok("归还时转重点观察", r.status === 201 && r.json.status === "重点观察" && r.json.holder === null);
  r = await req(base, "POST", "/api/items/IS-T1/watch", { operator: "周师傅", unwatch: true }, "k-unw");
  ok("取消重点观察→待试磨", r.status === 201 && r.json.status === "待试磨");

  console.log("\n⑨ 列表筛选、状态数量、最近操作");
  r = await req(base, "GET", "/api/items?status=重点观察");
  ok("按重点观察筛选只返回该状态", r.status === 200 && r.json.items.every((i) => i.status === "重点观察") && r.json.items.length >= 1);
  r = await req(base, "GET", "/api/items?status=不存在");
  ok("非法状态筛选 400", r.status === 400);
  r = await req(base, "GET", "/api/items?q=IS-T1");
  ok("关键词搜索 IS-T1 命中", r.json.items.some((i) => i.code === "IS-T1") && r.json.items.every((i) => i.code.includes("IS-T1")));
  r = await req(base, "GET", "/api/stats");
  ok("/api/stats 总数与各状态数自洽",
    r.json.total === Object.values(["待试磨", "试磨中", "已试磨", "重点观察"]).reduce((n, s) => n + r.json[s], 0));

  console.log("\n⑩ 写入原子性：磁盘文件始终完整，无残留临时文件");
  const onDisk = JSON.parse(await readFile(dbPath, "utf8"));
  const apiNow = (await req(base, "GET", "/api/items")).json;
  ok("磁盘 JSON 可解析且条目数与接口一致", Array.isArray(onDisk.items) && onDisk.items.length === apiNow.items.length);
  const diskT1 = onDisk.items.find((i) => i.code === "IS-T1");
  ok("磁盘上 IS-T1 试磨事件=3（92/77/68）", diskT1.events.filter((e) => e.type === "test").length === 3);
  const leftovers = (await readdir(dir)).filter((f) => f.includes(".tmp-"));
  ok("无残留 .tmp 临时文件", leftovers.length === 0, leftovers.join(","));

  console.log("\n⑪ 重启后数据一致（刷新/崩溃恢复）");
  await stopServer(server);
  server = await startServer(PORT, dbPath);
  r = await req(base, "GET", "/api/items");
  const reT1 = r.json.items.find((i) => i.code === "IS-T1");
  ok("重启后 IS-T1 为待试磨、3 次试磨记录仍在", reT1.status === "待试磨" && reT1.testCount === 3);
  ok("重启后统计数一致", r.json.stats.total === apiNow.stats.total);
  ok("重启后履历完整（含领用×2/归还×2/试磨×3）",
    reT1.events.filter((e) => e.type === "checkout").length === 2 &&
    reT1.events.filter((e) => e.type === "return").length === 2);

  console.log("\n⑫ 旧版数据（logs/tests、无试磨中）自动迁移");
  const oldDb = join(dir, "old-db.json");
  await writeFile(oldDb, JSON.stringify({
    items: [
      {
        code: "OLD-1", smokeSource: "松烟", glueRatio: "7%", ageYears: 5, storage: "柜1",
        status: "已试磨",
        logs: [{ at: "2026-06-11", step: "试磨", note: "宣纸20滴水，出墨快，评分86", score: 86 }],
        tests: [{ at: "2026-06-11", paper: "宣纸", water: "20滴", speed: "快", colorLayer: "好", sediment: "无", score: 86 }],
      },
      {
        code: "OLD-2", smokeSource: "油烟", glueRatio: "8%", ageYears: 1, storage: "柜2",
        status: "待试磨", logs: [],
      },
    ],
  }));
  const oldServer = await startServer(3200, oldDb);
  const oldBase = `http://127.0.0.1:3200`;
  r = await req(oldBase, "GET", "/api/items");
  const o1 = r.json.items.find((i) => i.code === "OLD-1");
  ok("旧记录迁移后补出 领用→试磨→归还 事件链",
    o1.events.map((e) => e.type).join(",") === "checkout,test,return");
  ok("迁移保留状态与评分", o1.status === "已试磨" && o1.lastScore === 86);
  const o2 = r.json.items.find((i) => i.code === "OLD-2");
  ok("原本待试磨、无记录的墨锭迁移为零事件待试磨", o2.status === "待试磨" && o2.events.length === 0);
  await stopServer(oldServer);

  await stopServer(server);
  await rm(dir, { recursive: true, force: true });

  console.log(`\n========== 结果：${passed} 通过，${failures.length} 失败 ==========`);
  if (failures.length) {
    console.log("失败项：\n - " + failures.join("\n - "));
    process.exit(1);
  }
  console.log("全部验证通过 ✅");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
