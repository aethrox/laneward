import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { renderPage } from "./dashboard-page";
import {
  defaultConfig,
  logPath,
  readFrom,
  readTail,
  planSnapshot,
  snapshot,
  type DashboardConfig,
} from "./dashboard-data";
import { isSlug } from "./slug";

export type { DashboardConfig };

export function createDashboard(cfg: DashboardConfig = defaultConfig()) {
  const dash = new Hono();

  dash.get("/", (c) => c.html(renderPage()));

  dash.get("/pico.css", () =>
    new Response(Bun.file(cfg.picoPath), {
      headers: {
        "content-type": "text/css; charset=utf-8",
        "cache-control": "max-age=31536000, immutable",
      },
    }),
  );

  // The lane id arrives from the URL and is joined into a filesystem path, so
  // it gets the same rule as a registered lane rather than a separator check of
  // its own: a lane id that could not be registered cannot name a log either.
  dash.get("/lanes/:id/log", async (c) => {
    const laneId = c.req.param("id");
    if (!isSlug(laneId)) {
      return c.json({ error: "invalid lane id" }, 400);
    }
    const file = Bun.file(logPath(cfg, laneId));
    if (!(await file.exists())) return c.json({ error: "log not found" }, 404);
    return new Response(file, { headers: { "content-type": "text/plain; charset=utf-8" } });
  });

  dash.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const offsets = new Map<string, number>();
      let lastSnapshot = "";
      let lastPlans = "";

      while (!stream.aborted) {
        const [lanes, plans] = await Promise.all([snapshot(cfg), planSnapshot()]);
        const serialised = JSON.stringify(lanes);
        const serialisedPlans = JSON.stringify(plans);
        if (serialised !== lastSnapshot) {
          await stream.writeSSE({ event: "lanes", data: serialised });
          lastSnapshot = serialised;
        }
        if (serialisedPlans !== lastPlans) {
          await stream.writeSSE({ event: "plans", data: serialisedPlans });
          lastPlans = serialisedPlans;
        }

        for (const lane of lanes) {
          const following = offsets.has(lane.lane_id);
          if (!following && lane.status !== "running") continue;
          const path = logPath(cfg, lane.lane_id);

          if (!following) {
            const tail = await readTail(path);
            offsets.set(lane.lane_id, tail.next);
            if (tail.text) {
              await stream.writeSSE({
                event: "log",
                data: JSON.stringify({ lane_id: lane.lane_id, reset: true, chunk: tail.text }),
              });
            }
            continue;
          }

          const update = await readFrom(path, offsets.get(lane.lane_id)!);
          offsets.set(lane.lane_id, update.next);
          if (update.chunk) {
            await stream.writeSSE({
              event: "log",
              data: JSON.stringify({
                lane_id: lane.lane_id,
                reset: update.reset,
                chunk: update.chunk,
              }),
            });
          }
          // One final read past the end, then stop following: the last lines
          // before a failure are the ones worth keeping.
          if (lane.status !== "running") offsets.delete(lane.lane_id);
        }

        // A quiet system writes nothing for minutes, and Bun.serve closes an
        // idle socket after 10 seconds. This SSE comment is ignored by
        // EventSource and keeps the connection from being reaped mid-watch.
        await stream.write(": ping\n\n");

        await Bun.sleep(cfg.pollMs);
      }
    }),
  );

  return dash;
}
