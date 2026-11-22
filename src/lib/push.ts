"use client";

import { supabase } from "./supabase";

const b64ToBytes = (b64: string) => {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

export const pushSupported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

export async function pushEnabled() {
  if (!pushSupported() || Notification.permission !== "granted") return false;
  const reg = await navigator.serviceWorker.getRegistration();
  return !!(await reg?.pushManager.getSubscription());
}

export async function enablePush(userId: string) {
  if (!pushSupported()) throw new Error("이 브라우저는 푸시 알림을 지원하지 않습니다. 아이폰은 '홈 화면에 추가'한 뒤 다시 시도해 주세요.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("알림 권한이 꺼져 있습니다. 브라우저 설정에서 이 사이트의 알림을 허용해 주세요.");
  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!) }));
  const json = sub.toJSON();
  const { error } = await supabase
    .from("push_subscriptions")
    .upsert({ user_id: userId, endpoint: sub.endpoint, p256dh: json.keys!.p256dh, auth: json.keys!.auth }, { onConflict: "endpoint" });
  if (error) throw new Error("알림 설정을 저장하지 못했습니다. 다시 시도해 주세요.");
}

export async function disablePush() {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
  await sub.unsubscribe();
}
