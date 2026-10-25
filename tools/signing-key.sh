#!/usr/bin/env bash
# One-time Android signing certificate generation and secure GPG wrapping.
# This script never sends private keystore bytes to public logs or artifacts.
set -euo pipefail
umask 077

if [ "$#" -lt 2 ]; then
  echo 'Usage: bash tools/signing-key.sh generate DIR | decrypt DIR OUTPUT_FILE' >&2
  exit 2
fi

MODE="$1"
DIRECTORY="$2"
ENCRYPTED="$DIRECTORY/openwetter-release.p12.gpg"
PUBLIC_CERT="$DIRECTORY/openwetter-release.pem"

if ! printenv OPENWETTER_SIGNING_PASSPHRASE >/dev/null ||
   [ "$(printf '%s' "$OPENWETTER_SIGNING_PASSPHRASE" | wc -c)" -lt 40 ]; then
  echo '::error::OPENWETTER_SIGNING_PASSPHRASE must be a 40+ character randomly generated secret.' >&2
  exit 1
fi

if ! command -v gpg >/dev/null || ! command -v keytool >/dev/null; then
  echo '::error::GnuPG and a JDK with keytool are required on the runner.' >&2
  exit 1
fi

TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT

case "$MODE" in
  generate)
    if [ -e "$ENCRYPTED" ] || [ -e "$PUBLIC_CERT" ]; then
      echo '::error::Signing identity already exists; refusing to replace it.' >&2
      exit 1
    fi
    mkdir -p "$DIRECTORY"
    keytool -genkeypair \
      -keystore "$TEMP/private.p12" -storetype PKCS12 \
      -alias openwetter -keyalg RSA -keysize 4096 -validity 10000 \
      -dname 'CN=OpenWetter Personal Release, O=OpenWetter, C=DE' \
      -storepass:env OPENWETTER_SIGNING_PASSPHRASE \
      -keypass:env OPENWETTER_SIGNING_PASSPHRASE
    # Encrypt before placing anything into the public Git working tree.
    printf '%s\n' "$OPENWETTER_SIGNING_PASSPHRASE" | gpg \
      --batch --yes --quiet --pinentry-mode loopback --no-symkey-cache \
      --passphrase-fd 0 --symmetric --cipher-algo AES256 \
      --s2k-mode 3 --s2k-digest-algo SHA512 --s2k-count 65011712 \
      --output "$TEMP/private.p12.gpg" "$TEMP/private.p12"
    printf '%s\n' "$OPENWETTER_SIGNING_PASSPHRASE" | gpg \
      --batch --yes --quiet --pinentry-mode loopback --no-symkey-cache \
      --passphrase-fd 0 --decrypt --output "$TEMP/verify.p12" "$TEMP/private.p12.gpg"
    cmp -s "$TEMP/private.p12" "$TEMP/verify.p12" || {
      echo '::error::Encrypted signing key failed its round-trip check.' >&2; exit 1;
    }
    keytool -exportcert -rfc -alias openwetter \
      -keystore "$TEMP/private.p12" -storetype PKCS12 \
      -storepass:env OPENWETTER_SIGNING_PASSPHRASE \
      -file "$TEMP/public.pem"
    mv "$TEMP/private.p12.gpg" "$ENCRYPTED"
    mv "$TEMP/public.pem" "$PUBLIC_CERT"
    chmod 644 "$ENCRYPTED" "$PUBLIC_CERT"
    echo 'Generated and verified an encrypted OpenWetter signing identity.'
    openssl x509 -in "$PUBLIC_CERT" -noout -fingerprint -sha256
    ;;
  decrypt)
    if [ "$#" -ne 3 ]; then
      echo '::error::Decrypt mode requires a destination filename.' >&2
      exit 2
    fi
    DESTINATION="$3"
    [ -s "$ENCRYPTED" ] && [ -s "$PUBLIC_CERT" ] || {
      echo '::error::Signing key not yet provisioned; run the provisioning workflow.' >&2
      exit 1
    }
    [ ! -e "$DESTINATION" ] || {
      echo '::error::Refusing to overwrite an existing keystore.' >&2; exit 1;
    }
    printf '%s\n' "$OPENWETTER_SIGNING_PASSPHRASE" | gpg \
      --batch --yes --quiet --pinentry-mode loopback --no-symkey-cache \
      --passphrase-fd 0 --decrypt --output "$TEMP/unlocked.p12" "$ENCRYPTED"
    keytool -list -alias openwetter \
      -keystore "$TEMP/unlocked.p12" -storetype PKCS12 \
      -storepass:env OPENWETTER_SIGNING_PASSPHRASE >/dev/null
    keytool -exportcert -alias openwetter \
      -keystore "$TEMP/unlocked.p12" -storetype PKCS12 \
      -storepass:env OPENWETTER_SIGNING_PASSPHRASE > "$TEMP/actual.der"
    openssl x509 -in "$PUBLIC_CERT" -outform DER > "$TEMP/expected.der"
    cmp -s "$TEMP/actual.der" "$TEMP/expected.der" || {
      echo '::error::Encrypted private signing key does not match the committed public certificate.' >&2
      exit 1
    }
    mv "$TEMP/unlocked.p12" "$DESTINATION"
    chmod 600 "$DESTINATION"
    echo 'Keystore decrypted and certificate identity verified.'
    ;;
  *)
    echo '::error::Unknown signing-key operation.' >&2
    exit 2
    ;;
esac
