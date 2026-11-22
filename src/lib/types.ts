export type SeatType = "general" | "partition" | "laptop" | "window" | "booth";
export type SeatState = "free" | "reserved" | "in_use" | "away";
export type Mode = "semester" | "vacation" | "exam";

export const SEAT_TYPE_LABEL: Record<SeatType, string> = {
  general: "일반석",
  partition: "칸막이석",
  laptop: "노트북석",
  window: "창가석",
  booth: "1인 부스",
};
export const MODE_LABEL: Record<Mode, string> = { semester: "학기 중", vacation: "방학", exam: "시험기간" };
export const STATE_LABEL: Record<SeatState, string> = { free: "빈자리", reserved: "체크인 대기", in_use: "사용 중", away: "외출" };

export interface Decor {
  t: "table" | "pillar" | "label" | "door" | "lounge";
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
}
export interface Room {
  id: number;
  floor: number;
  name: string;
  description: string | null;
  layout_w: number;
  layout_h: number;
  decor: Decor[];
  open_24h_in_exam: boolean;
  is_closed: boolean;
  closed_reason: string | null;
}
export interface Seat {
  id: number;
  room_id: number;
  zone: string;
  label: string;
  seat_type: SeatType;
  x: number;
  y: number;
  is_active: boolean;
  inactive_reason: string | null;
}
export interface RoomSummary {
  id: number;
  floor: number;
  name: string;
  description: string | null;
  total: number;
  occupied: number;
  pct: number;
  away_minutes: number;
  report_minutes: number;
  is_open: boolean;
  closes_at: string | null;
  reason: string | null;
}
export interface HomeSummary {
  mode: Mode;
  incident: boolean;
  rooms: RoomSummary[];
}
export interface Reservation {
  id: number;
  seat_id: number;
  status: "reserved" | "in_use" | "away";
  start_at: string;
  end_at: string;
  checkin_deadline: string;
  away_deadline: string | null;
  extend_count: number;
  on_hold: boolean;
}
export interface MyReservation extends Reservation {
  seat_label: string;
  zone: string;
  seat_type: SeatType;
  room_id: number;
  room_name: string;
  floor: number;
  report_deadline: string | null;
  occupancy: number;
  away_minutes: number;
  mode: Mode;
  max_extends: number | null;
  extend_window_min: number;
}
export interface Profile {
  id: string;
  student_id: string;
  name: string;
  department: string | null;
  grade: number | null;
  role: "student" | "admin";
  banned_until: string | null;
  ban_reason: string | null;
}
export interface MyStatus {
  profile: Profile;
  points: number;
  reservation: MyReservation | null;
  help_open: boolean;
  unread: number;
}
export interface SeatContext {
  seat: { id: number; label: string; zone: string; seat_type: SeatType; is_active: boolean; room_id: number; room_name: string; floor: number };
  state: SeatState;
  is_mine: boolean;
  my_reservation: Reservation | null;
  have_other: boolean;
  pending_report: boolean;
  report_deadline: string | null;
  is_open: boolean;
  reason: string | null;
  mode: Mode;
  occupancy: number;
  away_minutes: number;
  report_minutes: number;
  gps_required: boolean;
  extend_window_min: number;
}
export interface Notice {
  id: number;
  title: string;
  body: string;
  url: string;
  created_at: string;
  read_at: string | null;
}
export interface Penalty {
  id: number;
  type: string;
  points: number;
  note: string | null;
  created_at: string;
  revoked_at: string | null;
}
