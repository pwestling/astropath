# NixOS module for Astropath PostgreSQL. This file is the source of truth; the vps infra flake
# imports this repo as an input via nixosModules.default.
{ config, lib, ... }:

{
  services.postgresql = {
    # Astropath's database was created with C.utf8 to match Neon (originally named deaddrop).
    # ensureDatabases preserves it on later activations.
    ensureDatabases = [ "astropath" ];
    ensureUsers = [
      {
        name = "astropath_tenant";
        ensureClauses = { login = false; superuser = false; bypassrls = false; };
      }
      {
        name = "astropath";
        ensureDBOwnership = true;
        ensureClauses = {
          login = true;
          superuser = false;
          createdb = false;
          createrole = false;
          replication = false;
        };
      }
    ];
  };

  systemd.services.postgresql-setup.postStart = lib.mkAfter ''
    ${config.services.postgresql.finalPackage}/bin/psql --no-psqlrc \
      --set=ON_ERROR_STOP=1 --dbname=postgres \
      --command='GRANT astropath_tenant TO astropath'
  '';
}
