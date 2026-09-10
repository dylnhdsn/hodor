#!/usr/bin/env sh
# hodor installer for unix-ish shells (Linux, WSL, macOS).
#   curl -fsSL https://github.com/dylnhdsn/hodor/releases/download/latest/install.sh | sh
# Requires Node.js >= 22. Set HODOR_NO_MODIFY_PATH=1 to skip PATH edits.
set -eu

REPO="dylnhdsn/hodor"
TAG="latest"
HODOR_HOME="${HODOR_HOME:-$HOME/.hodor}"
BIN_DIR="$HODOR_HOME/bin"
BASE_URL="https://github.com/$REPO/releases/download/$TAG"

if ! command -v node >/dev/null 2>&1; then
  echo "hodor: Node.js >= 22 is required (https://nodejs.org)" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "hodor: Node.js >= 22 is required (found $(node -v))" >&2
  exit 1
fi

mkdir -p "$BIN_DIR"

download() {
  # $1: asset name, $2: destination
  if command -v curl >/dev/null 2>&1 && curl -fsSL "$BASE_URL/$1" -o "$2"; then
    return 0
  fi
  if command -v gh >/dev/null 2>&1 &&
    gh release download "$TAG" -R "$REPO" --pattern "$1" --output "$2" --clobber; then
    return 0
  fi
  echo "hodor: failed to download $1 from $BASE_URL" >&2
  return 1
}

download hodor.mjs "$BIN_DIR/hodor.mjs.new"
mv "$BIN_DIR/hodor.mjs.new" "$BIN_DIR/hodor.mjs"

cat >"$BIN_DIR/hodor" <<EOF
#!/usr/bin/env sh
exec node "$BIN_DIR/hodor.mjs" "\$@"
EOF
chmod +x "$BIN_DIR/hodor" "$BIN_DIR/hodor.mjs"

case ":$PATH:" in
*":$BIN_DIR:"*) ;;
*)
  if [ -z "${HODOR_NO_MODIFY_PATH:-}" ]; then
    added=""
    for rc in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
      [ -f "$rc" ] || continue
      if ! grep -q '\.hodor/bin' "$rc" 2>/dev/null; then
        printf '\n# hodor\nexport PATH="$PATH:%s"\n' "$BIN_DIR" >>"$rc"
        added="$added $rc"
      fi
    done
    [ -n "$added" ] && echo "hodor: added $BIN_DIR to PATH in:$added"
    echo "hodor: restart your shell (or run: export PATH=\"\$PATH:$BIN_DIR\")"
  else
    echo "hodor: add $BIN_DIR to your PATH"
  fi
  ;;
esac

echo "hodor $("$BIN_DIR/hodor" --version) installed to $BIN_DIR"
echo "hodor: update later with: hodor update"
