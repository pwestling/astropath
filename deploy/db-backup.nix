# NixOS module for Astropath database backups. This file is the source of truth; the vps infra flake
# imports this repo as an input via nixosModules.default.
{ config, pkgs, ... }:

let
  backupCommand = pkgs.writeShellApplication {
    name = "astropath-db-backup";
    runtimeInputs = [ config.services.postgresql.finalPackage pkgs.age pkgs.awscli2 pkgs.coreutils ];
    text = ''
      set -euo pipefail
      umask 077
      export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
      export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
      export AWS_DEFAULT_REGION=auto
      export AWS_EC2_METADATA_DISABLED=true
      export AWS_CONFIG_FILE=/dev/null
      export AWS_SHARED_CREDENTIALS_FILE=/dev/null

      endpoint="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
      stamp="$(date -u +%Y%m%dT%H%M%SZ)"
      temporary="$(mktemp -d "$STATE_DIRECTORY/tmp.XXXXXXXX")"
      trap 'rm -rf -- "$temporary"' EXIT

      # FORCE RLS applies even to the table owner. Refuse a partial backup unless
      # every protected table explicitly grants this login an unrestricted SELECT.
      missing_policy="$(psql --no-psqlrc --host=/run/postgresql --username=astropath \
        --dbname=astropath --tuples-only --no-align --set=ON_ERROR_STOP=1 --command="
          SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relrowsecurity AND (
            EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid
              AND NOT p.polpermissive AND p.polcmd IN ('*','r')) OR NOT EXISTS (
            SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polpermissive
            AND p.polcmd IN ('*','r') AND pg_get_expr(p.polqual,p.polrelid)='true'
            AND (0=ANY(p.polroles) OR (SELECT oid FROM pg_roles WHERE rolname=current_user)=ANY(p.polroles))))")"
      test "$missing_policy" = 0
      pg_dump --enable-row-security --host=/run/postgresql --username=astropath --dbname=astropath \
        --format=custom --file="$temporary/astropath.dump"
      age \
        -r age1crrmlmtnzda9d9s88959vpkz3cw5t7sa00qk7qnt6ucz407ydczs62h8cd \
        -r age1hmwfnxztqlelg0zuuwsqnkmce8kdj0vxwa67n4fa0nas294qu9sskw23na \
        -o "$temporary/astropath.dump.age" "$temporary/astropath.dump"
      rm -- "$temporary/astropath.dump"

      key="db-backups/astropath/$stamp-$(sha256sum "$temporary/astropath.dump.age" | cut -c1-12).dump.age"
      aws --endpoint-url "$endpoint" s3 cp --only-show-errors --no-progress \
        "$temporary/astropath.dump.age" "s3://$R2_BUCKET/$key"
      uploaded="$(aws --endpoint-url "$endpoint" s3api head-object \
        --bucket "$R2_BUCKET" --key "$key" --query ContentLength --output text)"
      test "$uploaded" = "$(stat -c %s "$temporary/astropath.dump.age")"
      printf '%s %s\n' "$key" "$uploaded" > "$STATE_DIRECTORY/last-success.new"
      mv -- "$STATE_DIRECTORY/last-success.new" "$STATE_DIRECTORY/last-success"
    '';
  };
in
{
  systemd.services.astropath-db-backup = {
    description = "Encrypt and upload a Astropath PostgreSQL backup to R2";
    after = [ "network-online.target" "postgresql.target" "sops-install-secrets.service" ];
    requires = [ "postgresql.target" "sops-install-secrets.service" ];
    wants = [ "network-online.target" ];
    unitConfig.ConditionPathExists = "/var/lib/astropath/local-postgres-active";
    serviceConfig = {
      Type = "oneshot";
      User = "astropath";
      Group = "astropath";
      Slice = "apps.slice";
      EnvironmentFile = config.sops.secrets."astropath/environment".path;
      ExecStart = "${backupCommand}/bin/astropath-db-backup";
      StateDirectory = "astropath-db-backup";
      StateDirectoryMode = "0700";
      UMask = "0077";
      NoNewPrivileges = true;
      PrivateTmp = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      MemoryMax = "1G";
      TasksMax = 256;
    };
  };

  systemd.timers.astropath-db-backup = {
    description = "Daily Astropath PostgreSQL backup";
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnCalendar = "*-*-* 03:15:00 UTC";
      Persistent = true;
      RandomizedDelaySec = "15m";
    };
  };
}
