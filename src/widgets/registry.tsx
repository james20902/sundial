/**
 * Widget catalogue.
 *
 * Everything the rest of the app needs to know about a widget kind lives here:
 * how to render it, what a sensible default size is, and which configuration
 * controls apply to it. Adding a visualization means adding one entry.
 */

import type { ReactNode } from "react";
import type { DatasetInfo } from "@/data/types";
import type { Widget, WidgetKind } from "@/state/store";
import { findChannel, findGroup } from "@/state/store";
import { TimeSeries } from "./TimeSeries";
import { Readout } from "./Readout";
import { Gauge } from "./Gauge";
import { XYPlot } from "./XYPlot";
import { StatsTable } from "./StatsTable";
import { EventsList } from "./EventsList";
import { Attitude } from "./Attitude";

export interface WidgetDef {
  kind: WidgetKind;
  label: string;
  glyph: string;
  description: string;
  defaultSize: { w: number; h: number };
  /** How many channels the widget plots: `one`, `many`, or `none`. */
  channelMode: "one" | "many" | "none";
  render: (widget: Widget) => ReactNode;
  /** Seed a new widget's channels from whatever the log contains. */
  seed?: (info: DatasetInfo) => Partial<Widget>;
}

export const WIDGETS: WidgetDef[] = [
  {
    kind: "timeseries",
    label: "Time series",
    glyph: "📈",
    description: "One or more channels plotted against time.",
    defaultSize: { w: 6, h: 5 },
    channelMode: "many",
    render: (w) => <TimeSeries widget={w} />,
    seed: (info) => {
      const c = findChannel(info.channels, ["altitude", "alt", "height"]) ?? info.channels[0]?.name;
      return {
        channels: c ? [c] : [],
        options: { yMode: "auto", windowMode: "view", fill: true },
      };
    },
  },
  {
    kind: "readout",
    label: "Readout",
    glyph: "🔢",
    description: "One channel's value at the cursor, with a sparkline for context.",
    defaultSize: { w: 3, h: 3 },
    channelMode: "one",
    render: (w) => <Readout widget={w} />,
    seed: (info) => {
      const c = findChannel(info.channels, ["altitude", "alt"]) ?? info.channels[0]?.name;
      return {
        channels: c ? [c] : [],
        options: { precision: 1, showSparkline: true, showExtremes: true },
      };
    },
  },
  {
    kind: "gauge",
    label: "Gauge",
    glyph: "🎚",
    description: "Radial gauge with an optional redline zone.",
    defaultSize: { w: 3, h: 4 },
    channelMode: "one",
    render: (w) => <Gauge widget={w} />,
    seed: (info) => {
      const c =
        findChannel(info.channels, ["battery", "voltage", "velocity"]) ?? info.channels[0]?.name;
      const meta = info.channels.find((x) => x.name === c);
      return {
        channels: c ? [c] : [],
        options: { precision: 1, gMin: meta?.min, gMax: meta?.max },
      };
    },
  },
  {
    kind: "xy",
    label: "XY plot",
    glyph: "🛰",
    description: "One channel against another — ground track, flight envelope, control response.",
    defaultSize: { w: 4, h: 5 },
    channelMode: "one",
    render: (w) => <XYPlot widget={w} />,
    seed: (info) => {
      const lat = findChannel(info.channels, ["gpslat", "latitude", "lat"]);
      const lon = findChannel(info.channels, ["gpslon", "longitude", "lon"]);
      if (lat && lon) {
        return { channels: [lat], options: { xChannel: lon, equalAxes: true }, title: "Ground track" };
      }
      const alt = findChannel(info.channels, ["altitude", "alt"]);
      const vel = findChannel(info.channels, ["velocity", "speed"]);
      return {
        channels: alt ? [alt] : [],
        options: { xChannel: vel, equalAxes: false },
      };
    },
  },
  {
    kind: "stats",
    label: "Channel table",
    glyph: "▦",
    description: "Cursor value plus min/max/mean over the visible window.",
    defaultSize: { w: 6, h: 5 },
    channelMode: "many",
    render: (w) => <StatsTable widget={w} />,
    seed: (info) => ({
      channels: info.channels.slice(0, 12).map((c) => c.name),
      options: { precision: 3 },
    }),
  },
  {
    kind: "events",
    label: "Events",
    glyph: "🚩",
    description: "Flight states, detected milestones, and your own markers.",
    defaultSize: { w: 4, h: 5 },
    channelMode: "none",
    render: () => <EventsList />,
  },
  {
    kind: "attitude",
    label: "Attitude",
    glyph: "✈",
    description: "Artificial horizon driven by roll and pitch channels.",
    defaultSize: { w: 3, h: 5 },
    channelMode: "none",
    render: (w) => <Attitude widget={w} />,
    seed: (info) => {
      const gyro = findGroup(info.channels, "gyro");
      return {
        options: {
          rollCh: findChannel(info.channels, ["roll"]) ?? gyro[0],
          pitchCh: findChannel(info.channels, ["pitch"]) ?? gyro[1],
        },
      };
    },
  },
];

export const widgetDef = (kind: WidgetKind): WidgetDef =>
  WIDGETS.find((w) => w.kind === kind) ?? WIDGETS[0];
