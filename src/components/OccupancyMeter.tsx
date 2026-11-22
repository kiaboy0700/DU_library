import { cx } from "@/lib/util";

/**
 * 시그니처: 혼잡도 눈금.
 * 이용률 막대 위에 50%·80% 기준선을 긋고, 세 구간 아래에 그 구간에서 적용되는 규칙을 적는다.
 * "혼잡도가 규칙을 정한다"는 원리를 눈금 그대로 읽게 한다.
 */
export function OccupancyMeter({
  pct,
  rules = ["60분", "40분", "20분"],
  ruleLabel = "외출 허용",
  compact,
}: {
  pct: number;
  /** 여유·보통·혼잡 구간의 규칙 값 */
  rules?: string[];
  ruleLabel?: string;
  compact?: boolean;
}) {
  const zone = pct >= 80 ? 2 : pct >= 50 ? 1 : 0;
  const fill = ["bg-du-deep", "bg-[#b9790a]", "bg-danger"][zone];
  const names = ["여유", "보통", "혼잡"];
  const widths = ["w-1/2", "w-[30%]", "w-1/5"];

  return (
    <div>
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`이용률 ${pct}퍼센트, ${names[zone]}. ${ruleLabel} ${rules[zone]}`}
        className="relative h-3 overflow-hidden rounded-full bg-[#e3e9e7]"
      >
        <div className={cx("h-full rounded-full transition-[width] duration-500 ease-[var(--ease-out-expo)]", fill)} style={{ width: `${Math.max(pct, 2)}%` }} />
        <span aria-hidden className="absolute inset-y-0 left-1/2 w-0.5 bg-surface" />
        <span aria-hidden className="absolute inset-y-0 left-[80%] w-0.5 bg-surface" />
      </div>
      <div aria-hidden className="mt-1.5 flex text-xs leading-tight">
        {names.map((n, i) => (
          <div key={n} className={cx(widths[i], "min-w-0", i > 0 && "pl-1.5")}>
            <span className={cx("block whitespace-nowrap", i === zone ? "font-bold text-du-black" : "text-[#6b7774]")}>
              {n}
              {i > 0 && <span className="tabular font-normal text-[#6b7774]"> {i === 1 ? "50%~" : "80%~"}</span>}
            </span>
            <span className={cx("tabular mt-0.5 block whitespace-nowrap", i === zone ? "text-[13px] font-bold text-du-black" : "text-[#6b7774]")}>{rules[i]}</span>
          </div>
        ))}
      </div>
      {!compact && (
        <p className="mt-2 text-[13px] text-[#3d4744]">
          지금은 <strong className="font-semibold text-du-black">{names[zone]}</strong> 단계라 {ruleLabel} 시간이 <strong className="tabular font-semibold text-du-black">{rules[zone]}</strong>입니다.
        </p>
      )}
    </div>
  );
}
