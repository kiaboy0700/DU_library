"use client";

import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { Copy, ExternalLink, Printer, RefreshCw } from "lucide-react";
import { useApp } from "@/components/Providers";
import { Button, Panel, Skeleton, Tag, inputClass, useAction } from "@/components/ui";
import { useAdminMap, useRooms, type AdminSeat } from "@/lib/admin";
import { rpc } from "@/lib/supabase";
import { SEAT_TYPE_LABEL, STATE_LABEL } from "@/lib/types";
import { cx } from "@/lib/util";

const seatUrl = (token: string) => `${window.location.origin}/s/${token}`;

function Qr({ token, size }: { token: string; size: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(seatUrl(token), { width: size * 2, margin: 1, errorCorrectionLevel: "M", color: { dark: "#231f20", light: "#ffffff" } }).then((d) => live && setSrc(d));
    return () => {
      live = false;
    };
  }, [token, size]);
  // eslint-disable-next-line @next/next/no-img-element
  return src ? <img src={src} width={size} height={size} alt="" className="block" /> : <div className="skeleton" style={{ width: size, height: size }} />;
}

export default function AdminQrPage() {
  const { toast } = useApp();
  const { rooms } = useRooms();
  const [roomId, setRoomId] = useState<number | null>(null);
  const { seats, reload } = useAdminMap(roomId);
  const [zone, setZone] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<AdminSeat | null>(null);
  const { busy, run } = useAction((m) => toast(m, "error"));

  useEffect(() => {
    if (rooms?.length && roomId === null) setRoomId(rooms[0].id);
  }, [rooms, roomId]);
  useEffect(() => {
    setZone(null);
    setPicked(null);
  }, [roomId]);

  const zones = useMemo(() => [...new Set(seats?.map((s) => s.zone) ?? [])], [seats]);
  const shown = useMemo(
    () => (seats ?? []).filter((s) => (!zone || s.zone === zone) && (!q.trim() || s.label.toLowerCase().includes(q.trim().toLowerCase()))),
    [seats, zone, q],
  );
  const room = rooms?.find((r) => r.id === roomId);
  const cur = picked && seats?.find((s) => s.seat_id === picked.seat_id);

  return (
    <div className="space-y-4">
      <div className="no-print flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-bold">좌석 QR</h1>
          <p className="mt-0.5 max-w-2xl text-sm text-muted">
            좌석마다 책상에 붙이는 QR입니다. 좌석을 누르면 크게 볼 수 있고, 휴대폰으로 스캔하거나 &lsquo;좌석 화면 열기&rsquo;로 스캔한 것과 같은 화면을 바로 열어 테스트할 수 있습니다.
          </p>
        </div>
        <Button onClick={() => window.print()}>
          <Printer size={16} aria-hidden />
          보이는 QR 인쇄
        </Button>
      </div>

      <div className="no-print flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="열람실" className="flex gap-1.5">
          {rooms?.map((r) => (
            <button
              key={r.id}
              role="tab"
              type="button"
              aria-selected={roomId === r.id}
              onClick={() => setRoomId(r.id)}
              className={cx("min-h-10 rounded-full border px-4 text-sm font-semibold", roomId === r.id ? "border-du-deep bg-du-deep text-white" : "border-line bg-surface hover:bg-canvas")}
            >
              {r.name}
            </button>
          ))}
        </div>
        <span className="mx-1 hidden h-6 w-px bg-line sm:block" />
        <div role="group" aria-label="구역" className="flex flex-wrap gap-1.5">
          {[null, ...zones].map((z) => (
            <button
              key={z ?? "all"}
              type="button"
              aria-pressed={zone === z}
              onClick={() => setZone(z)}
              className={cx("min-h-9 rounded-full border px-3 text-[13px] font-semibold", zone === z ? "border-du-deep bg-du-tint text-du-deep-dark" : "border-line bg-surface hover:bg-canvas")}
            >
              {z ? `${z}구역` : "전체 구역"}
            </button>
          ))}
        </div>
        <input className={cx(inputClass, "ml-auto !min-h-10 w-40")} placeholder="좌석 번호 검색" aria-label="좌석 번호 검색" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {cur && (
        <Panel className="no-print rise flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:p-5">
          <div className="self-center rounded-xl border border-line p-2">
            <Qr token={cur.qr_token} size={220} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[28px] font-bold leading-tight tracking-tight">{cur.label}</h2>
              <Tag tone={cur.res ? "neutral" : "deep"}>{!cur.is_active ? "사용 중지" : cur.res ? STATE_LABEL[cur.res.status] : "빈자리"}</Tag>
            </div>
            <p className="text-sm text-muted">
              {room?.name} · {SEAT_TYPE_LABEL[cur.seat_type]}
              {cur.res && ` · ${cur.res.name}(${cur.res.student_id})`}
            </p>
            <p className="mt-2 break-all rounded-md bg-canvas px-2.5 py-2 font-mono text-xs text-[#3d4744]">{seatUrl(cur.qr_token)}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <a
                href={`/s/${cur.qr_token}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 items-center gap-1.5 rounded-[var(--radius-ctl)] bg-du-deep px-4 text-sm font-semibold text-white hover:bg-du-deep-dark"
              >
                <ExternalLink size={16} aria-hidden />
                좌석 화면 열기
              </a>
              <Button
                onClick={async () => {
                  await navigator.clipboard.writeText(seatUrl(cur.qr_token));
                  toast("주소를 복사했습니다.", "ok");
                }}
              >
                <Copy size={16} aria-hidden />
                주소 복사
              </Button>
              <Button
                busy={busy === "regen"}
                onClick={() => {
                  if (!window.confirm(`${cur.label} 좌석의 QR을 새로 발급할까요? 지금 붙어 있는 QR은 더 이상 쓸 수 없게 됩니다.`)) return;
                  run("regen", async () => {
                    await rpc("admin_regen_qr", { p_seat: cur.seat_id });
                    await reload();
                    toast("QR을 새로 발급했습니다. 인쇄해서 교체해 주세요.", "ok");
                  });
                }}
              >
                <RefreshCw size={16} aria-hidden />
                QR 재발급
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted">학생 계정으로 테스트하려면 다른 브라우저나 시크릿 창에서 그 학생으로 로그인한 뒤 주소를 열어 주세요.</p>
          </div>
        </Panel>
      )}

      {seats === null ? (
        <Skeleton className="h-96 !rounded-[var(--radius-panel)]" />
      ) : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6 print:grid-cols-4 print:gap-3">
          {shown.map((s) => (
            <li key={s.seat_id} className="break-inside-avoid">
              <button
                type="button"
                onClick={() => {
                  setPicked(s);
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
                aria-pressed={picked?.seat_id === s.seat_id}
                className={cx(
                  "flex w-full flex-col items-center rounded-[var(--radius-ctl)] border bg-surface p-2.5 text-center transition-colors duration-150 hover:border-du-deep/50 print:border-[#999]",
                  picked?.seat_id === s.seat_id ? "border-du-deep" : "border-line",
                )}
              >
                <Qr token={s.qr_token} size={116} />
                <span className="mt-1.5 text-base font-bold tracking-tight">{s.label}</span>
                <span className="text-[11px] text-muted">
                  {room?.name} · {SEAT_TYPE_LABEL[s.seat_type]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {seats && shown.length === 0 && <p className="py-10 text-center text-sm text-muted">조건에 맞는 좌석이 없습니다. 검색어나 구역을 바꿔 보세요.</p>}
    </div>
  );
}
