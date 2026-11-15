// 保留集在网页上封存（ADR-050，11-15 队长「要改」）。
// 原来（ADR-044 导入保留集以后）：/api/status 把整套用例连同保留集 28 题的原文、期望一起发给登录的人（工作台、闯关页一打开就取），
// 用例库页面整张表列出来，工作台的套件下拉里也能选它来跑。现在：
// - 状态接口、用例库只给公开的套件；封存的套件在用例库只写一行：题数、指纹、校验结果，不给题目；
// - 网页上不能拿封存的套件跑体检；
// - 封存套件的运行记录（命令行正式实验留下的）在网页和接口上都当作不存在：列表、攻防地图里没有；
//   按编号取（体检单、前后对比、/api/runs/<编号>、实时事件、复核、/api/compare）回的和真没有这次运行一模一样，猜不出哪个编号是保留集的。
//   暂停 / 继续 / 终止、取音频、播放上报只认这台网站进程内存里正在跑的运行，网站又建不出封存的运行，这几个本来就和「没有这次运行」一样，不另加（加了反倒回得不一样）。
// 命令行的正式实验、重判、汇总（scripts/experiments.ts、rejudge.ts 等）直接用 lib/server/runs.ts，不经过这里，照常能用。

import { isSealedSuite, isSealedSuiteName, listSuites, type SuiteInfo } from "../domain/cases";
import type { RunManifest } from "../domain/types";
import { runSuite } from "./runs";

/** 没有这次运行时各处回的那句（和 lib/server/runs.ts 里找不到运行时的说法一致） */
export const NO_SUCH_RUN = "运行不存在";

/** 公开的套件：工作台、用例库、状态接口只用这些 */
export function publicSuites(all: SuiteInfo[] = listSuites()): SuiteInfo[] {
  return all.filter((s) => !isSealedSuite(s));
}

/** 封存的套件：只给套件名、文件、题数、指纹和校验出错几处（出错说明里有题号，也不给） */
export function sealedSuites(
  all: SuiteInfo[] = listSuites(),
): { id: string; file: string; count: number; sha256: string; errors: number }[] {
  return all
    .filter(isSealedSuite)
    .map((s) => ({ id: s.id, file: s.file, count: s.cases.length, sha256: s.sha256, errors: s.errors.length }));
}

/** 按套件名判断是不是封存的（运行记录里只记套件名）：名字以 heldout 开头的，加上现在套件文件里标了保留集的 */
export function sealedSuiteMatcher(all: SuiteInfo[] = listSuites()): (suite: string) => boolean {
  const ids = new Set(all.filter(isSealedSuite).map((s) => s.id));
  return (suite) => isSealedSuiteName(suite) || ids.has(suite);
}

/** 这次运行是不是拿封存的套件跑的。没有这次运行不算（交给原来的「运行不存在」）；清单读不出套件名的算（宁可多挡） */
export function isSealedRun(id: string, isSealed: (suite: string) => boolean = sealedSuiteMatcher()): boolean {
  const suite = runSuite(id);
  if (suite === undefined) return false;
  return suite === null || isSealed(suite);
}

/** 运行记录列表：去掉封存套件的 */
export function publicRuns<T extends { config: Pick<RunManifest["config"], "suite"> }>(
  runs: T[],
  isSealed: (suite: string) => boolean = sealedSuiteMatcher(),
): T[] {
  return runs.filter((m) => !isSealed(m.config.suite));
}

/** 按编号取运行、没有时回 404「运行不存在」的接口先过这一道：封存的运行回同一个 404 */
export function sealedRunResponse(id: string): Response | null {
  return isSealedRun(id) ? Response.json({ error: NO_SUCH_RUN }, { status: 404 }) : null;
}
