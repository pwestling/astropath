// Startup notices only: a missing Custodes setting disables that feature, never the app.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { custodesConfig } = await import("./lib/custodes/config");
  const { permissionHandler } = await import("./lib/permissions/runtime");
  if (
    process.env.CUSTODES_CLIENT_ID ||
    process.env.CUSTODES_CLIENT_SECRET ||
    process.env.CUSTODES_ORIGIN
  ) {
    if (!custodesConfig())
      console.warn(
        "Custodes sign-in disabled: CUSTODES_ORIGIN (https), CUSTODES_CLIENT_ID and CUSTODES_CLIENT_SECRET must all be set.",
      );
    permissionHandler(); // logs once if PERMISSIONS_ASTROPATH_SECRET is unusable
  }
}
