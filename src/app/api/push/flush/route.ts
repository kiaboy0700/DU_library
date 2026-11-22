import { createClient } from "@supabase/supabase-js";
import * as webpush from "web-push";

// DB의 tick()이 1분마다 호출한다. notifications 큐에서 아직 보내지 않은 알림을 웹 푸시로 발송.
export async function POST(request: Request) {
  const secret = process.env.PUSH_FLUSH_SECRET;
  if (!secret || request.headers.get("x-flush-secret") !== secret) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });
  webpush.setVapidDetails("mailto:library@du-library.app", process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!, process.env.VAPID_PRIVATE_KEY!);

  const since = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data: queue, error } = await admin
    .from("notifications")
    .select("id,user_id,title,body,url")
    .is("pushed_at", null)
    .gt("created_at", since)
    .order("id")
    .limit(200);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!queue?.length) return Response.json({ sent: 0 });

  // 먼저 발송 표시를 해서 다음 호출과 겹쳐 두 번 보내지 않게 한다
  await admin.from("notifications").update({ pushed_at: new Date().toISOString() }).in("id", queue.map((n) => n.id));

  const { data: subs } = await admin.from("push_subscriptions").select("id,user_id,endpoint,p256dh,auth").in("user_id", [...new Set(queue.map((n) => n.user_id))]);
  let sent = 0;
  const dead: number[] = [];
  await Promise.all(
    queue.flatMap((n) =>
      (subs ?? [])
        .filter((s) => s.user_id === n.user_id)
        .map(async (s) => {
          try {
            await webpush.sendNotification(
              { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
              JSON.stringify({ title: n.title, body: n.body, url: n.url, tag: `n-${n.id}` }),
              { TTL: 600 },
            );
            sent += 1;
          } catch (e) {
            const code = (e as { statusCode?: number }).statusCode;
            if (code === 404 || code === 410) dead.push(s.id);
          }
        }),
    ),
  );
  if (dead.length) await admin.from("push_subscriptions").delete().in("id", dead);
  return Response.json({ sent, queued: queue.length });
}
