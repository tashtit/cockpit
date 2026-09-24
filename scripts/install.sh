#!/bin/sh
# Install or update Cockpit on macOS:
#
#   curl -fsSL https://raw.githubusercontent.com/tashtit/cockpit/main/scripts/install.sh | sh
#
# Options go through sh:  ... | sh -s -- --dry-run
#
# Why a script: releases are not yet signed with an Apple Developer ID, and macOS
# refuses to open an unsigned app that carries the quarantine flag a browser puts on
# every download — so a DMG from the releases page needs a detour through System
# Settings before its first launch. curl sets no such flag. What the browser's trust
# stood for is checked here instead:
#
#   1. the latest release is read from the GitHub REST API, and the zip for this
#      Mac's architecture is downloaded into a temporary folder;
#   2. its SHA-256 must equal the digest GitHub recorded for the asset when it was
#      uploaded — a release that lists none is refused, never installed unverified;
#   3. the bundle inside must be Cockpit (dev.tashtit.cockpit) at the release's version;
#   4. it is copied in beside any installed copy, which is renamed aside and deleted
#      only once the new one is in place — a failure in between puts the old one back.
#
# The release comes from the API and never from latest-mac.yml: that file's download
# count is how many installed copies check for updates, and an install is not one.
#
# POSIX sh and the tools every Mac ships with. Nothing here needs or asks for sudo.
#
# Environment:
#   COCKPIT_INSTALL_DIR   folder to install into. Default: where Cockpit already is
#                         (/Applications or ~/Applications), else /Applications when
#                         you can write to it, else ~/Applications
#   COCKPIT_INSTALL_API   GitHub API base URL (default https://api.github.com); the
#                         tests point it at a local server
#   COCKPIT_INSTALL_ARCH  arm64 or x64, with --dry-run only: resolve another Mac's build
#
# Everything runs from main, called on the last line, so a download of this file that
# was cut short runs nothing at all.

set -u

REPO=tashtit/cockpit
BUNDLE_ID=dev.tashtit.cockpit
RELEASES_URL="https://github.com/$REPO/releases/latest"
DEFAULT_API=https://api.github.com
NL='
'

# Set by main and read by cleanup, which runs on every exit.
tmp=''      # the download folder
stage=''    # the hidden folder beside the install that the new bundle is copied into
aside=''    # the installed bundle while it is renamed aside; non-empty means "put it back"
app=''      # <destination>/Cockpit.app

say() { printf '%s\n' "$*"; }
fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Install or update Cockpit from its latest GitHub release.

Usage: install.sh [--dry-run]

  --dry-run   show the version, download, checksum and destination; change nothing
  -h, --help  show this help

COCKPIT_INSTALL_DIR installs somewhere other than /Applications (or ~/Applications
when /Applications is not writable).
EOF
}

cleanup() {
  if [ -n "$aside" ]; then
    # stopped between the two renames: the copy that was installed goes back
    if [ ! -e "$app" ] && mv "$aside" "$app" 2>/dev/null; then
      say "The Cockpit you had is back in place." >&2
    else
      say "The Cockpit you had is at $aside; move it back to $app." >&2
      stage='' # it holds the only copy
    fi
  fi
  [ -z "$stage" ] || rm -rf "$stage"
  [ -z "$tmp" ] || rm -rf "$tmp"
}

on_signals() {
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
}

# $1 >= $2 for dotted numeric versions (13.0, 26.7.1). Anything unparseable passes:
# this only turns away a Mac that is plainly too old.
version_at_least() {
  _have=$1
  _need=$2
  while [ -n "$_have$_need" ]; do
    _h=${_have%%.*}
    _n=${_need%%.*}
    case $_have in *.*) _have=${_have#*.} ;; *) _have='' ;; esac
    case $_need in *.*) _need=${_need#*.} ;; *) _need='' ;; esac
    case "${_h:-0}${_n:-0}" in *[!0-9]*) return 0 ;; esac
    [ "${_h:-0}" -gt "${_n:-0}" ] && return 0
    [ "${_h:-0}" -lt "${_n:-0}" ] && return 1
  done
  return 0
}

# One value out of a JSON or plist file; fails on a missing key or a null.
# `plutil -extract … raw` reads JSON as well as plists (macOS 12 and later).
value_at() { plutil -extract "$2" raw -o - "$1" 2>/dev/null; }

detect_arch() {
  if [ -n "${COCKPIT_INSTALL_ARCH:-}" ]; then
    [ "$dry_run" = 1 ] || fail "COCKPIT_INSTALL_ARCH only applies with --dry-run: the build for this Mac is the one to install."
    case $COCKPIT_INSTALL_ARCH in
      arm64 | x64) arch=$COCKPIT_INSTALL_ARCH ;;
      *) fail "COCKPIT_INSTALL_ARCH must be arm64 or x64, not '$COCKPIT_INSTALL_ARCH'." ;;
    esac
    return
  fi
  case $(uname -m) in
    arm64) arch=arm64 ;;
    x86_64)
      # a shell running under Rosetta reports x86_64 on Apple silicon too
      if [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ]; then arch=arm64; else arch=x64; fi
      ;;
    *) fail "Cockpit is built for Apple silicon and Intel Macs; this one reports '$(uname -m)'." ;;
  esac
}

# Reads the latest release and picks this Mac's zip out of it.
resolve_release() {
  if [ -n "${COCKPIT_INSTALL_API:-}" ]; then
    api=${COCKPIT_INSTALL_API%/}
    https_only=''
  else
    api=$DEFAULT_API
    https_only='--proto =https --tlsv1.2'
  fi
  release="$tmp/release.json"
  # shellcheck disable=SC2086 # https_only is two options or none
  status=$(curl $https_only --silent --show-error --location \
    --user-agent cockpit-install \
    --header 'Accept: application/vnd.github+json' \
    --header 'X-GitHub-Api-Version: 2022-11-28' \
    --output "$release" --write-out '%{http_code}' \
    "$api/repos/$REPO/releases/latest") || true
  case $status in
    200) ;;
    403 | 429) fail "GitHub turned the release lookup down (HTTP $status), most likely its hourly limit on anonymous API calls from your network. Try again later, or download Cockpit from $RELEASES_URL." ;;
    404) fail "No Cockpit release is published yet. See $RELEASES_URL." ;;
    '' | 000) fail "Could not reach $api. Check your connection and try again." ;;
    *) fail "GitHub answered HTTP $status to the release lookup. Try again later, or download Cockpit from $RELEASES_URL." ;;
  esac

  tag=$(value_at "$release" tag_name) || fail "GitHub's answer names no release. Try again later."
  version=${tag#v}
  case $version in
    '' | *[!0-9A-Za-z.+-]*) fail "The latest release has a tag this installer does not understand ('$tag')." ;;
  esac
  zip_name="Cockpit-$version-$arch.zip"

  count=$(value_at "$release" assets) || count=0
  case $count in '' | *[!0-9]*) count=0 ;; esac
  asset=''
  i=0
  while [ "$i" -lt "$count" ]; do
    if [ "$(value_at "$release" "assets.$i.name")" = "$zip_name" ]; then
      asset=$i
      break
    fi
    i=$((i + 1))
  done
  [ -n "$asset" ] || fail "Cockpit $version has no $zip_name. See $RELEASES_URL."

  url=$(value_at "$release" "assets.$asset.browser_download_url") ||
    fail "GitHub lists no download address for $zip_name."
  digest=$(value_at "$release" "assets.$asset.digest") || digest=''
  sha=$(printf '%s' "${digest#sha256:}" | tr 'A-F' 'a-f')
  case $digest in sha256:*) ;; *) sha='' ;; esac
  case $sha in *[!0-9a-f]*) sha='' ;; esac
  [ "${#sha}" -eq 64 ] ||
    fail "GitHub lists no SHA-256 digest for $zip_name, so the download could not be verified. Nothing was installed; the release is at $RELEASES_URL."

  size=$(value_at "$release" "assets.$asset.size") || size=''
  case $size in
    '' | *[!0-9]*) size_note='' ;;
    *) size_note=" ($(((size + 524288) / 1048576)) MB)" ;;
  esac
}

# Where Cockpit goes, and what is there already.
choose_destination() {
  if [ -n "${COCKPIT_INSTALL_DIR:-}" ]; then
    dir=$COCKPIT_INSTALL_DIR
  elif [ -e /Applications/Cockpit.app ]; then
    dir=/Applications
  elif [ -e "$HOME/Applications/Cockpit.app" ]; then
    dir=$HOME/Applications
  elif [ -w /Applications ]; then
    dir=/Applications
  else
    dir=$HOME/Applications
  fi
  case $dir in /*) ;; *) dir="$(pwd)/$dir" ;; esac
  while :; do
    case $dir in */) dir=${dir%/} ;; *) break ;; esac
  done
  app="$dir/Cockpit.app"

  installed=''     # the version already at $app
  not_cockpit=''   # set when $app is some other app
  if [ -e "$app" ] || [ -L "$app" ]; then
    if [ "$(value_at "$app/Contents/Info.plist" CFBundleIdentifier)" = "$BUNDLE_ID" ]; then
      installed=$(value_at "$app/Contents/Info.plist" CFBundleShortVersionString) || installed='an unknown version'
    else
      not_cockpit=1
    fi
  fi
}

refuse_if_running() {
  procs=$(ps -axww -o command= 2>/dev/null) || procs=''
  case "$NL$procs" in
    *"$NL$app/Contents/MacOS/"*) fail "Cockpit is running from $app. Quit it, then run the installer again; nothing was changed." ;;
  esac
}

main() {
  dry_run=0
  for arg in "$@"; do
    case $arg in
      --dry-run) dry_run=1 ;;
      -h | --help)
        usage
        return 0
        ;;
      *) fail "Unknown option '$arg'. Try --help." ;;
    esac
  done

  # the system's own tools, whatever else is first on PATH
  PATH=/usr/bin:/bin:/usr/sbin:/sbin
  export PATH
  unset CDPATH

  os=$(uname -s)
  [ "$os" = Darwin ] || fail "Cockpit is a macOS app, and this is $os. See $RELEASES_URL for what a release ships."
  macos=$(sw_vers -productVersion 2>/dev/null) || macos=''
  version_at_least "${macos:-0}" 12 || fail "Cockpit needs a newer macOS than ${macos:-this one}."
  detect_arch
  case $arch in arm64) arch_label='Apple silicon' ;; *) arch_label='Intel' ;; esac

  tmp_base=${TMPDIR:-/tmp}
  tmp=$(mktemp -d "${tmp_base%/}/cockpit-install.XXXXXX") || fail "Could not create a temporary folder."
  trap cleanup EXIT
  on_signals

  resolve_release
  choose_destination

  if [ "$dry_run" = 1 ]; then
    if [ -n "$not_cockpit" ]; then
      note=' (holds another app; an install would stop here)'
    elif [ -n "$installed" ]; then
      note=" (replaces $installed)"
    elif [ -d "$dir" ]; then
      note=''
    else
      note=' (folder will be created)'
    fi
    say "Cockpit $version for $arch_label"
    say "  asset:       $zip_name$size_note"
    say "  url:         $url"
    say "  sha256:      $sha"
    say "  destination: $app$note"
    say "Dry run: nothing was downloaded or changed."
    return 0
  fi

  [ -z "$not_cockpit" ] ||
    fail "$app is not Cockpit (its bundle id is not $BUNDLE_ID). Move it out of the way, or set COCKPIT_INSTALL_DIR, and run the installer again."
  mkdir -p "$dir" 2>/dev/null || fail "Could not create $dir."
  dir=$(cd "$dir" && pwd) || fail "Could not open $dir."
  app="$dir/Cockpit.app"
  [ -w "$dir" ] || fail "You cannot write to $dir. Set COCKPIT_INSTALL_DIR to a folder you own (such as ~/Applications) and run the installer again."
  refuse_if_running

  say "Downloading Cockpit $version for $arch_label$size_note..."
  zip="$tmp/$zip_name"
  if [ -t 2 ]; then progress=--progress-bar; else progress=--silent; fi
  # shellcheck disable=SC2086
  curl $https_only $progress --show-error --fail --location --retry 2 \
    --user-agent cockpit-install --output "$zip" "$url" ||
    fail "The download failed. Nothing was installed; try again, or download Cockpit from $RELEASES_URL."

  got=$(shasum -a 256 "$zip" | cut -d ' ' -f 1)
  [ "$got" = "$sha" ] ||
    fail "The download does not match the SHA-256 digest GitHub lists for $zip_name (expected $sha, got ${got:-nothing}). Nothing was installed."
  say "Checksum verified."

  mkdir "$tmp/unpacked" && ditto -x -k "$zip" "$tmp/unpacked" 2>/dev/null ||
    fail "The download could not be unpacked. Nothing was installed."
  new="$tmp/unpacked/Cockpit.app"
  plist="$new/Contents/Info.plist"
  [ -d "$new" ] || fail "$zip_name holds no Cockpit.app. Nothing was installed."
  id=$(value_at "$plist" CFBundleIdentifier) || id=''
  [ "$id" = "$BUNDLE_ID" ] ||
    fail "The downloaded app is not Cockpit (bundle id '${id:-none}', expected $BUNDLE_ID). Nothing was installed."
  got_version=$(value_at "$plist" CFBundleShortVersionString) || got_version=''
  [ "$got_version" = "$version" ] ||
    fail "The downloaded app is version '${got_version:-unknown}', not the $version the release names. Nothing was installed."
  exe=$(value_at "$plist" CFBundleExecutable) || exe=''
  [ -n "$exe" ] && [ -x "$new/Contents/MacOS/$exe" ] ||
    fail "The downloaded app has no executable. Nothing was installed."
  min=$(value_at "$plist" LSMinimumSystemVersion) || min=''
  [ -z "$min" ] || version_at_least "$macos" "$min" ||
    fail "Cockpit $version needs macOS $min or later, and this Mac runs $macos. Nothing was installed."

  # Copied in beside the installed bundle first, so the swap is two renames in one folder.
  stage=$(mktemp -d "$dir/.cockpit-install.XXXXXX") || fail "Could not write to $dir. Nothing was installed."
  ditto "$new" "$stage/Cockpit.app" || fail "Copying Cockpit into $dir failed. Nothing was installed."
  refuse_if_running # the download took a while; it may have been opened since

  trap '' INT TERM HUP
  if [ -e "$app" ] || [ -L "$app" ]; then
    mv "$app" "$stage/previous.app" 2>/dev/null ||
      fail "Could not move $app aside; the Cockpit you had is untouched."
    aside="$stage/previous.app"
  fi
  mv "$stage/Cockpit.app" "$app" 2>/dev/null || fail "Could not put the new Cockpit in place at $app."
  aside=''
  on_signals
  xattr -dr com.apple.quarantine "$app" 2>/dev/null || true

  if [ -z "$installed" ]; then
    say "Installed Cockpit $version in $dir."
  elif [ "$installed" = "$version" ]; then
    say "Reinstalled Cockpit $version in $dir."
  else
    say "Updated Cockpit from $installed to $version in $dir."
  fi
  say ''
  case $dir in
    /Applications | "$HOME/Applications") say "Open it:  open -a Cockpit" ;;
    *) say "Open it:  open '$app'" ;;
  esac
  say ''
  say "Optional: confirm the release workflow built it (needs the GitHub CLI):"
  say "  gh release download $tag --repo $REPO --pattern $zip_name"
  say "  gh attestation verify $zip_name --owner tashtit"
}

main "$@" </dev/null
