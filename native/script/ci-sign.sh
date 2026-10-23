#!/usr/bin/env bash
# Signed builds on the macOS runner. Manual signing only: the archive never uses -allowProvisioningUpdates, so a
# clean runner cannot mint Apple Development certificates (each run used to create one until the account hit its cap).
#   script/ci-sign.sh mac          DroverMac (+ macOS widgets, Safari extension), DroverMenuBar: Developer ID, notarized,
#                                  stapled, zipped into dist/
#   script/ci-sign.sh testflight   DroveriOS (+ watch app, widgets, Safari extension): archived and uploaded to TestFlight
#                                  (each app needs its App Store Connect record first)
# Signing material: a .p12 per mode, imported into a throwaway keychain, and provisioning profiles that
# script/asc-signing.py creates through the ASC API for exactly the bundle IDs below (named drover-ci-<bundle id>).
# Env: DROVER_TEAM_ID, ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH (the .p8 file), and
#   mac:        DROVER_DEVID_P12 (base64 .p12 of "Developer ID Application"), DROVER_DEVID_P12_PASSWORD
#   testflight: DROVER_DIST_P12  (base64 .p12 of "Apple Distribution"),      DROVER_DIST_P12_PASSWORD
# Never prints their values.
set -euo pipefail
cd "$(dirname "$0")/.."

mode="${1:?mac|testflight}"
: "${DROVER_TEAM_ID:?DROVER_TEAM_ID is not set}"
: "${ASC_KEY_ID:?ASC_KEY_ID is not set}"
: "${ASC_ISSUER_ID:?ASC_ISSUER_ID is not set}"
: "${ASC_KEY_PATH:?ASC_KEY_PATH is not set}"
[ -f "$ASC_KEY_PATH" ] || { echo "ASC_KEY_PATH does not point at a file" >&2; exit 2; }

export DROVER_TEAM_ID
script/generate.sh

PROJECT=Drover.xcodeproj
work=.build/sign
dist=dist
rm -rf "$work" "$dist"; mkdir -p "$work" "$dist"

# Bundle IDs per mode (CONTRACT.md "Apple identifiers"; keep in sync with the *.part.yml targets).
case "$mode" in
  mac)
    ids=(dev.drover.macos dev.drover.macos.widgets dev.drover.macos.safari dev.drover.menubar)
    ptype=MAC_APP_DIRECT; identity="Developer ID Application"; p12_var=DROVER_DEVID_P12 ;;
  testflight)
    ids=(dev.drover.app dev.drover.app.widgets dev.drover.app.safari dev.drover.app.watchkitapp
         dev.drover.app.watchkitapp.widgets)
    ptype=IOS_APP_STORE; identity="Apple Distribution"; p12_var=DROVER_DIST_P12 ;;
  *) echo "unknown mode $mode" >&2; exit 2 ;;
esac
p12_pw_var="${p12_var}_PASSWORD"
p12_b64="${!p12_var:-}"; p12_pw="${!p12_pw_var:-}"
[ -n "$p12_b64" ] || { echo "$p12_var is not set: add the $identity certificate as a base64 .p12 secret" >&2; exit 2; }

# Throwaway keychain holding only the signing identity; removed (with the installed profiles) on exit.
keychain="${RUNNER_TEMP:-$(mktemp -d)}/drover-sign.keychain-db"
kc_pw="$(openssl rand -hex 16)"
installed_profiles="$work/profiles"
cleanup() {
  security delete-keychain "$keychain" 2>/dev/null || true
  for f in "$installed_profiles"/*; do
    [ -f "$f" ] || continue
    uuid="$(security cms -D -i "$f" 2>/dev/null | /usr/libexec/PlistBuddy -c 'Print :UUID' /dev/stdin 2>/dev/null || true)"
    [ -z "$uuid" ] || rm -f "$HOME/Library/MobileDevice/Provisioning Profiles/$uuid".*
  done
}
trap cleanup EXIT
security create-keychain -p "$kc_pw" "$keychain"
security set-keychain-settings -lut 21600 "$keychain"
security unlock-keychain -p "$kc_pw" "$keychain"
p12="$work/signing.p12"
printf '%s' "$p12_b64" | base64 --decode > "$p12"
security import "$p12" -k "$keychain" -P "$p12_pw" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
rm -f "$p12"
security set-key-partition-list -S apple-tool:,apple: -s -k "$kc_pw" "$keychain" >/dev/null
# shellcheck disable=SC2046
security list-keychains -d user -s "$keychain" $(security list-keychains -d user | tr -d '"')
security find-identity -v -p codesigning "$keychain" | grep -q "$identity" \
  || { echo "no \"$identity\" identity in $p12_var" >&2; exit 2; }
security find-certificate -c "$identity" -p "$keychain" > "$work/signing-cert.pem"

echo "== provisioning profiles ($ptype)"
python3 script/asc-signing.py profiles --type "$ptype" --cert-pem "$work/signing-cert.pem" --out "$installed_profiles" "${ids[@]}"

# Manual signing for every target. The profile specifier is expanded per target from its bundle ID.
# shellcheck disable=SC2016
sign_settings=(CODE_SIGN_STYLE=Manual "CODE_SIGN_IDENTITY=$identity" "DEVELOPMENT_TEAM=$DROVER_TEAM_ID"
               'PROVISIONING_PROFILE_SPECIFIER=drover-ci-$(PRODUCT_BUNDLE_IDENTIFIER)'
               "OTHER_CODE_SIGN_FLAGS=--keychain $keychain")
[ "$mode" != mac ] || sign_settings+=(ENABLE_HARDENED_RUNTIME=YES)

# Only the export step talks to App Store Connect (cloud-signing is off: signingStyle manual).
auth=(-authenticationKeyPath "$ASC_KEY_PATH"
      -authenticationKeyID "$ASC_KEY_ID"
      -authenticationKeyIssuerID "$ASC_ISSUER_ID")

export_options() { # method destination -> plist path
  local plist="$work/export-$1-$2.plist" id
  {
    cat <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>$1</string>
	<key>destination</key>
	<string>$2</string>
	<key>signingStyle</key>
	<string>manual</string>
	<key>signingCertificate</key>
	<string>$identity</string>
	<key>teamID</key>
	<string>$DROVER_TEAM_ID</string>
	<key>provisioningProfiles</key>
	<dict>
PLIST
    for id in "${ids[@]}"; do
      printf '\t\t<key>%s</key>\n\t\t<string>drover-ci-%s</string>\n' "$id" "$id"
    done
    printf '\t</dict>\n</dict>\n</plist>\n'
  } > "$plist"
  echo "$plist"
}

archive() { # scheme destination -> archive path
  local path="$work/$1.xcarchive" log="$work/$1-archive.log"
  echo "== archive $1 ($2)" >&2
  if ! xcodebuild archive -project "$PROJECT" -scheme "$1" -configuration Release -destination "$2" \
      -archivePath "$path" -skipPackagePluginValidation "${sign_settings[@]}" >"$log" 2>&1; then
    grep -E 'error:|xcodebuild: error' "$log" | sort -u | head -40 >&2 || true
    tail -n 40 "$log" >&2
    return 1
  fi
  echo "$path"
}

export_archive() { # archive method destination outdir
  local log="$4/export.log"
  mkdir -p "$4"
  if ! xcodebuild -exportArchive -archivePath "$1" -exportOptionsPlist "$(export_options "$2" "$3")" \
      -exportPath "$4" "${auth[@]}" >"$log" 2>&1; then
    grep -E 'error:|xcodebuild: error' "$log" | sort -u | head -40 >&2 || true
    tail -n 40 "$log" >&2
    return 1
  fi
}

notarize() { # app path -> zip in dist/
  local app="$1" name zip
  name="$(basename "$app" .app)"
  zip="$work/$name-notary.zip"
  echo "== notarize $name"
  ditto -c -k --keepParent "$app" "$zip"
  xcrun notarytool submit "$zip" --key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" \
    --wait --timeout 30m --output-format json > "$work/$name-notary.json"
  python3 - "$work/$name-notary.json" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
print("notary:", r.get("status"), r.get("id"))
sys.exit(0 if r.get("status") == "Accepted" else 1)
PY
  xcrun stapler staple "$app"
  spctl --assess --type execute --verbose=2 "$app"
  ditto -c -k --keepParent "$app" "$dist/$name.zip"
}

failed=()
case "$mode" in
  mac)
    for scheme in DroverMac DroverMenuBar; do
      if ! arch="$(archive "$scheme" "generic/platform=macOS")"; then failed+=("$scheme archive"); continue; fi
      out="$work/$scheme-export"
      if ! export_archive "$arch" developer-id export "$out"; then failed+=("$scheme export"); continue; fi
      for app in "$out"/*.app; do
        notarize "$app" || failed+=("$scheme notarize")
      done
    done
    ;;
  testflight)
    for scheme in DroveriOS; do
      if ! arch="$(archive "$scheme" "generic/platform=iOS")"; then failed+=("$scheme archive"); continue; fi
      echo "== upload $scheme to TestFlight"
      export_archive "$arch" app-store-connect upload "$work/$scheme-upload" || failed+=("$scheme upload")
    done
    ;;
esac

ls -la "$dist" 2>/dev/null || true
if [ "${#failed[@]}" -gt 0 ]; then
  echo "FAILED: ${failed[*]}"
  exit 1
fi
echo "all ok"
