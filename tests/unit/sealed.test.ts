import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as compareGet } from "@/app/api/compare/route";
import { POST as actionPost } from "@/app/api/runs/[id]/[action]/route";
import { GET as audioGet } from "@/app/api/runs/[id]/audio/route";
import { GET as eventsGet } from "@/app/api/runs/[id]/events/route";
import { POST as playbackPost } from "@/app/api/runs/[id]/playback/route";
import { POST as reviewPost } from "@/app/api/runs/[id]/review/route";
import { GET as runGet } from "@/app/api/runs/[id]/route";
import { GET as runsGet, POST as runsPost } from "@/app/api/runs/route";
import { GET as statusGet } from "@/app/api/status/route";
import { isSealedSuite, listSuites, loadSuite, type SuiteInfo } from "@/lib/domain/cases";
import type { CaseV1 } from "@/lib/domain/types";
import { mapRuns } from "@/lib/server/attack-map";
import { createRun, listRuns, runSuite } from "@/lib/server/runs";
import { isSealedRun, publicRuns, publicSuites, sealedRunResponse, sealedSuiteMatcher, sealedSuites } from "@/lib/server/sealed";

// 保留集在网页上封存（ADR-050）：状态接口、用例库只给公开的套件；网页上不能拿保留集跑；保留集的运行记录在网页接口上当作不存在，
// 而且回的和真没有这次运行一模一样（猜不出哪个编号是保留集的）。
// 这里只查套件名、题号前缀、条数，不把保留集的题目打印出来（断言失败时也只会打出套件名、状态码和真假）。

const suite = (id: string, splits: string[], opts: { errors?: string[]; heldout?: boolean } = {}): SuiteInfo => ({
  id,
  file: `suites/${id}.jsonl`,
  cases: splits.map((split, i) => ({ id: `${id}-${i}`, split }) as unknown as CaseV1),
  errors: opts.errors ?? [],
  sha256: "a".repeat(64),
  heldout: opts.heldout ?? splits.includes("heldout"),
});

describe("哪些套件封存", () => {
  it("套件名以 heldout 开头，或者原始行里有标成保留集的题（校验没过也算），都算封存", () => {
    expect(isSealedSuite(suite("heldout", ["heldout"]))).toBe(true);
    expect(isSealedSuite(suite("heldout", [], { errors: ["第 1 行不是合法 JSON"], heldout: false }))).toBe(true);
    expect(isSealedSuite(suite("heldout-2027", ["dev"], { heldout: false }))).toBe(true);
    expect(isSealedSuite(suite("final", [], { errors: ["第 2 行不是合法 JSON"], heldout: true }))).toBe(true);
    expect(isSealedSuite(suite("dev", ["dev", "dev"]))).toBe(false);
    expect(isSealedSuite(suite("smoke", ["smoke"]))).toBe(false);
  });

  it("换个文件名、又有一行坏了的保留集文件：按原始行照样认得出", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "sealed-"));
    try {
      const held = path.join(dir, "final-check.jsonl");
      writeFileSync(held, `${JSON.stringify({ schema_version: "1.0", id: "X-001", split: "heldout" })}\n{这一行坏了\n`, "utf8");
      const plain = path.join(dir, "plain.jsonl");
      writeFileSync(plain, `${JSON.stringify({ schema_version: "1.0", id: "Y-001", split: "dev" })}\n{这一行坏了\n`, "utf8");
      const a = loadSuite(held);
      expect(a.errors.length).toBeGreaterThan(0);
      expect(a.cases.length).toBe(0);
      expect(isSealedSuite(a)).toBe(true);
      expect(isSealedSuite(loadSuite(plain))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("公开的套件不含封存的；封存的只给题数、指纹和出错几处，不给题目", () => {
    const all = [
      suite("dev", ["dev"]),
      suite("heldout", ["heldout", "heldout"]),
      suite("mixed", ["dev", "heldout"]),
      suite("smoke", ["smoke"]),
    ];
    expect(publicSuites(all).map((s) => s.id)).toEqual(["dev", "smoke"]);
    const sealed = sealedSuites(all);
    expect(sealed.map((s) => s.id)).toEqual(["heldout", "mixed"]);
    expect(Object.keys(sealed[0]).sort()).toEqual(["count", "errors", "file", "id", "sha256"]);
    expect(sealed[0].count).toBe(2);
    const isSealed = sealedSuiteMatcher(all);
    expect(["dev", "heldout", "mixed", "smoke", "heldout-old"].map(isSealed)).toEqual([false, true, true, false, true]);
    // 套件文件不在了，名字以 heldout 开头的运行也一直算封存（运行记录里只记套件名）
    expect(["heldout", "heldout-2027", "dev"].map(sealedSuiteMatcher([]))).toEqual([true, true, false]);
    const runs = [
      { config: { suite: "dev" } },
      { config: { suite: "heldout" } },
      { config: { suite: "mixed" } },
      { config: { suite: "smoke" } },
    ];
    expect(publicRuns(runs, isSealed).map((r) => r.config.suite)).toEqual(["dev", "smoke"]);
  });

  it("仓库里的套件：公开的是开发集和冒烟题，保留集封存", () => {
    const all = listSuites();
    expect(publicSuites(all).map((s) => s.id)).toEqual(["dev", "smoke"]);
    const sealed = sealedSuites(all);
    expect(sealed.map((s) => s.id)).toEqual(["heldout"]);
    expect(sealed[0].errors).toBe(0);
    expect(sealed[0].count).toBe(28);
  });
});

describe("状态接口、开始体检", () => {
  it("状态接口不带保留集：没有 heldout 套件、没有保留集的题号", async () => {
    const res = await statusGet(new Request("http://127.0.0.1:3000/api/status"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { suites: { id: string; cases: { id: string }[] }[] };
    expect(body.suites.map((s) => s.id)).toEqual(["dev", "smoke"]);
    const text = JSON.stringify(body);
    expect(/HOLD-\d/.test(text)).toBe(false);
    expect(text.includes('"heldout"')).toBe(false);
  });

  it("网页上不能拿保留集跑：回 403，不建运行（名字以 heldout 开头的也一样）", async () => {
    const isSealed = sealedSuiteMatcher();
    const sealedRuns = () => listRuns().filter((m) => isSealed(m.config.suite)).length;
    const before = sealedRuns();
    for (const name of ["heldout", "heldout-2027"]) {
      const res = await runsPost(
        new Request("http://127.0.0.1:3000/api/runs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ suite: name, include_drafts: true }),
        }),
      );
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("保留集是封存的，网页上不能跑");
    }
    expect(sealedRuns()).toBe(before);
  });
});

describe("保留集的运行记录在网页接口上当作不存在", () => {
  // 在单元测试的运行目录（data/runs-unit）里放几条假的运行记录，只有清单：一条保留集、一条改了名的保留集、一条开发集（对照）。
  // 清单都按攻防地图能收的样子写（跑完、S2、B2、默认角色），没有封存就会上地图。
  const dir = path.join(process.cwd(), "data", "runs-unit");
  const sealedId = "zz-sealed-test-heldout";
  const renamedId = "zz-sealed-test-renamed";
  const openId = "zz-sealed-test-dev";
  const missingId = "zz-sealed-test-missing";
  const manifest = (run_id: string, suiteId: string) => ({
    schema_version: "1.0",
    run_id,
    created_at: "2026-11-15T00:00:00.000Z",
    state: "completed",
    config: {
      suite: suiteId,
      variant: "B2",
      policy: "S2",
      judge_rag: true,
      max_turns: 1,
      max_cases: 1,
      max_llm_calls: 10,
      include_drafts: false,
      voice: false,
    },
    data_level: "simulation",
    preview: false,
    models: {},
    hashes: {},
    canary_hash: "",
    counts: {
      planned: 0,
      completed: 0,
      provider_blocked: 0,
      error: 0,
      cancelled: 0,
      not_run: 0,
      pass: 0,
      fail: 0,
      uncertain: 0,
      not_applicable: 0,
    },
    usage: {},
    started_at: "2026-11-15T00:00:00.000Z",
    finished_at: "2026-11-15T00:00:01.000Z",
  });
  const seed = (id: string, text: string) => {
    mkdirSync(path.join(dir, id), { recursive: true });
    writeFileSync(path.join(dir, id, "manifest.json"), text, "utf8");
  };
  beforeAll(() => {
    seed(sealedId, JSON.stringify(manifest(sealedId, "heldout")));
    seed(renamedId, JSON.stringify(manifest(renamedId, "heldout-old")));
    seed(openId, JSON.stringify(manifest(openId, "dev")));
  });
  afterAll(() => {
    for (const id of [sealedId, renamedId, openId, "zz-sealed-test-corrupt"]) rmSync(path.join(dir, id), { recursive: true, force: true });
  });

  const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) }) as never;
  const at = (p: string, init?: RequestInit) => new Request(`http://127.0.0.1:3000${p}`, init);
  const post = (p: string, body: unknown) =>
    at(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const shape = async (res: Response) => ({ status: res.status, body: await res.text() });
  /** 每个按编号取运行的接口：拿这个编号去请求 */
  const byId: Record<string, (id: string) => Promise<Response>> = {
    取运行: (id) => runGet(at(`/api/runs/${id}`), ctx({ id })),
    实时事件: (id) => eventsGet(at(`/api/runs/${id}/events`), ctx({ id })),
    音频: (id) => audioGet(at(`/api/runs/${id}/audio?u=x`), ctx({ id })),
    播放上报: (id) => playbackPost(post(`/api/runs/${id}/playback`, { turn_id: "t", utterances: [] }), ctx({ id })),
    复核: (id) => reviewPost(post(`/api/runs/${id}/review`, { finding_id: "f", decision: "confirm" }), ctx({ id })),
    暂停: (id) => actionPost(post(`/api/runs/${id}/pause`, {}), ctx({ id, action: "pause" })),
    继续: (id) => actionPost(post(`/api/runs/${id}/resume`, {}), ctx({ id, action: "resume" })),
    终止: (id) => actionPost(post(`/api/runs/${id}/cancel`, {}), ctx({ id, action: "cancel" })),
    对比在后: (id) => compareGet(at(`/api/compare?a=${openId}&b=${id}`)),
    对比在前: (id) => compareGet(at(`/api/compare?a=${id}&b=${openId}`)),
  };

  it("认得出哪条是保留集的运行；没有这次运行、编号不合法都不算", () => {
    expect(isSealedRun(sealedId)).toBe(true);
    expect(isSealedRun(renamedId)).toBe(true);
    expect(isSealedRun(openId)).toBe(false);
    expect(isSealedRun(missingId)).toBe(false);
    expect(isSealedRun("../runs")).toBe(false);
    expect(sealedRunResponse(openId)).toBeNull();
  });

  it("清单读不出来（写到一半、坏了）按封存挡，回的和没有这次运行一样", async () => {
    const corruptId = "zz-sealed-test-corrupt";
    seed(corruptId, '{"run_id": "zz-sealed-test-corrupt", "config": {"sui');
    try {
      expect(runSuite(corruptId)).toBeNull();
      expect(isSealedRun(corruptId)).toBe(true);
      expect(await shape(await byId.取运行(corruptId))).toEqual(await shape(await byId.取运行(missingId)));
    } finally {
      rmSync(path.join(dir, corruptId), { recursive: true, force: true });
    }
  });

  it("正在跑的运行（在内存里）按内存里的清单认套件", () => {
    const m = createRun({
      suite: "smoke",
      case_ids: ["SMOKE_CANARY_001"],
      variant: "B2",
      policy: "S2",
      judge_rag: false,
      max_turns: 1,
      max_cases: 1,
      max_llm_calls: 5,
      include_drafts: true,
      voice: false,
    });
    // 删掉磁盘上的目录，还能认出来：说明走的是内存
    rmSync(path.join(dir, m.run_id), { recursive: true, force: true });
    expect(runSuite(m.run_id)).toBe("smoke");
    expect(isSealedRun(m.run_id)).toBe(false);
  });

  it("每个按编号取的接口：保留集的编号和不存在的编号回的一模一样；开发集的照常", async () => {
    for (const [name, call] of Object.entries(byId)) {
      for (const id of [sealedId, renamedId]) {
        expect({ name, ...(await shape(await call(id))) }).toEqual({ name, ...(await shape(await call(missingId))) });
      }
    }
    expect((await byId.取运行(openId)).status).toBe(200);
    expect((await byId.取运行(sealedId)).status).toBe(404);
  });

  it("运行记录列表、攻防地图里没有它，开发集的那条在", async () => {
    const ids = ((await (await runsGet(at("/api/runs"))).json()) as { run_id: string }[]).map((m) => m.run_id);
    expect([sealedId, renamedId, openId].map((id) => ids.includes(id))).toEqual([false, false, true]);
    const onMap = mapRuns().map((m) => m.run_id);
    expect([sealedId, renamedId, openId].map((id) => onMap.includes(id))).toEqual([false, false, true]);
  });
});
