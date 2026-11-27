{
  description = "pi-fusion — virtual-model workflows for Pi";
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };
  outputs =
    { nixpkgs, flake-utils, ... }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell { packages = [ pkgs.nodejs_22 ]; };
        # These checks need no registry access; CI runs tsc and Biome after npm ci.
        checks.default =
          pkgs.runCommand "pi-fusion-check"
            {
              nativeBuildInputs = [ pkgs.nodejs_22 ];
              src = ./.;
            }
            ''
              export HOME="$TMPDIR" npm_config_cache="$TMPDIR/npm-cache"
              cp -r "$src" work
              chmod -R u+w work
              cd work
              npm test
              npm pack --dry-run
              touch "$out"
            '';

      }
    );
}
