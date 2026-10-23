# Sourced by tools/*.sh: the Command Line Tools SDK and the SwiftUI macro plugins of the selected Xcode
# (xcode-select -p; falls back to /Applications/Xcode.app). swiftc only: no xcodebuild, so no Xcode license.
SDK=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk
TARGET=arm64-apple-macos14.0
_dev="$(xcode-select -p 2>/dev/null || true)"
case "$_dev" in *.app/Contents/Developer) ;; *) _dev=/Applications/Xcode.app/Contents/Developer ;; esac
PLUGINS="$_dev/Platforms/MacOSX.platform/Developer/usr/lib/swift/host/plugins"
