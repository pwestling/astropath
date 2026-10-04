// Publish the echo app's manifest. Run it from the app's deploy, after the new
// release is serving: Astropath checks /.well-known/astropath-app first.
import { manifest } from "./app.mjs";

const astropath = process.env.ASTROPATH_URL;
const key = process.env.ASTROPATH_PUBLISHER_KEY;
if (!astropath || !key)
  throw new Error("Set ASTROPATH_URL and ASTROPATH_PUBLISHER_KEY.");
const response = await fetch(
  new URL("/api/platform/v1/apps/echo/releases", astropath),
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ manifest: manifest() }),
  },
);
console.log(response.status, await response.text());
if (!response.ok) process.exit(1);
