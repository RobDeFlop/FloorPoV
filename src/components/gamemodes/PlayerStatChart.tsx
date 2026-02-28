import {
  Bar,
  BarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface PlayerStatEntry {
  player: string;
  count: number;
}

interface PlayerStatChartProps {
  title: string;
  data: PlayerStatEntry[];
  color: string;
}

// Measures the pixel width of a string rendered at a given font spec using an
// offscreen canvas. Falls back to a character-count estimate if the canvas API
// is unavailable (e.g. in tests).
function measureTextWidth(text: string, font: string): number {
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return text.length * 7;
    ctx.font = font;
    return ctx.measureText(text).width;
  } catch {
    return text.length * 7;
  }
}

const Y_AXIS_FONT = "11px ui-sans-serif, system-ui, sans-serif";
const Y_AXIS_MIN_WIDTH = 60;
const Y_AXIS_MAX_WIDTH = 160;
const Y_AXIS_PADDING = 16;

export function PlayerStatChart({ title, data, color }: PlayerStatChartProps) {
  const sanitizedData = data.map((entry) => {
    const normalizedName = entry.player.trim();
    return {
      ...entry,
      player: normalizedName || "Unknown",
    };
  });

  if (sanitizedData.length === 0) {
    return (
      <div>
        <p className="mb-2 text-xs font-medium text-neutral-400">{title}</p>
        <p className="text-xs text-neutral-600">No data</p>
      </div>
    );
  }

  const yAxisWidth = Math.min(
    Y_AXIS_MAX_WIDTH,
    Math.max(
      Y_AXIS_MIN_WIDTH,
      Math.ceil(Math.max(...sanitizedData.map((d) => measureTextWidth(d.player, Y_AXIS_FONT)))) +
        Y_AXIS_PADDING,
    ),
  );

  // Each bar is ~28px tall, plus some padding.
  const chartHeight = Math.max(60, sanitizedData.length * 28 + 16);

  return (
    <div>
      <p className="mb-2 text-xs font-medium text-neutral-400">{title}</p>
      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart
          layout="vertical"
          data={sanitizedData}
          margin={{ top: 0, right: 24, bottom: 0, left: 4 }}
        >
          <XAxis
            type="number"
            allowDecimals={false}
            tick={{ fill: "#737373", fontSize: 10 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            type="category"
            dataKey="player"
            interval={0}
            width={yAxisWidth}
            tick={{ fill: "#d4d4d4", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            cursor={{ fill: "rgba(255,255,255,0.04)" }}
            contentStyle={{
              background: "#1a1a1a",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 4,
              fontSize: 12,
              color: "#e5e5e5",
            }}
            itemStyle={{ color: "#f5f5f5" }}
            labelStyle={{ color: "#a3a3a3" }}
            formatter={(value: number | undefined) => [value ?? 0, title]}
          />
          <Bar dataKey="count" fill={color} fillOpacity={0.75} radius={[0, 2, 2, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
