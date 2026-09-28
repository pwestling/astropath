export function GET() {
  return Response.json({ status: "ok", service: "astropath", version: "0.1.0" });
}
