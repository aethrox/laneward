import app from "./src/app";
import { notificationClasses, startNotifier } from "./src/notify";

const port = Number(process.env.PORT ?? 8787);

startNotifier({
  classes: notificationClasses(process.env.LANEWARD_NOTIFY),
  dashboardUrl: `http://127.0.0.1:${port}`,
});

export default {
  port,
  hostname: "127.0.0.1",
  fetch: app.fetch,
};
