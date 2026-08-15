import React from "react";
import { View } from "react-native";
import Svg, { Line, Rect, Path, Text as SvgText } from "react-native-svg";
import { colors } from "../theme";
import { type CandleRow } from "../api/hooks";

interface Props {
  candles: CandleRow[];
  height?: number;
  width?: number;
  /** Optional overlay series aligned with candles (null = gap), e.g. EMA. */
  overlays?: Array<{ color: string; values: Array<number | null> }>;
}

/**
 * Lightweight SVG candlestick chart. Up candles are hollow with green
 * borders, down candles solid red — direction is also encoded by fill style,
 * not color alone.
 */
export function CandleChart({ candles, height = 220, width = 360, overlays = [] }: Props) {
  if (candles.length === 0) return <View style={{ height }} />;

  const padY = 12;
  const allHighs = candles.map((c) => c.high);
  const allLows = candles.map((c) => c.low);
  const max = Math.max(...allHighs);
  const min = Math.min(...allLows);
  const range = max - min || 1;

  const slot = width / candles.length;
  const bodyWidth = Math.max(Math.min(slot * 0.6, 12), 2);

  const y = (price: number): number => padY + ((max - price) / range) * (height - padY * 2);

  const overlayPaths = overlays.map((overlay) => {
    let d = "";
    overlay.values.forEach((v, i) => {
      if (v === null || v === undefined) return;
      const px = i * slot + slot / 2;
      const py = y(v);
      d += d === "" ? `M ${px} ${py}` : ` L ${px} ${py}`;
    });
    return { d, color: overlay.color };
  });

  return (
    <Svg width={width} height={height}>
      {/* Price gridlines */}
      {[0.25, 0.5, 0.75].map((f) => (
        <Line
          key={f}
          x1={0}
          x2={width}
          y1={padY + f * (height - padY * 2)}
          y2={padY + f * (height - padY * 2)}
          stroke={colors.border}
          strokeWidth={0.5}
        />
      ))}
      {candles.map((c, i) => {
        const cx = i * slot + slot / 2;
        const up = c.close >= c.open;
        const color = up ? colors.up : colors.down;
        const bodyTop = y(Math.max(c.open, c.close));
        const bodyHeight = Math.max(Math.abs(y(c.open) - y(c.close)), 1);
        return (
          <React.Fragment key={c.openTime}>
            <Line x1={cx} x2={cx} y1={y(c.high)} y2={y(c.low)} stroke={color} strokeWidth={1} />
            <Rect
              x={cx - bodyWidth / 2}
              y={bodyTop}
              width={bodyWidth}
              height={bodyHeight}
              fill={up ? colors.bg : color}
              stroke={color}
              strokeWidth={1.2}
            />
          </React.Fragment>
        );
      })}
      {overlayPaths.map((p, i) => (
        <Path key={i} d={p.d} stroke={p.color} strokeWidth={1.5} fill="none" opacity={0.9} />
      ))}
      <SvgText x={4} y={padY} fill={colors.textDim} fontSize={10}>
        {max.toFixed(2)}
      </SvgText>
      <SvgText x={4} y={height - 2} fill={colors.textDim} fontSize={10}>
        {min.toFixed(2)}
      </SvgText>
    </Svg>
  );
}

/** Simple line chart used for equity/PnL curves. */
export function LineChart({
  points,
  height = 160,
  width = 360,
  color = colors.accent
}: {
  points: Array<{ time: number; value: number }>;
  height?: number;
  width?: number;
  color?: string;
}) {
  if (points.length < 2) return <View style={{ height }} />;
  const values = points.map((p) => p.value);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const stepX = width / (points.length - 1);
  const y = (v: number): number => 8 + ((max - v) / range) * (height - 16);

  let d = "";
  points.forEach((p, i) => {
    const px = i * stepX;
    const py = y(p.value);
    d += d === "" ? `M ${px} ${py}` : ` L ${px} ${py}`;
  });

  return (
    <Svg width={width} height={height}>
      <Line x1={0} x2={width} y1={y(values[0]!)} y2={y(values[0]!)} stroke={colors.border} strokeDasharray="4 4" strokeWidth={0.7} />
      <Path d={d} stroke={color} strokeWidth={2} fill="none" />
      <SvgText x={4} y={12} fill={colors.textDim} fontSize={10}>
        {max.toFixed(2)}
      </SvgText>
      <SvgText x={4} y={height - 4} fill={colors.textDim} fontSize={10}>
        {min.toFixed(2)}
      </SvgText>
    </Svg>
  );
}
