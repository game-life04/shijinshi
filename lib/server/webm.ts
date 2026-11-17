// 认浏览器录的 WebM（Opus）（ADR-054 后续，11-17）：页面把「说」的那一段压成 Opus 再传，30 秒约 120 KB（WAV 约 0.96 MB），
// 传到服务器、再转交阿里云百炼都快很多。服务端不解码，只把 WebM 里的音频包数一遍：每个 Opus 包的第一个字节写着这一包有几帧、
// 每帧多长，加起来就是这段录音有多长（解码器也是这样算的），用来卡「一次最多 30 秒」。不看容器里写的时间：那个可以随便写。
// 认不出（不是 WebM、不是 Opus、块里打了包、结构坏了）一律当格式不对，页面会改传 WAV。

const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const CLUSTER = 0x1f43b675;
const TRACKS = 0x1654ae6b;
const BLOCK_GROUP = 0xa0;
const BLOCK = 0xa1;
const SIMPLE_BLOCK = 0xa3;
/** 这几种只是装别的东西的外壳：往里看，不按长度跳过（浏览器边录边写，外壳的长度常写成「不知道」） */
const CONTAINERS = new Set([SEGMENT, CLUSTER, BLOCK_GROUP]);

/** 看开头几个字节认是 WebM（EBML 头） */
export function looksWebm(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
}

/** EBML 的编号：第一个字节前面有几个 0，就再多几个字节（最多 4 个字节），标记位留着 */
function readId(b: Uint8Array, at: number): { id: number; len: number } | null {
  const first = b[at];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (len <= 4 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 4 || at + len > b.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) id = id * 256 + b[at + i];
  return { id, len };
}

/** EBML 的长度：同样的写法，去掉标记位；全是 1 表示「不知道多长」（返回 -1） */
function readSize(b: Uint8Array, at: number): { size: number; len: number } | null {
  const first = b[at];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || at + len > b.length) return null;
  const mask = (0x80 >> (len - 1)) - 1;
  let v = first & mask;
  let ones = v === mask;
  for (let i = 1; i < len; i++) {
    v = v * 256 + b[at + i];
    if (b[at + i] !== 0xff) ones = false;
  }
  return { size: ones ? -1 : v, len };
}

function has(b: Uint8Array, from: number, to: number, word: string): boolean {
  return Buffer.from(b.subarray(from, to)).includes(word, 0, "latin1");
}

/** 一个 Opus 包有多长（毫秒）：看第一个字节（TOC）里的配置号和帧数（RFC 6716 第 3.1 节） */
export function opusPacketMs(b: Uint8Array, at: number, end: number): number | null {
  if (at >= end) return null;
  const toc = b[at];
  const config = toc >> 3;
  const frameMs = config < 12 ? [10, 20, 40, 60][config & 3] : config < 16 ? [10, 20][config & 1] : [2.5, 5, 10, 20][config & 3];
  const code = toc & 3;
  const frames = code === 0 ? 1 : code === 3 ? (at + 1 < end ? b[at + 1] & 0x3f : 0) : 2;
  const ms = frames * frameMs;
  // 一个包最长 120 毫秒（RFC 6716），超了就不是正常的包
  return frames > 0 && ms <= 120 ? ms : null;
}

/** 一个块里的 Opus 包有多长：块头是轨道号、2 字节时间、1 字节标记；打了包（一块装几帧）的不认 */
function blockMs(b: Uint8Array, at: number, end: number): number | null {
  const track = readSize(b, at);
  if (!track || track.size < 0) return null;
  const head = at + track.len + 3;
  if (head >= end) return null;
  if (b[head - 1] & 0x06) return null;
  return opusPacketMs(b, head, end);
}

/**
 * WebM（Opus）录音有多少秒；认不出返回 null。
 * 开头要是 EBML 头、文档类型是 webm，轨道信息里要有 Opus，后面的块逐个数。
 */
export function webmOpusSeconds(b: Uint8Array): number | null {
  if (!looksWebm(b)) return null;
  let at = 0;
  let ms = 0;
  let opus = false;
  let blocks = 0;
  while (at < b.length) {
    const id = readId(b, at);
    if (!id) return null;
    const sz = readSize(b, at + id.len);
    if (!sz) return null;
    const body = at + id.len + sz.len;
    if (CONTAINERS.has(id.id)) {
      at = body;
      continue;
    }
    if (sz.size < 0) return null;
    const end = body + sz.size;
    if (end > b.length) return null;
    if (id.id === EBML) {
      if (at !== 0 || !has(b, body, end, "webm")) return null;
    } else if (id.id === TRACKS) {
      if (has(b, body, end, "A_OPUS")) opus = true;
    } else if (id.id === SIMPLE_BLOCK || id.id === BLOCK) {
      const d = blockMs(b, body, end);
      if (d === null) return null;
      ms += d;
      blocks++;
    }
    at = end;
  }
  return opus && blocks > 0 ? ms / 1000 : null;
}
