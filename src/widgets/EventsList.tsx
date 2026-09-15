/** Timeline events, newest context first. Clicking one seeks the whole
 *  workspace to it, which is the fastest way to move between flight phases. */

import { useMemo } from "react";
import { useData, usePlayback } from "@/state/store";
import { removeMarker } from "@/data/client";
import { fmtTime } from "./chartTheme";

const KIND_COLOR: Record<string, string> = {
  state: "#9085e9",
  detected: "#f0a638",
  marker: "#199e70",
};

export function EventsList() {
  const info = useData((s) => s.info);
  const setEvents = useData((s) => s.setEvents);
  const cursor = usePlayback((s) => s.cursor);
  const setCursor = usePlayback((s) => s.setCursor);

  const events = info?.events ?? [];

  /** The event the cursor currently sits in, so the list shows flight phase. */
  const currentIndex = useMemo(() => {
    let idx = -1;
    events.forEach((e, i) => {
      if (e.t <= cursor) idx = i;
    });
    return idx;
  }, [events, cursor]);

  if (!events.length) {
    return (
      <div className="empty-hint">
        <div>No events in this log</div>
        <div>
          State columns become events automatically. Press <b>M</b> to drop a marker at the
          cursor.
        </div>
      </div>
    );
  }

  return (
    <div className="scroll-y">
      {events.map((e, i) => (
        <div
          key={`${e.t}-${e.label}-${i}`}
          className={`event-row${i === currentIndex ? " current" : ""}`}
          onClick={() => setCursor(e.t)}
          title={`Seek to ${fmtTime(e.t)}`}
        >
          <span className="event-time">{fmtTime(e.t)}</span>
          <span className="event-kind" style={{ background: KIND_COLOR[e.kind] ?? "#6d7787" }} />
          <span className="event-label">{e.label}</span>
          {e.kind === "marker" && (
            <button
              className="btn ghost icon"
              title="Remove marker"
              onClick={(ev) => {
                ev.stopPropagation();
                removeMarker(e.t, info?.id).then(setEvents).catch(() => {});
              }}
            >
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
