{
  description = "eink-mcp: MCP server that hosts files for e-ink devices and syncs them down over a public URL";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/6aefcda9401be8acc2b74244fb3b37520ea1f0a8";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forSystems = nixpkgs.lib.genAttrs systems;
    in {
      packages = forSystems (system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          mcp = pkgs.buildNpmPackage {
            pname = "eink-mcp";
            version = "0.1.0";
            src = ./.;
            npmDepsHash = "sha256-+2LxGWFxZSxQ4aQIsOk8m2aNIVlLSAAS3x996voMqss=";
            nodejs = pkgs.nodejs_24;
            npmFlags = [ "--ignore-scripts" ];
            nativeBuildInputs = [ pkgs.makeWrapper ];
            installPhase = ''
              npm prune --omit=dev --ignore-scripts --offline >/dev/null 2>&1 || true
              mkdir -p $out/lib/eink-mcp $out/bin
              cp -r dist node_modules package.json $out/lib/eink-mcp/
              makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/eink-mcp \
                --add-flags $out/lib/eink-mcp/dist/index.js \
                --set SSL_CERT_FILE ${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
            '';
          };
        in { inherit mcp; default = mcp; });

      apps = forSystems (system: {
        default = { type = "app"; program = "${self.packages.${system}.mcp}/bin/eink-mcp"; };
      });
    };
}
