// 攻防地图的数据（ADR-038）：从已经跑完的运行记录里挑出能放在一起比的，交给 lib/domain/attack-map.ts 去数。不调用模型。
// 能放在一起的：跑完了、默认角色（没带自己的人设）、放行方式是默认的边审边合成（S2）、没加护栏固定延迟（三种结局那种实验设定）、
// 套件还在 suites/ 里（临时试验用的套件不列）。再按套件、被测配置、数据等级（真实模型 / 模拟）分开：不同的不混在一起算。
// 默认只看每个配置最近的一次：代码一直在改（比如 11-08 修了退出的说法），不同时候跑的混在一起，看不出现在的样子；要合并全部可以选。

import { existsSync } from "node:fs";
import path from "node:path";
import { type AttackMap, buildAttackMap, type MapLayer } from "../domain/attack-map";
import { type DataLevel, GUARDED_VARIANTS, type RunManifest, type SubjectVariant } from "../domain/types";
import { getRun, listRuns } from "./runs";
import { publicRuns } from "./sealed";
import { loadStrategies } from "./tester";

export const MAP_VARIANTS: SubjectVariant[] = ["B0", "B1", "B2"];

export interface MapQuery {
  suite: string;
  variant: SubjectVariant;
  level: DataLevel;
  layer: MapLayer;
  /** true：合并这个配置跑过的全部；默认只看最近一次 */
  all?: boolean;
}

/** 能画进地图的运行（新的在前，listRuns 已按时间排好） */
export function mapRuns(): RunManifest[] {
  const suiteExists = new Map<string, boolean>();
  const known = (s: string) => {
    if (!suiteExists.has(s)) suiteExists.set(s, existsSync(path.join(process.cwd(), "suites", `${s}.jsonl`)));
    return suiteExists.get(s);
  };
  // 封存的保留集运行不上地图（ADR-050）
  return publicRuns(listRuns()).filter(
    (m) =>
      m.state === "completed" &&
      !m.config.persona &&
      m.config.policy === "S2" &&
      !m.config.guard_delay_ms &&
      MAP_VARIANTS.includes(m.config.variant) &&
      known(m.config.suite),
  );
}

export function attackMap(q: MapQuery, runs: RunManifest[] = mapRuns()): { runs: RunManifest[]; available: number; map: AttackMap } {
  const same = runs
    .filter((m) => m.config.suite === q.suite && m.config.variant === q.variant && m.data_level === q.level)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const picked = q.all ? same : same.slice(0, 1);
  const guarded = GUARDED_VARIANTS.includes(q.variant);
  const prompt = q.variant === "B1" || q.variant === "B2";
  // no：体检单里是第几例（和体检单页面的编号一致：按结果顺序从 1 数）
  const items = picked.flatMap((m) =>
    (getRun(m.run_id)?.results ?? []).map((result, i) => ({ result, guarded, prompt, run_id: m.run_id, no: i + 1 })),
  );
  const strategies = loadStrategies().map((s) => ({ id: s.id, title: s.title, families: s.families }));
  return { runs: picked, available: same.length, map: buildAttackMap(items, strategies, q.layer) };
}
