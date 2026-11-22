"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, X } from "lucide-react";
import { Button } from "./ui";

interface Detector {
  detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]>;
}

/** 좌석 QR 스캐너. 지원하지 않는 브라우저에서는 기본 카메라 앱 사용을 안내한다 */
export function QrScanner({ onToken, onClose }: { onToken: (token: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stop = false;
    const Ctor = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
    if (!Ctor || !navigator.mediaDevices?.getUserMedia) {
      setProblem("이 브라우저에서는 화면 안에서 스캔할 수 없습니다. 휴대폰 기본 카메라 앱으로 좌석의 QR을 비추면 같은 화면이 열립니다.");
      return;
    }
    const detector = new Ctor({ formats: ["qr_code"] });
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (stop || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        const loop = async () => {
          if (stop || !video.current) return;
          try {
            const codes = await detector.detect(video.current);
            const m = codes.map((c) => c.rawValue.match(/\/s\/([0-9a-f-]{36})/i)).find(Boolean);
            if (m) return onToken(m[1]);
          } catch {}
          setTimeout(loop, 250);
        };
        loop();
      } catch {
        setProblem("카메라를 사용할 수 없습니다. 브라우저의 카메라 권한을 허용하거나, 기본 카메라 앱으로 좌석의 QR을 비춰 주세요.");
      }
    })();
    return () => {
      stop = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onToken]);

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
          <p className="text-sm text-[#3d4744]">{problem}</p>
          <Button className="mt-3" onClick={onClose}>
            닫기
          </Button>
        </div>
      ) : (
        <div className="relative aspect-square bg-du-black sm:aspect-video">
          <video ref={video} muted playsInline className="size-full object-cover" />
          <div aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="size-[58%] max-w-64 rounded-2xl border-[3px] border-white/90 sm:size-48" />
          </div>
          <p className="absolute inset-x-0 bottom-3 text-center text-sm font-medium text-white">책상에 붙은 QR을 네모 안에 맞춰 주세요</p>
        </div>
      )}
    </div>
  );
}
