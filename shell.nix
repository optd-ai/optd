# Development shell for raw-process integration tests.
# Production is container-only; this shell provides Deno/Postgres locally for dev/tests.
#
# To update: replace nixpkgsUrl with a new nixpkgs archive URL/commit and verify
# `deno --version` and `postgres --version` in `direnv reload`.

let
  nixpkgsUrl = "https://github.com/NixOS/nixpkgs/archive/nixos-unstable.tar.gz";
  pkgs = import (builtins.fetchTarball nixpkgsUrl) {};
in
pkgs.mkShell {
  packages = with pkgs; [
    deno
    postgresql
    jq
    curl
    git
  ];

  shellHook = ''
    export OPERANT_DEV_SHELL=1
    export OPERANT_PG_BIN_DIR=${pkgs.postgresql}/bin
    export OPERANT_DATA_DIR="$PWD/.operant-data"
    mkdir -p "$OPERANT_DATA_DIR"
    echo "operant dev shell"
    echo "  deno:      $(deno --version | head -n1)"
    echo "  postgres:  $(postgres --version)"
    echo "  pg bin:    $OPERANT_PG_BIN_DIR"
  '';
}
