# NixOS module for Astropath's Custodes client. This file is the source of truth; the vps infra flake
# imports this repo as an input via nixosModules.default.
# astropath's Custodes client registration (resource, sign-in policy, permission adapter).
# The same PERMISSIONS_ASTROPATH_SECRET (>= 32 random chars, unique) must be in the custodes
# environment and in astropath's SOPS environment (astropath/environment).
{
  services.custodes.applications = [
    {
      id = "astropath";
      name = "Astropath";
      resource = "https://astropath.porterwestling.com/mcp";
      authorization = "app-owned-v1";
      authentication = "signed-in";
      management = {
        url = "https://astropath.porterwestling.com/_custodes/permissions";
        secretEnv = "PERMISSIONS_ASTROPATH_SECRET";
      };
    }
  ];
}
