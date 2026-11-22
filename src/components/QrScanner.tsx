"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, X } from "lucide-react";
import { Button } from "./ui";

interface Detector {
  detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]>;
}

const TOKEN = /\/s\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * 좌석 QR 스캐너.
 * 브라우저가 QR 인식을 지원하면 그것을 쓰고(안드로이드 크롬), 지원하지 않으면(아이폰 사파리 등)
 * 카메라 화면을 직접 읽어 해석한다. 카메라 자체를 쓸 수 없을 때만 기본 카메라 앱 사용을 안내한다.
 */
export function QrScanner({ onToken, onClose }: { onToken: (token: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  // 부모 화면이 매초 다시 그려져도 카메라를 껐다 켜지 않도록 콜백은 ref 로 들고 있는다
  const cb = useRef(onToken);
  useEffect(() => {
    cb.current = onToken;
  }, [onToken]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setProblem("이 브라우저에서는 카메라를 쓸 수 없습니다. 사파리나 크롬에서 열거나, 휴대폰 기본 카메라 앱으로 좌석의 QR을 비춰 주세요.");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false });
      } catch (e) {
        const name = (e as DOMException).name;
        setProblem(
          name === "NotAllowedError"
            ? "카메라 권한이 꺼져 있습니다. 주소창 옆 설정에서 이 사이트의 카메라를 허용한 뒤 다시 눌러 주세요. 또는 기본 카메라 앱으로 좌석의 QR을 비춰도 됩니다."
            : "카메라를 찾지 못했습니다. 휴대폰 기본 카메라 앱으로 좌석의 QR을 비춰 주세요.",
        );
        return;
      }
      const el = video.current;
      if (stop || !el) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      el.srcObject = stream;
      try {
        await el.play();
      } catch {}
      setReady(true);

      const Ctor = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
      let detector: Detector | null = null;
      try {
        detector = Ctor ? new Ctor({ formats: ["qr_code"] }) : null;
      } catch {}
      // 지원하지 않는 브라우저용 해석기는 필요할 때만 불러온다
      const jsQR = detector ? null : (await import("jsqr")).default;
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });

      const found = (text: string | undefined) => {
        const m = text?.match(TOKEN);
        if (!m) return false;
        stop = true;
        navigator.vibrate?.(60);
        cb.current(m[1]);
        return true;
      };

      const loop = async () => {
        if (stop || !video.current) return;
        const v = video.current;
        if (v.readyState >= 2 && v.videoWidth > 0) {
          try {
            if (detector) {
              const codes = await detector.detect(v);
              if (codes.some((c) => found(c.rawValue))) return;
            } else if (jsQR && ctx) {
              // 가운데 정사각형만 읽어 빠르게 해석
              const side = Math.min(v.videoWidth, v.videoHeight);
              const size = Math.min(640, side);
              canvas.width = canvas.height = size;
              ctx.drawImage(v, (v.videoWidth - side) / 2, (v.videoHeight - side) / 2, side, side, 0, 0, size, size);
              const img = ctx.getImageData(0, 0, size, size);
              if (found(jsQR(img.data, size, size, { inversionAttempts: "dontInvert" })?.data)) return;
            }
          } catch {}
        }
        timer = setTimeout(loop, detector ? 200 : 120);
      };
      loop();
    })();

    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="rise overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface">
      <div className="flex items-center justify-between px-4 py-3">
        <p className="flex items-center gap-2 font-semibold">
          <Camera size={18} aria-hidden />
          좌석 QR 스캔
        </p>
        <button type="button" aria-label="스캔 닫기" onClick={onClose} className="-m-1 grid size-9 place-items-center rounded-lg text-muted hover:bg-canvas">
          <X size={18} aria-hidden />
        </button>
      </div>
      {problem ? (
        <div className="px-4 pb-4">
          <p role="alert" className="text-sm text-[#3d4744]">
            {problem}
          </p>
          <Button className="mt-3" onClick={onClose}>
            닫기
          </Button>
        </div>
      ) : (
        <div className="relative aspect-square bg-du-black sm:aspect-video">
          <video ref={video} muted playsInline autoPlay className="size-full object-cover" />
          <div aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="size-[58%] max-w-64 rounded-2xl border-[3px] border-white/90 sm:size-48" />
          </div>
          <p className="absolute inset-x-0 bottom-3 text-center text-sm font-medium text-white" role="status">
            {ready ? "책상에 붙은 QR을 네모 안에 맞춰 주세요" : "카메라를 켜는 중…"}
          </p>
        </div>
      )}
    </div>
  );
}
