"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CameraOff, ChevronLeft, X } from "lucide-react";
import { useApp } from "./Providers";
import { Button, useNow } from "./ui";
import { rpc } from "@/lib/supabase";
import { STATE_LABEL, type SeatContext } from "@/lib/types";
import { errMsg, fmtRemain, getPosition } from "@/lib/util";

interface Detector {
  detect: (source: HTMLVideoElement) => Promise<{ rawValue: string }[]>;
}

const TOKEN = /\/s\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * 좌석 QR 스캐너.
 * 브라우저가 QR 인식을 지원하면 그것을 쓰고(안드로이드 크롬), 지원하지 않으면(아이폰 사파리 등)
 * 카메라 화면을 직접 읽어 해석한다. 카메라 자체를 쓸 수 없을 때만 기본 카메라 앱 사용을 안내한다.
 */
export function QrScanner({
  onToken,
  onClose,
  seat,
  deadline,
  plain,
}: {
  onToken: (token: string) => void;
  onClose: () => void;
  /** 스캔할 내 좌석: 어느 자리의 QR을 찍어야 하는지 알려 준다 */
  seat?: { label: string; room: string };
  /** 남은 시간 표시 (예: 체크인 마감) */
  deadline?: { label: string; at: string };
  /** 찍은 값만 넘겨받는다: 내 좌석인지 확인하지 않는다 (도움 요청에서 좌석을 지정할 때) */
  plain?: boolean;
}) {
  const now = useNow();
  const video = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  // 부모 화면이 매초 다시 그려져도 카메라를 껐다 켜지 않도록 콜백은 ref 로 들고 있는다
  const cb = useRef(onToken);
  useEffect(() => {
    cb.current = onToken;
  }, [onToken]);

  // 체크인 대기·외출 중에 내 좌석이 아닌 QR을 찍으면, 넘어가지 않고 이 화면에서 어떻게 할지 묻는다
  const { status, toast, refresh } = useApp();
  const mine = !plain && status?.reservation && status.reservation.status !== "in_use" ? status.reservation : null;
  const [wrong, setWrong] = useState<{ token: string; ctx: SeatContext } | null>(null);
  const [busy, setBusy] = useState(false);
  const paused = useRef(false);
  const handle = useRef<(token: string) => void>(() => {});
  useEffect(() => {
    handle.current = async (token) => {
      if (!mine) return cb.current(token);
      try {
        const c = await rpc<SeatContext | null>("seat_context_v2", { p_token: token });
        if (!c || c.is_mine) return cb.current(token);
        setWrong({ token, ctx: c });
      } catch {
        cb.current(token);
      }
    };
  }, [mine]);
  const again = () => {
    setWrong(null);
    paused.current = false;
  };
  async function switchSeat() {
    if (!wrong || busy) return;
    setBusy(true);
    try {
      const pos = wrong.ctx.gps_required ? await getPosition() : null;
      const r = await rpc<{ from: string; to: string }>("switch_seat", { p_token: wrong.token, p_lat: pos?.lat ?? null, p_lng: pos?.lng ?? null });
      await refresh();
      toast(`${r.from}에서 ${r.to}(으)로 바꿨습니다.`, "ok");
      cb.current(wrong.token);
    } catch (e) {
      toast(errMsg(e), "error");
    } finally {
      setBusy(false);
    }
  }

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
        // 찍힌 뒤에는 읽기를 멈춘다. '다시 찍기'를 누르면 이어서 읽는다
        paused.current = true;
        navigator.vibrate?.(60);
        handle.current(m[1]);
        return true;
      };

      const loop = async () => {
        if (stop || !video.current) return;
        if (paused.current) {
          timer = setTimeout(loop, 250);
          return;
        }
        const v = video.current;
        if (v.readyState >= 2 && v.videoWidth > 0) {
          try {
            if (detector) {
              const codes = await detector.detect(v);
              codes.some((c) => found(c.rawValue));
            } else if (jsQR && ctx) {
              // 가운데 정사각형만 읽어 빠르게 해석
              const side = Math.min(v.videoWidth, v.videoHeight);
              const size = Math.min(640, side);
              canvas.width = canvas.height = size;
              ctx.drawImage(v, (v.videoWidth - side) / 2, (v.videoHeight - side) / 2, side, side, 0, 0, size, size);
              const img = ctx.getImageData(0, 0, size, size);
              found(jsQR(img.data, size, size, { inversionAttempts: "dontInvert" })?.data);
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

  // 전체 화면 스캐너: 뒤 화면이 스크롤되지 않게 잠그고, Esc 로 닫는다
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // 아래 메뉴 등 다른 고정 요소가 스캐너 위로 올라오지 않게 표시해 둔다 (globals.css)
    document.body.dataset.scanner = "on";
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => {
      document.body.style.overflow = prev;
      delete document.body.dataset.scanner;
      document.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  const left = deadline ? new Date(deadline.at).getTime() - now : 0;

  // 화면 맨 위 계층(body)에 직접 그려서 어떤 화면에서 열어도 전체를 덮는다
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="QR코드 스캔" className="scanner fixed inset-0 z-[100] flex h-dvh flex-col bg-du-black">
      <div className="relative flex h-14 shrink-0 items-center justify-center bg-surface pt-[env(safe-area-inset-top)] text-du-black">
        <button type="button" aria-label="뒤로" onClick={onClose} className="absolute left-2 grid size-11 place-items-center rounded-lg hover:bg-canvas">
          <ChevronLeft size={24} aria-hidden />
        </button>
        <h2 className="text-[17px] font-semibold">QR코드 스캔</h2>
      </div>

      {problem ? (
        <div className="flex flex-1 flex-col items-center justify-center px-8 text-center text-white">
          <CameraOff size={40} strokeWidth={1.6} aria-hidden />
          <p role="alert" className="mt-4 max-w-sm text-[15px] leading-relaxed">
            {problem}
          </p>
          <Button className="mt-6" onClick={onClose}>
            닫기
          </Button>
        </div>
      ) : (
        <div className="relative flex-1 overflow-hidden">
          {/* 카메라 화면은 첫 장면이 실제로 그려진 뒤에 보여 준다. 그 전에 보이면 작게 떴다가 커지는 것처럼 보인다 */}
          <video
            ref={video}
            muted
            playsInline
            autoPlay
            onPlaying={() => setReady(true)}
            className="absolute inset-0 h-full w-full object-cover transition-opacity duration-200"
            style={{ opacity: ready ? 1 : 0 }}
          />
          {/* 가운데 네모만 밝게, 바깥은 어둡게 */}
          <div aria-hidden className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <div className="aspect-square w-[62%] max-w-[300px] rounded-sm border border-white/70 shadow-[0_0_0_200vmax_rgb(0_0_0/0.55)]" />
          </div>
          {/* 어느 좌석의 QR을 찍어야 하는지, 시간이 얼마나 남았는지 */}
          {(seat || deadline) && (
            <div className="absolute inset-x-0 bottom-[calc(50%+min(31vw,150px)+20px)] flex flex-col items-center px-6 text-center text-white">
              {seat && (
                <>
                  <p className="text-[13px] font-medium text-white/85">{seat.room.includes("·") ? seat.room : `${seat.room} · 내 좌석`}</p>
                  <p className="text-[34px] font-bold leading-tight tracking-tight">{seat.label}</p>
                </>
              )}
              {deadline && (
                <p className={left < 3 * 60_000 ? "tabular mt-1 rounded-full bg-danger px-3 py-1 text-sm font-bold" : "tabular mt-1 rounded-full bg-white/20 px-3 py-1 text-sm font-semibold"}>
                  {deadline.label} {fmtRemain(left)}
                </p>
              )}
            </div>
          )}
          <div className="absolute inset-x-0 top-[calc(50%+min(31vw,150px)+28px)] flex flex-col items-center gap-10 px-6">
            <p className="text-center text-[15px] font-semibold text-white" role="status">
              {ready ? "QR 코드를 스캔해 주세요." : "카메라를 켜는 중…"}
            </p>
            <button type="button" aria-label="스캔 닫기" onClick={onClose} className="grid size-14 place-items-center rounded-full bg-white/30 text-white backdrop-blur-sm transition-colors duration-150 hover:bg-white/40">
              <X size={28} aria-hidden />
            </button>
          </div>
        </div>
      )}

      {wrong && mine && (
        <div className="absolute inset-0 z-10 flex items-end justify-center bg-black/60 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:items-center">
          <div role="alertdialog" aria-modal="true" aria-labelledby="wrong-h" className="pop w-full max-w-sm rounded-2xl bg-surface p-5 text-du-black">
            <h3 id="wrong-h" className="text-lg font-bold">
              내 좌석이 아닙니다
            </h3>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-[var(--radius-ctl)] bg-canvas px-3 py-2">
                <dt className="text-xs text-muted">찍은 좌석 · {!wrong.ctx.seat.is_active ? "사용 중지" : wrong.ctx.priority_until ? "바꿀 수 있음" : STATE_LABEL[wrong.ctx.state]}</dt>
                <dd className="text-xl font-bold">{wrong.ctx.seat.label}</dd>
              </div>
              <div className="rounded-[var(--radius-ctl)] bg-du-tint px-3 py-2">
                <dt className="text-xs text-du-deep-dark">내 좌석 · {mine.status === "reserved" ? "체크인 대기" : "외출 중"}</dt>
                <dd className="text-xl font-bold">{mine.seat_label}</dd>
              </div>
            </dl>
            <div className="mt-4 space-y-2">
              {wrong.ctx.seat.is_active && (wrong.ctx.state === "free" || !!wrong.ctx.priority_until) && wrong.ctx.is_open && !wrong.ctx.held_by_other && (
                <Button variant="primary" size="lg" className="w-full" busy={busy} onClick={switchSeat}>
                  {wrong.ctx.seat.label}(으)로 바꿔 {mine.status === "reserved" ? "체크인" : "복귀"}
                </Button>
              )}
              {wrong.ctx.state === "in_use" && (
                <Button className="w-full" disabled={busy} onClick={() => cb.current(wrong.token)}>
                  {wrong.ctx.seat.label} 남은 시간 보기 · 자리비움 신고
                </Button>
              )}
              <Button variant={(wrong.ctx.state === "free" || !!wrong.ctx.priority_until) && wrong.ctx.seat.is_active ? "secondary" : "primary"} size="lg" className="w-full" disabled={busy} onClick={again}>
                내 좌석 {mine.seat_label} QR 다시 찍기
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
