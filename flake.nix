{
  inputs = {
    nixpkgs.url = "nixpkgs/nixpkgs-unstable";
  };

  outputs = {nixpkgs, ...}: let
    systems = [
      "x86_64-linux"
      "aarch64-linux"
      "x86_64-darwin"
      "aarch64-darwin"
    ];
    forAllSystems = f:
      builtins.listToAttrs (map (system: {
          name = system;
          value = f system;
        })
        systems);
  in {
    lib = forAllSystems (system: let
      pkgs = import nixpkgs {inherit system;};
      lib = pkgs.lib;

      src = lib.cleanSourceWith {
        src = ./.;
        filter = path: type:
          builtins.any (p: lib.hasInfix p path) [
            "styles"
            "scripts"
            "package.json"
            "package-lock.json"
          ];
      };
    in {
      mkUserStyles = palette:
        pkgs.buildNpmPackage {
          pname = "usercss";
          version = "0.1.0";
          inherit src;
          npmDepsHash = "sha256-bCHVYc3Qb1sa54O1gn63HQDTkn5B8OUu6FLuMusoGqE=";
          dontNpmBuild = true;
          installPhase = let
            paletteJson = pkgs.writeText "palette.json" (builtins.toJSON palette);
          in ''
            node scripts/generate-usercontent.js ${paletteJson} > $out
          '';
        };

      uBlockRules = let
        rulesDir = ./rules;
        files = builtins.attrNames (builtins.readDir rulesDir);
        contents = map (f: builtins.readFile (rulesDir + "/${f}")) files;
      in
        pkgs.writeText "ublock-rules.txt" (lib.concatStringsSep "\n" contents);
    });
  };
}
