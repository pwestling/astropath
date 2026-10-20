import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  // QuickJS loads its WebAssembly file from its own package at runtime.
  serverExternalPackages: [
    "pg",
    "quickjs-emscripten-core",
    "@jitl/quickjs-wasmfile-release-sync",
  ],
  outputFileTracingIncludes: {
    "/api/v1/[[...path]]": [
      "./node_modules/@jitl/quickjs-wasmfile-release-sync/dist/*.wasm",
    ],
    "/mcp": ["./node_modules/@jitl/quickjs-wasmfile-release-sync/dist/*.wasm"],
  },
  // Request URLs can contain search text or short-lived file capabilities.
  logging: { incomingRequests: false },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          // same-origin, not no-referrer: browsers send `Origin: null` on native form posts
          // under no-referrer, which checkOrigin rejects ("Link Custodes account" is one).
          // Cross-origin requests still receive no referrer.
          { key: "Referrer-Policy", value: "same-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};
export default config;
