import { serve } from "@hono/node-server";
import { createApp } from "./server/app.js";
import { getPort } from "./lib/env.js";
import { getVersion } from "./lib/version.js";

const app = createApp();
const port = getPort();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`promoter ${getVersion()} listening on :${info.port}`);
});
