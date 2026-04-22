import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { hanaFetch } from './use-hana-fetch';

export type PushToTalkState = 'idle' | 'warming' | 'recording' | 'processing';

type KeyLikeEvent = {
  key: string;
  repeat?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  preventDefault: () => void;
  stopPropagation?: () => void;
};

type UsePushToTalkOptions = {
  enabled?: boolean;
  language?: string;
  onActivate?: () => void;
  onInterimTranscript?: (text: string) => void;
  onTranscript?: (text: string) => void;
  onError?: (message: string) => void;
};

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort?: () => void;
};

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

const HOLD_REPEAT_THRESHOLD = 2;
const TRANSCRIBE_TIMEOUT_MS = 60_000;

function isSpaceKey(key: string): boolean {
  return key === ' ' || key === 'Space' || key === 'Spacebar';
}

function stripLocaleToIso639(rawLanguage: string | undefined): string {
  const text = String(rawLanguage || '').trim();
  if (!text) return '';
  const lower = text.toLowerCase();
  const first = lower.split(/[-_]/)[0];
  return first || lower;
}

function isPushToTalkSupported(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  if (!navigator.mediaDevices?.getUserMedia) return false;
  return typeof window.MediaRecorder !== 'undefined';
}

function resolveSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  return typeof ctor === 'function' ? ctor as SpeechRecognitionCtor : null;
}

function pickRecorderMimeType(): string {
  if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined') {
    return 'audio/webm';
  }
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/mpeg',
  ];
  for (const type of candidates) {
    try {
      if (window.MediaRecorder.isTypeSupported(type)) return type;
    } catch {
      // ignore
    }
  }
  return 'audio/webm';
}

async function blobToBase64(blob: Blob): Promise<string> {
  const arr = new Uint8Array(await blob.arrayBuffer());
  if (arr.length === 0) return '';
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < arr.length; i += chunkSize) {
    const part = arr.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...part);
  }
  return window.btoa(binary);
}

export function usePushToTalk({
  enabled = true,
  language,
  onActivate,
  onInterimTranscript,
  onTranscript,
  onError,
}: UsePushToTalkOptions) {
  const supported = useMemo(() => isPushToTalkSupported(), []);
  const speechRecognitionCtor = useMemo(() => resolveSpeechRecognitionCtor(), []);
  const [state, setState] = useState<PushToTalkState>('idle');
  const [error, setError] = useState<string | null>(null);

  const holdRef = useRef({
    isDown: false,
    repeatCount: 0,
    activated: false,
  });
  const sessionRef = useRef(0);
  const stopRequestedRef = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const transcribingRef = useRef(false);
  const speechRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const speechFallbackTranscriptRef = useRef('');

  const clearError = useCallback(() => setError(null), []);

  const emitError = useCallback((message: string) => {
    const text = String(message || '').trim();
    if (!text) return;
    setError(text);
    onError?.(text);
  }, [onError]);

  const cleanupStream = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      streamRef.current = null;
    }
  }, []);

  const stopSpeechRecognition = useCallback(() => {
    const recognition = speechRecognitionRef.current;
    if (!recognition) return;
    speechRecognitionRef.current = null;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    try {
      recognition.stop();
    } catch {
      try {
        recognition.abort?.();
      } catch {
        // ignore
      }
    }
  }, []);

  const startSpeechRecognition = useCallback((sessionId: number) => {
    if (!speechRecognitionCtor) return;
    stopSpeechRecognition();

    let recognition: SpeechRecognitionLike;
    try {
      recognition = new speechRecognitionCtor();
    } catch {
      return;
    }

    recognition.lang = String(language || navigator.language || '').trim() || 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: any) => {
      if (sessionRef.current !== sessionId) return;
      const results = event?.results;
      if (!results || typeof results.length !== 'number') return;

      const finals: string[] = [];
      const interim: string[] = [];
      for (let i = 0; i < results.length; i += 1) {
        const result = results[i];
        const transcript = String(result?.[0]?.transcript || '').trim();
        if (!transcript) continue;
        if (result?.isFinal) finals.push(transcript);
        else interim.push(transcript);
      }
      const combined = [...finals, ...interim].join(' ').trim();
      if (!combined) return;
      speechFallbackTranscriptRef.current = combined;
      onInterimTranscript?.(combined);
    };

    recognition.onerror = () => {
      // Web Speech 仅用于实时中间结果，失败时静默退化到后端转写。
    };
    recognition.onend = () => {
      if (speechRecognitionRef.current === recognition) {
        speechRecognitionRef.current = null;
      }
    };

    try {
      recognition.start();
      speechRecognitionRef.current = recognition;
    } catch {
      speechRecognitionRef.current = null;
    }
  }, [language, onInterimTranscript, speechRecognitionCtor, stopSpeechRecognition]);

  const stopRecording = useCallback(async () => {
    if (transcribingRef.current) return;
    const speechFallback = speechFallbackTranscriptRef.current.trim();
    stopSpeechRecognition();

    const recorder = recorderRef.current;
    if (!recorder) {
      cleanupStream();
      if (speechFallback) onTranscript?.(speechFallback);
      setState('idle');
      return;
    }

    setState('processing');
    let stopped = Promise.resolve();
    if (recorder.state !== 'inactive') {
      stopped = new Promise<void>((resolve) => {
        recorder.addEventListener('stop', () => resolve(), { once: true });
        try {
          recorder.stop();
        } catch {
          resolve();
        }
      });
    }

    await stopped;

    const mimeType = recorder.mimeType || pickRecorderMimeType();
    const blob = new Blob(chunksRef.current, { type: mimeType || 'audio/webm' });
    recorderRef.current = null;
    chunksRef.current = [];
    cleanupStream();

    if (!blob.size) {
      if (speechFallback) onTranscript?.(speechFallback);
      setState('idle');
      return;
    }

    transcribingRef.current = true;
    try {
      const audioBase64 = await blobToBase64(blob);
      if (!audioBase64) {
        setState('idle');
        return;
      }
      const lang = stripLocaleToIso639(language);
      const res = await hanaFetch('/api/voice/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioBase64,
          mimeType: blob.type || mimeType || 'audio/webm',
          language: lang || undefined,
        }),
        timeout: TRANSCRIBE_TIMEOUT_MS,
      });
      const data = await res.json().catch(() => ({} as Record<string, unknown>));
      const text = String((data as any)?.text || '').trim();
      if (text) {
        onTranscript?.(text);
      } else if (speechFallback) {
        onTranscript?.(speechFallback);
      } else {
        emitError('NO_SPEECH');
      }
    } catch (err) {
      if (speechFallback) {
        onTranscript?.(speechFallback);
      } else {
        emitError(String((err as any)?.message || err || 'Voice transcription failed'));
      }
    } finally {
      transcribingRef.current = false;
      setState('idle');
    }
  }, [cleanupStream, emitError, language, onTranscript, stopSpeechRecognition]);

  const startRecording = useCallback(async () => {
    if (!enabled || !supported || transcribingRef.current) return;

    const mySession = ++sessionRef.current;
    stopRequestedRef.current = false;
    speechFallbackTranscriptRef.current = '';
    onInterimTranscript?.('');
    setError(null);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      if (sessionRef.current !== mySession) return;
      setState('idle');
      emitError('MIC_PERMISSION_DENIED');
      return;
    }

    if (sessionRef.current !== mySession || !holdRef.current.activated) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // ignore
        }
      }
      return;
    }

    const mimeType = pickRecorderMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    streamRef.current = stream;
    recorderRef.current = recorder;
    chunksRef.current = [];

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunksRef.current.push(event.data);
      }
    };
    recorder.onerror = () => {
      emitError('VOICE_RECORDER_ERROR');
    };

    try {
      recorder.start(180);
      setState('recording');
      startSpeechRecognition(mySession);
      if (stopRequestedRef.current || !holdRef.current.isDown) {
        await stopRecording();
      }
    } catch {
      recorderRef.current = null;
      chunksRef.current = [];
      cleanupStream();
      setState('idle');
      emitError('VOICE_RECORDER_ERROR');
    }
  }, [cleanupStream, emitError, enabled, onInterimTranscript, startSpeechRecognition, stopRecording, supported]);

  const handleKeyDown = useCallback((e: KeyLikeEvent): boolean => {
    if (!enabled || !supported) return false;
    if (!isSpaceKey(e.key)) return false;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;

    if (state === 'processing') {
      e.preventDefault();
      e.stopPropagation?.();
      return true;
    }

    if (!holdRef.current.isDown) {
      holdRef.current.isDown = true;
      holdRef.current.repeatCount = 0;
      holdRef.current.activated = false;
      // 首次按下允许透传，短按空格可正常输入。
      return false;
    }

    if (holdRef.current.activated || state === 'recording') {
      e.preventDefault();
      e.stopPropagation?.();
      return true;
    }

    if (e.repeat) {
      holdRef.current.repeatCount += 1;
      e.preventDefault();
      e.stopPropagation?.();
      if (state === 'idle') setState('warming');
      if (!holdRef.current.activated && holdRef.current.repeatCount >= HOLD_REPEAT_THRESHOLD) {
        holdRef.current.activated = true;
        onActivate?.();
        void startRecording();
      }
      return true;
    }

    return false;
  }, [enabled, onActivate, startRecording, state, supported]);

  const handleKeyUp = useCallback((e: KeyLikeEvent): boolean => {
    if (!enabled || !supported) return false;
    if (!isSpaceKey(e.key)) return false;
    if (!holdRef.current.isDown) return false;

    const hadActivation = holdRef.current.activated;
    holdRef.current.isDown = false;
    holdRef.current.repeatCount = 0;
    holdRef.current.activated = false;

    if (state === 'warming' && !hadActivation) {
      setState('idle');
      return false;
    }

    if (!hadActivation && state !== 'recording') {
      return false;
    }

    stopRequestedRef.current = true;
    e.preventDefault();
    e.stopPropagation?.();

    if (state === 'recording') {
      void stopRecording();
      return true;
    }

    if (state === 'warming') {
      // 录音还没真正开始就松开，终止这一轮启动。
      sessionRef.current += 1;
      if (recorderRef.current) {
        void stopRecording();
      } else {
        setState('idle');
      }
      return true;
    }

    return true;
  }, [enabled, state, stopRecording, supported]);

  useEffect(() => {
    return () => {
      sessionRef.current += 1;
      stopSpeechRecognition();
      try {
        recorderRef.current?.stop();
      } catch {
        // ignore
      }
      recorderRef.current = null;
      chunksRef.current = [];
      cleanupStream();
    };
  }, [cleanupStream, stopSpeechRecognition]);

  return {
    supported,
    state,
    error,
    clearError,
    handleKeyDown,
    handleKeyUp,
  };
}
