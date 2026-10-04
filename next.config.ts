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
          { key: "Referrer-Policy", value: "no-referrer" },
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
