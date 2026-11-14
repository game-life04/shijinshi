// 先审还是先播（/fates，ADR-049）：卡片上「最快」「最慢」两个记号怎么标。单独放一个文件，单元测试不用拉起整个页面。

/** 最快要比第二快早出这么多、最慢要比第二慢晚出这么多，才标（毫秒） */
export const RANK_MIN_GAP_MS = 500;

export type Rank = "fast" | "slow" | null;

/**
 * 三遍的「开口要等」（按卡片次序，没跑完的是 undefined）→ 每张卡标不标「最快」「最慢」。都按这一次的数算，规则是：
 * - 三遍都有数才标；
 * - 这一次的护栏固定延迟是 0（或不知道）时不标。这时护栏几乎不花时间，这一页要比的「等不等审完」看不出来，
 *   页面又总是先播 ①、不预热，标了反倒误导：11-10 真实实验 0 ms 的三次里，先播后截都是开口最慢的，一次差了 1.7 秒
 *   （2581 / 876 / 1098 毫秒，docs/evidence/experiments/voice-1110/e2-delay0-summary.json）；
 * - 最快要比第二快早出 RANK_MIN_GAP_MS 以上，最慢要比第二慢晚出这么多，才标；两遍只差几十毫秒时不分高下
 *   （ADR-025：差这么点，换个次序就可能反过来）。原来只看「最快和最慢差不到半秒就不标」，模拟发声下
 *   先审后播和边审边合成常常只差几十毫秒，就会给其中一个（有时是默认的边审边合成）标上「最慢」。
 */
export function rankFirsts(firsts: readonly (number | undefined)[], delay: number | undefined): Rank[] {
  const none = firsts.map((): Rank => null);
  const known = firsts.filter((x): x is number => x !== undefined && Number.isFinite(x));
  if (!delay || known.length < 3 || known.length !== firsts.length) return none;
  const s = [...known].sort((x, y) => x - y);
  const lo = s[0];
  const hi = s[s.length - 1];
  const fast = s[1] - lo >= RANK_MIN_GAP_MS;
  const slow = hi - s[s.length - 2] >= RANK_MIN_GAP_MS;
  return firsts.map((x): Rank => (fast && x === lo ? "fast" : slow && x === hi ? "slow" : null));
}

/**
 * 边审边合成那张卡上和先审后播比开口（ADR-049 深度测试：护栏 0 毫秒时原来照样写「早 12 毫秒」「晚 17 毫秒」，方向随机翻）：
 * - 护栏延迟是 0（或不知道）：不比，说「差不多」——这时页面自己说看不出差别；
 * - 延迟大于 0：照写这一次早 / 晚多少。这时的差别是机制带来的（审的同时备好声音，省下合成那一段），
 *   模拟里稳定早 140～180 毫秒、真实实验 4 秒的中位早约 0.3 秒，都不到「最快 / 最慢」的半秒门槛，不能一起藏掉。
 */
export function versusS1(first: number, s1: number, delay: number | undefined): { kind: "same" } | { kind: "early" | "late"; ms: number } {
  const d = s1 - first;
  if (!delay) return { kind: "same" };
  return d >= 0 ? { kind: "early", ms: d } : { kind: "late", ms: -d };
}
