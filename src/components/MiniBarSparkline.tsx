export default function MiniBarSparkline({
  data,
  className,
  accentColor = "#2cdb87",
  width = 80,
  height = 24,
}: {
  data: number[];
  className?: string;
  accentColor?: string;
  width?: number;
  height?: number;
}) {
  const max = Math.max(...data, 1);
  const n = data.length;
  const gap = 1;
  const totalGap = gap * (n - 1);
  const barW = n > 0 ? (width - totalGap) / n : 0;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={className}
      role="img"
      aria-label="8-week trend"
    >
      {data.map((v, i) => {
        const h = max > 0 ? (v / max) * height : 0;
        const x = i * (barW + gap);
        const y = height - h;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={barW}
            height={Math.max(h, 1)}
            fill={accentColor}
            rx="0.5"
          >
            <title>{v}</title>
          </rect>
        );
      })}
    </svg>
  );
}
