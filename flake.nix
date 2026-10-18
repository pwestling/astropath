{
  description = "astropath: NixOS module for Porter's hosts";
  outputs = { self }: {
    nixosModules.default = {
      imports = [
        ./deploy/nixos.nix
        ./deploy/db-backup.nix
        ./deploy/custodes-client.nix
        ./deploy/postgresql.nix
      ];
    };
  };
}
