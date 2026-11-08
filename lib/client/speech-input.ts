"use client";

// 对着麦克风套话（ADR-037，借 AIRI、Open-LLM-VTuber 的语音对话）：用浏览器自带的语音识别（Web Speech API），说一句，认出来就发。
// 识别由浏览器做：Edge、Chrome 会把声音发到它们自己的识别服务；分寸这边不录音、不存音频，只收到认出来的文字。
// 不支持的浏览器（比如 Firefox）按钮是灰的，照样能打字。端到端测试在页面里换一个假的识别器（e2e/play-voice.spec.ts）。

import { useCallback, useEffect, useRef, useState } from "react";

interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((e: RecognitionEvent) => void) | null;
  onspeechstart: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

function ctor(): RecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

const ERRORS: Record<string, string> = {
  "not-allowed": "没有麦克风权限：在浏览器地址栏左边的图标里允许使用麦克风",
  "service-not-allowed": "浏览器不让用语音识别（可能是隐私设置），先打字吧",
  "no-speech": "没听到声音，再说一遍？",
  "audio-capture": "找不到麦克风",
  network: "语音识别要联网（浏览器把声音发到它的识别服务），网络不通",
};

/**
 * 一次说一句：start() 开始听，认出最后结果就交给 onFinal；听的过程中的半截结果交给 onInterim（显示在输入框里）。
 * onSpeechStart：一开口就回调（她正在说话的话，页面在这里把她打断）。
 */
export function useSpeechInput(o: { onFinal: (text: string) => void; onInterim?: (text: string) => void; onSpeechStart?: () => void }) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const cb = useRef(o);
  cb.current = o;

  useEffect(() => setSupported(Boolean(ctor())), []);
  useEffect(() => () => rec.current?.abort(), []);

  const start = useCallback(() => {
    const C = ctor();
    if (!C || rec.current) return;
    setError(null);
    const r = new C();
    r.lang = "zh-CN";
    r.interimResults = true;
    r.continuous = false;
    r.maxAlternatives = 1;
    let finalText = "";
    let spoke = false;
    const heard = () => {
      if (spoke) return;
      spoke = true;
      cb.current.onSpeechStart?.();
    };
    r.onspeechstart = heard;
    r.onresult = (e) => {
      heard();
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      cb.current.onInterim?.(finalText + interim);
    };
    r.onerror = (e) => setError(ERRORS[e.error] ?? `语音识别出错（${e.error}）`);
    r.onend = () => {
      rec.current = null;
      setListening(false);
      const t = finalText.trim();
      if (t) cb.current.onFinal(t);
    };
    rec.current = r;
    setListening(true);
    try {
      r.start();
    } catch (e) {
      rec.current = null;
      setListening(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const stop = useCallback(() => rec.current?.stop(), []);

  return { supported, listening, error, start, stop };
}
