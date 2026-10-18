# NixOS module for Astropath's Custodes client. This file is the source of truth; the vps infra flake
# imports this repo as an input via nixosModules.default.
# astropath's Custodes client registration (resource and sign-in policy).
{
  services.custodes.applications = [
    {
      id = "astropath";
      name = "Astropath";
      resource = "https://astropath.porterwestling.com/mcp";
      authorization = "app-owned-v1";
      authentication = "signed-in";
    }
  ];
}
