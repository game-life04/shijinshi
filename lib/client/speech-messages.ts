// 「说」出错时给用户看的话（ADR-051、ADR-053 复查、ADR-054）：写清是哪里不行、能怎么办；不露英文代码。

/** 浏览器自带识别的错误码 → 人话 */
export const ERRORS: Record<string, string> = {
  "not-allowed": "没有麦克风权限：在浏览器地址栏左边的图标里允许使用麦克风",
  "service-not-allowed": "这个浏览器不让用语音识别（隐私设置，或者它本来就不带这个功能）：换 Edge 浏览器试试，或者直接打字",
  "no-speech": "没听到声音，再说一遍？",
  "audio-capture": "找不到麦克风：看看麦克风有没有插好、有没有被别的软件占着",
  // ADR-053 复查：原来只写「网络不通」。浏览器是把声音发到它自己的识别服务去认的，Chrome 用的是谷歌的服务，国内常连不上，
  // 这时候网页和别的功能都是通的，用户看到「网络不通」会以为是自己断网了
  network: "语音识别服务连不上：声音要发到浏览器自己的识别服务，Chrome 用的是谷歌的，国内常连不上。换 Edge 浏览器打开，或者直接打字",
};

/** 录一整段发到服务器转文字（ADR-054）时的几种情况 */
export const RECORD_ERRORS = {
  busy: "麦克风被别的软件占着：关掉别的在用麦克风的软件，再说一次，或者直接打字",
  unclear: "没听清你说的话，再说一遍？",
  upload: "语音转文字这会儿没连上：再说一次，或者直接打字",
  open: "打不开麦克风：换 Edge 浏览器试试，或者直接打字",
  load: "打不开录音：网络不好或者登录过期了，刷新页面再试，或者直接打字",
};

/** 再说一次可能就好的（没听到、没听清、一时没连上）；麦克风权限、浏览器不支持这些再点也是一样的错 */
export function retryable(message: string | null): boolean {
  if (!message) return false;
  return (
    message === ERRORS["no-speech"] ||
    message === RECORD_ERRORS.unclear ||
    message === RECORD_ERRORS.upload ||
    message.startsWith("语音转文字这会儿")
  );
}
