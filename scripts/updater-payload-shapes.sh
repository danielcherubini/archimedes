#!/usr/bin/env bash
#
# updater-payload-shapes.sh — the ONE definition of "which release-asset names are
# updater payloads". SOURCED, never run:
#
#   . "$(dirname "${BASH_SOURCE[0]}")/updater-payload-shapes.sh"
#
# Consumers (both of them, which is the entire point of the file):
#
#   * scripts/compose-updater-manifest.sh — its matcher, whose `case` arms turn a
#     `.sig` name into a platform key, and the operator-facing hint it prints when
#     a name matches none of them (`updater_payload_shape_hint`).
#   * scripts/check-release-signatures.sh — the release-side gate, which asks the
#     MIRROR question of the asset list: a `X.sig` whose payload name IS one of
#     these shapes must have `X` on the release with it.
#
# WHY A SHARED FILE RATHER THAN A "KEEP THESE IN SYNC" COMMENT. The two lists are
# not cosmetic copies of the same string; the gate's mirror check is exactly as
# wide as the composer's matcher. Add a bundler shape to the composer's arms and
# forget it here, and the gate silently stops requiring the payload for THAT
# shape's orphaned signature — which is the exact 404-URL-in-latest.json hole the
# mirror check exists to close, re-opened for one platform, invisible in CI
# because no release carries the new shape yet. A comment can only recommend; one
# sourced definition removes the copy that could go stale. Duplication with an
# equality test was the other option, and it was rejected because the copies still
# exist and only the test keeps them honest. What the shared file does NOT prevent,
# though, is drift in the other direction: the composer's matcher is a `case` whose
# arms also assign platform slots and carry per-format reasoning, so it cannot move
# here, and someone can still add an arm there and forget this list. That gap is
# closed by the equality pin in compose-updater-manifest.test.sh ("THE SHARED
# VOCABULARY", case 17), which extracts the pattern list from both files and
# requires the same set. Shared definition PLUS equality pin — one without the other
# leaves a hole.
#
# WHAT THIS FILE IS NOT: it is the VOCABULARY, not the matching. It answers
# "could a bundler emit NAME as an updater payload?" and nothing else — no slots,
# no keys, no `--arch` policy. The composer still owns which slot a shape claims.
#
# The arms are spelled ONE PER LINE, as `<glob>) return 0 ;;`, on purpose: that is
# the same shape the composer's matcher arms have, which is what lets one awk
# extract the pattern list from either file. Do not collapse them onto one line.

# The operator-facing list, quoted verbatim in the composer's "unrecognized
# signature" failure. It is the same string that lived in that script's
# `accepted_suffixes` before this file existed.
#
# Every pattern here is spelled EXACTLY as the matcher arm spells it, and the
# composer harness asserts that (case 17, "the accepted-suffix hint mentions …").
# That pin paid for itself the day it was written: the string used to advertise
# `*_setup.exe`, while the arm is `*-setup.exe` and the real asset is
# `Archimedes_0.2.0_x64-setup.exe` — so an operator holding a rejected NSIS
# installer was told to look for a suffix the bundler never produces, and would
# have concluded their asset name was wrong when it was right. The wording is also
# pinned from the other side (the failure must name the rpm shape, or an operator
# holding a rejected rpm has no idea what the matcher wanted).
updater_payload_shape_hint='*_x64-setup.nsis.zip, *-setup.exe (the raw NSIS installer), *_amd64.AppImage, *_amd64.AppImage.tar.gz, *_amd64.deb, *.x86_64.rpm or *_x86_64.rpm (the rpm name is dot-separated by tauri-bundler, so the dot spelling is the real one), *.app.tar.gz (the last one needs --arch)'

# is_updater_payload_shape NAME — 0 if NAME is a shape some bundler produces as an
# updater payload, 1 otherwise. A question about the NAME only: it does not say the
# name has a signature, a key, or a platform, and for `*.app.tar.gz` it does not
# care whether `--arch` was passed (that is the composer's policy, not the shape).
#
# `*.x86_64.rpm` and `*_x86_64.rpm` are both arms because tauri-bundler's rpm
# module builds `{product_name}-{version}-{release}.{arch}.rpm` (dot-separated)
# while a deb-shaped guess at the same arch would be underscore-separated, and the
# composer accepts either since both can only be x86_64 rpms.
#
# NOT included, and deliberately: `.dmg` (never an updater payload, never signed)
# and `latest.json` (the manifest itself). A `.sig` for either is not this check's
# business — an orphaned `X.dmg.sig` produces no 404 URL, because the composer
# refuses any `.sig` whose payload is not one of the shapes below.
is_updater_payload_shape() {
  case "$1" in
    *_x64-setup.nsis.zip) return 0 ;;
    *-setup.exe) return 0 ;;
    *_amd64.AppImage.tar.gz) return 0 ;;
    *_amd64.AppImage) return 0 ;;
    *_amd64.deb) return 0 ;;
    *.x86_64.rpm) return 0 ;;
    *_x86_64.rpm) return 0 ;;
    *.app.tar.gz) return 0 ;;
    *) return 1 ;;
  esac
}
