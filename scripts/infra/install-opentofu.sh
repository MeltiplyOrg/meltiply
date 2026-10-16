#!/usr/bin/env bash
set -euo pipefail

version=1.12.0
expected_fingerprint=E3E6E43D84CB852EADB0051D0C0AF313E5FD9F80
install_dir="${1:-.bin}"
binary="$install_dir/tofu"

if [[ -x "$binary" ]] &&
  "$binary" version -json 2>/dev/null |
    grep -Eq "\"terraform_version\"[[:space:]]*:[[:space:]]*\"${version//./\\.}\""; then
  exit 0
fi

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *)
    echo "OpenTofu installer supports Linux and macOS" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *)
    echo "OpenTofu installer supports amd64 and arm64" >&2
    exit 1
    ;;
esac

for tool in curl gpg sha256sum tar; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool is required to install and verify OpenTofu" >&2
    exit 1
  fi
done

temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT HUP INT TERM

archive="tofu_${version}_${os}_${arch}.tar.gz"
release="https://github.com/opentofu/opentofu/releases/download/v${version}"

curl --proto '=https' --tlsv1.2 -fsSL "$release/$archive" \
  --output "$temporary/$archive"
curl --proto '=https' --tlsv1.2 -fsSL "$release/tofu_${version}_SHA256SUMS" \
  --output "$temporary/SHA256SUMS"
curl --proto '=https' --tlsv1.2 -fsSL "$release/tofu_${version}_SHA256SUMS.gpgsig" \
  --output "$temporary/SHA256SUMS.gpgsig"
curl --proto '=https' --tlsv1.2 -fsSL https://get.opentofu.org/opentofu.gpg \
  --output "$temporary/opentofu.gpg"

gpg_home="$temporary/gpg"
mkdir -m 700 "$gpg_home"
fingerprint="$(
  GNUPGHOME="$gpg_home" gpg --batch --with-colons \
    --import-options show-only --import "$temporary/opentofu.gpg" |
    awk -F: '$1 == "fpr" { print $10; exit }'
)"
if [[ "$fingerprint" != "$expected_fingerprint" ]]; then
  echo "unexpected OpenTofu signing-key fingerprint" >&2
  exit 1
fi

GNUPGHOME="$gpg_home" gpg --batch --quiet --import \
  "$temporary/opentofu.gpg"
GNUPGHOME="$gpg_home" gpg --batch --verify \
  "$temporary/SHA256SUMS.gpgsig" "$temporary/SHA256SUMS"

expected="$(
  awk -v file="$archive" '$2 == file { print $1 }' "$temporary/SHA256SUMS"
)"
actual="$(sha256sum "$temporary/$archive" | awk '{print $1}')"
if [[ -z "$expected" || "$actual" != "$expected" ]]; then
  echo "OpenTofu archive checksum mismatch" >&2
  exit 1
fi

mkdir -p "$install_dir"
tar -xzf "$temporary/$archive" -C "$temporary" tofu
install -m 0755 "$temporary/tofu" "$binary"
"$binary" version
