# NixOS module for Astropath. This file is the source of truth; the vps infra flake
# imports this repo as an input via nixosModules.default.
{ config, pkgs, craftworldSecrets, ... }:

{
  sops.secrets."astropath/environment" = {
    sopsFile = craftworldSecrets + "/astropath.yaml";
    key = "environment";
    # Preserve existing deployment-script checks while managing the target in RAM.
    path = "/var/lib/app-secrets/astropath.env";
    mode = "0400";
    restartUnits = [ "astropath.service" ];
  };

  users.groups.astropath = { };
  users.users.astropath = {
    isSystemUser = true;
    group = "astropath";
    home = "/var/lib/astropath";
    hashedPassword = "!";
  };

  systemd.services.astropath = {
    description = "Astropath web application";
    wantedBy = [ "multi-user.target" ];
    # Custodes sign-in reads its discovery document at startup.
    wants = [ "network-online.target" "custodes.service" ];
    after = [ "network-online.target" "postgresql.target" "sops-install-secrets.service" "custodes.service" ];
    requires = [ "postgresql.target" "sops-install-secrets.service" ];
    startLimitIntervalSec = 60;
    startLimitBurst = 5;
    unitConfig.ConditionPathExists = "/srv/astropath/current/server.js";
    environment = {
      NODE_ENV = "production";
      HOSTNAME = "127.0.0.1";
      PORT = "4310";
      NEXT_TELEMETRY_DISABLED = "1";
      HOME = "/var/lib/astropath";
      # Projects overview: cogitator's (formerly aigateway) ChatGPT-plan key on loopback. Not a
      # secret; each workspace owner must still opt in before content is sent.
      ASTROPATH_AI_BASE_URL = "http://127.0.0.1:4340/chatgpt/v1";
      ASTROPATH_PROJECTS_MODEL = "gpt-5.6-sol";
    };
    serviceConfig = {
      User = "astropath";
      Group = "astropath";
      Slice = "apps.slice";
      WorkingDirectory = "/srv/astropath/current";
      ExecStart = "${pkgs.nodejs_24}/bin/node /srv/astropath/current/server.js";
      EnvironmentFile = config.sops.secrets."astropath/environment".path;
      StateDirectory = "astropath";
      StateDirectoryMode = "0750";
      CacheDirectory = "astropath";
      CacheDirectoryMode = "0750";
      UMask = "0027";
      Restart = "on-failure";
      RestartSec = "5s";
      TimeoutStopSec = "30s";
      NoNewPrivileges = true;
      PrivateTmp = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      PrivateDevices = true;
      ProtectKernelTunables = true;
      ProtectKernelModules = true;
      ProtectKernelLogs = true;
      ProtectControlGroups = true;
      RestrictSUIDSGID = true;
      RestrictRealtime = true;
      CapabilityBoundingSet = "";
      AmbientCapabilities = "";
      LimitCORE = 0;
      MemoryHigh = "512M";
      MemoryMax = "768M";
      MemorySwapMax = "128M";
      TasksMax = 256;
      CPUWeight = 100;
      OOMPolicy = "kill";
    };
  };

  security.acme = {
    acceptTerms = true;
    defaults.email = "pwestling@gmail.com";
  };
  services.nginx.virtualHosts."astropath.porterwestling.com" = {
    enableACME = true;
    forceSSL = true;
    extraConfig = ''
      access_log off;
      client_max_body_size 100m;
    '';
    locations."/" = {
      proxyPass = "http://127.0.0.1:4310";
      extraConfig = ''
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
      '';
    };
  };

  # Keep old bookmarks usable; agents must reconnect at the canonical origin.
  services.nginx.virtualHosts."deaddrop.thehivemind5.com" = {
    enableACME = true;
    forceSSL = true;
    extraConfig = "access_log off;";
    locations."/".return = "308 https://astropath.porterwestling.com$request_uri";
  };

  networking.firewall.allowedTCPPorts = [ 443 ];
}
