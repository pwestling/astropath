// Run the echo app, then publish its release to Astropath:
//   ASTROPATH_URL=https://astropath.example ASTROPATH_TENANT=<tenant id> \
//     PORT=4390 node examples/echo-app/server.mjs
//   ASTROPATH_URL=... ASTROPATH_PUBLISHER_KEY=apk_... node examples/echo-app/publish.mjs
import { createServer } from "node:http";
import { createRemoteJWKSet } from "jose";
import { createEchoApp } from "./app.mjs";

const astropath = process.env.ASTROPATH_URL;
const tenant = process.env.ASTROPATH_TENANT;
if (!astropath || !tenant)
  throw new Error("Set ASTROPATH_URL and ASTROPATH_TENANT.");
const app = createEchoApp({
  issuer: astropath,
  jwks: createRemoteJWKSet(
    new URL(`/api/platform/v1/jwks/${tenant}`, astropath),
  ),
});
const port = Number(process.env.PORT ?? 4390);
createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const response = await app.handle(
    new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
    }),
  );
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, "127.0.0.1", () =>
  console.log(`echo app on 127.0.0.1:${port}`),
);
