# Archimedes Desktop — build & validation entry points.
#
# The project validates from TWO roots (see AGENTS.md): the frontend from
# the repo root (`pnpm`) and the Rust backend from `src-tauri/` (`cargo`).
# A branch is ready to merge when `make check` is green.
#
# One-time setup (system packages, NOT done by `setup`):
#   - Rust: pinned in src-tauri/rust-toolchain.toml (rustup honours it
#     automatically in `src-tauri/`; `make` reads it for the root recipes)
#   - Node >= 22.19
#   - Linux: libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev
#
# `build` (release) signs the updater artifacts: it needs
# TAURI_SIGNING_PRIVATE_KEY_PATH pointing at the secret key (a clean
# single-line base64 file — no trailing newline) and prompts for the
# key password. On Fedora (41+) it also auto-sets NO_STRIP=1 — the
# AppImage bundling step (linuxdeploy) fails there because the old
# `strip` frozen inside the linuxdeploy AppImage can't parse the newer
# `.relr.dyn` ELF sections in Fedora's system libraries (see README);
# override with `make build NO_STRIP=` (force off) or `NO_STRIP=1` (force on).
#
# `appimage` + `install-appimage` are the local counterparts: they build only
# the AppImage, deliberately without the updater signing step, and install it
# under the name this machine actually launches (`~/AppImages/archimedes.appimage`),
# so an OS notification can be attributed to a real installed app.

PNPM     := pnpm
RUST_DIR := src-tauri

# The Rust toolchain is pinned by `$(RUST_DIR)/rust-toolchain.toml`, but rustup
# resolves that file from the CWD and the recipes below run from the repo root
# (`--manifest-path`), which would silently use whatever `rustup default` is —
# exactly the local/CI drift the pin exists to prevent. Read the channel out of
# the file and name it, so `make check` lints and tests on the compiler CI does.
RUST_CHANNEL := $(shell sed -n 's/^channel *= *"\([^"]*\)".*/\1/p' $(RUST_DIR)/rust-toolchain.toml)
CARGO        := $(if $(RUST_CHANNEL),cargo +$(RUST_CHANNEL),cargo)

# The Fedora AppImage workaround (see header): auto-detected from
# /etc/os-release. A command-line `NO_STRIP=…` always wins (GNU make
# gives command-line variables precedence over this `?=`), and the var
# is only exported when NON-EMPTY — a non-Fedora build is untouched
# regardless of how Tauri interprets an empty value.
NO_STRIP ?= $(shell grep -q '^ID=fedora' /etc/os-release 2>/dev/null && echo 1)

# The host OS, resolved once when this file is READ: `install` refuses off
# Linux before any prerequisite is scheduled, which a recipe line cannot do.
IS_LINUX := $(filter Linux,$(shell uname -s))

# The AppImage bundle Tauri writes, and where `install-appimage` puts it. The
# destination is unversioned and spelled with a lowercase `.appimage` because
# that is the file this machine already runs: a rebuild is then an in-place
# upgrade rather than a second app beside it, and the desktop entry survives a
# version bump without being rewritten. The bundle path is hardcoded like
# `build`'s help text, so a non-default CARGO_TARGET_DIR needs `APPIMAGE_DIST=…`
# (a command line value wins over either of these, as it does for NO_STRIP).
APPIMAGE_DIST := $(RUST_DIR)/target/release/bundle/appimage
APPIMAGE      ?= $(HOME)/AppImages/archimedes.appimage

# What the desktop entry's `Exec=` runs. Empty = decide at install time (see
# `install-desktop`); set it to pin the value, e.g. `make install-desktop
# DESKTOP_EXEC=archimedes`.
DESKTOP_EXEC ?=

# The 512x512 PNG `install-desktop` installs, spelled RELATIVE to $HOME so both
# consumers below resolve the identical absolute path from the shell's own
# `$HOME` at recipe time — the entry then belongs to whoever ran the install, not
# to the home directory of whoever wrote it. Shared because `Icon=` and the
# Nautilus file metadata must name one file, and two copies of the path drift.
HICOLOR_ICON_REL := .local/share/icons/hicolor/512x512/apps/archimedes.png

.DEFAULT_GOAL := help

# ── Setup / dev ───────────────────────────────────────────────────────

# ONE entry, id `archimedes` (file name = id + `.desktop`). The entry id is only
# useful while it equals the app id the desktop actually sees, and here that is
# the EXECUTABLE name, not the bundle identifier: Tauri hands the identifier to
# GTK only when `app.enableGtkAppId` is set — `let app_id = if
# manager.config.app.enable_gtk_app_id { Some(identifier) } else { None }`
# (tauri 2.12.2 — the version `Cargo.lock` pins — src/app.rs:2446) — and this
# project never sets it (default `false`), so GTK derives the app id from
# `prgname`, i.e. `archimedes`. The window's Wayland app_id/WM_CLASS is
# therefore `archimedes`, which made `StartupWMClass=codes.archimedes.desktop`
# match no window, and the alerts carry `app_name="archimedes"` (notify-rust
# defaults it to the executable name), so that entry was never consulted for a
# notification either. The second entry was
# dead weight, and two archimedes-ish identities in the desktop database is an
# attribution hazard — exactly the mis-crediting the shared `Exec=` below was
# written to manage. Do NOT reach for `identifier` in tauri.conf.json to
# "restore" the second id: that string is the bundle/updater/D-Bus identity,
# while the entry id is a DESKTOP id whose only job is to match the app id and
# `app_name`.
#
# Also know this, because it is live on the machine this recipe was written on:
# AppImageKit's own desktop integration writes THE SAME PATH —
# `~/.local/share/applications/archimedes.desktop` — and there that file
# currently reads `Exec=env DESKTOPINTEGRATION=1
# /home/daniel/AppImages/archimedes.appimage` with
# `Icon=/home/daniel/AppImages/.icons/archimedes`, i.e. AppImageKit's copy, not
# this one. Both writers target one XDG path, so whichever ran last owns the
# file. Escape hatch, not detection: run the AppImage with
# `DESKTOPINTEGRATION=no` (or never accept its "install integration" prompt) and
# this recipe stays authoritative. Detecting or arbitrating that in make is
# deliberately not done: it is machine state this file cannot see, and the
# documented escape hatch is cheaper than a heuristic.
#
# The `Comment=` and `Categories=` below MIRROR `bundle.shortDescription` and
# `bundle.category` in tauri.conf.json — the bundler's own template is
# `Comment={{comment}}` / `Categories={{categories}}`, and AppImageKit
# republishes THAT generated file into this very path on every AppImage launch.
# Left to drift, the app's description and grid category would depend on which
# of the two writers last owned the entry.
#
# `Exec=` has one meaning here: the AppImage when one is installed at
# $(APPIMAGE), otherwise the `archimedes` on PATH. `install-appimage` therefore
# writes no entry of its own — it re-runs this recipe, so there is a single
# writer and the two targets cannot silently fight over `archimedes.desktop`;
# it also pins DESKTOP_EXEC, so the value cannot depend on the AppImage having
# landed before this recipe reads it. Cost of that choice: a standalone run
# here depends on machine state, so an AppImage you stopped using still wins —
# delete it, or pass `DESKTOP_EXEC=archimedes`, then re-run.
#
# `Icon=` is an ABSOLUTE PATH to the 512x512 PNG installed just above, not the
# themed name `archimedes`. Measured on this machine, in that order of evidence:
#
#   - with `Icon=archimedes` the app had no icon in the grid, the dash, alt-tab
#     or the alert banner, while entries here that spell an absolute path do
#     (`orcaslicer.desktop` -> `/home/daniel/AppImages/.icons/orcaslicer`,
#     `jetbrains-toolbox.desktop`, `install4j_u9hsk6-roomeqwizard.desktop`), and
#     AppImageKit's own copy of this entry — which did show the icon — used
#     `Icon=/home/daniel/AppImages/.icons/archimedes`;
#   - a FRESH GTK process agrees: `Gtk.IconTheme.has_icon("archimedes")` is FALSE
#     although the PNG sits in `~/.local/share/icons/hicolor/<size>/apps/`, while
#     it is TRUE for the 9 Chrome PWA names in those SAME directories.
#
# Do NOT take the easy lesson, "GNOME cannot resolve themed names out of
# ~/.local/share" — the Chrome PWAs are the counter-example, and chasing it gets
# the diagnosis wrong. One stale file is the whole story:
# `~/.local/share/icons/hicolor/icon-theme.cache`, last written 2026-10-01,
# ELEVEN DAYS before these PNGs landed. It indexes those 9 Chrome names and
# `zwift`, and not `archimedes`; delete it and `has_icon("archimedes")` flips to
# TRUE while Chrome's entries stay FOUND (measured on the live tree, both ways).
# The themed name was never the problem — the index of it was.
#
# So this recipe removes that index after installing, and deliberately does not
# rebuild one. The user hicolor tree has no `index.theme`, which is exactly why
# `gtk-update-icon-cache -f` exits 1 with "No theme index file." — and the
# `|| true` this recipe used to carry hid that, which is how the index went
# stale unnoticed in the first place. Writing an `index.theme` would be the
# wrong cure: it makes the cache authoritative, so any directory it fails to
# list stops resolving, and icons that work today by plain directory scan
# (another app's drop, a `scalable/apps` svg) would go missing. Removing the
# index leaves every consumer on the scan path, which sees what is on disk.
#
# The absolute `Icon=` above is still worth having, for that reason and no
# other: it bypasses theme lookup entirely, so a future stale or absent index
# cannot take the grid tile, the dash or alt-tab down with it.
#
# The alert banner goes through a different door and DOES depend on the index
# being gone: its icon is `notify_rust::Notification::auto_icon()`'s
# `exe_name()` (notify-rust 4.18.2, notification.rs:270) — the literal string
# `archimedes` on the D-Bus `app_icon`, which the daemon resolves as a THEMED
# NAME without ever reading this entry. If the banner is still iconless after
# this, that is the next suspect, and it is fixed in `attention/delivery.rs`
# (hand it a path), not here.
#
# The hicolor sizes stay installed regardless: the themed name is a public
# surface (that banner, GNOME's own lookups, anything scanning the tree).
.PHONY: install-desktop
install-desktop: ## Install desktop entry and icons to ~/.local/share (Linux only)
	@if [ "$$(uname -s)" = "Linux" ]; then \
		exec="$(DESKTOP_EXEC)"; \
		if [ -z "$$exec" ]; then \
			if [ -x "$(APPIMAGE)" ]; then exec="$(APPIMAGE) %U"; else exec="archimedes %U"; fi; \
		fi; \
		echo "  desktop Exec= $$exec"; \
		mkdir -p ~/.local/share/icons/hicolor/32x32/apps ~/.local/share/icons/hicolor/64x64/apps ~/.local/share/icons/hicolor/128x128/apps ~/.local/share/icons/hicolor/256x256/apps ~/.local/share/icons/hicolor/512x512/apps ~/.local/share/applications; \
		cp $(RUST_DIR)/icons/32x32.png ~/.local/share/icons/hicolor/32x32/apps/archimedes.png 2>/dev/null || true; \
		cp $(RUST_DIR)/icons/64x64.png ~/.local/share/icons/hicolor/64x64/apps/archimedes.png 2>/dev/null || true; \
		cp $(RUST_DIR)/icons/128x128.png ~/.local/share/icons/hicolor/128x128/apps/archimedes.png 2>/dev/null || true; \
		cp $(RUST_DIR)/icons/128x128@2x.png ~/.local/share/icons/hicolor/256x256/apps/archimedes.png 2>/dev/null || true; \
		cp $(RUST_DIR)/icons/icon.png ~/.local/share/icons/hicolor/512x512/apps/archimedes.png 2>/dev/null || true; \
		icon="$$HOME/$(HICOLOR_ICON_REL)"; \
		echo "  desktop Icon=  $$icon"; \
		printf '[Desktop Entry]\nName=Archimedes\nComment=Archimedes Desktop Coding Agent\nExec=%s\nTerminal=false\nType=Application\nIcon=%s\nCategories=Development;\nStartupWMClass=archimedes\n' "$$exec" "$$icon" > ~/.local/share/applications/archimedes.desktop; \
		update-desktop-database ~/.local/share/applications 2>/dev/null || true; \
		rm -f ~/.local/share/icons/hicolor/icon-theme.cache; \
	fi

.PHONY: setup
setup: install-desktop ## Install JS dependencies (one-time; system deps are manual)
	$(PNPM) install

.PHONY: dev
dev: install-desktop ## Run the app in the Tauri shell (Vite HMR + cargo build)
	$(PNPM) tauri dev

.PHONY: dev-web
dev-web: ## Vite dev server only (UI in a browser, no Tauri shell)
	$(PNPM) dev

# ── Frontend (repo root) ──────────────────────────────────────────────

.PHONY: build-frontend
build-frontend: ## Type-check (tsc) + build the frontend (vite)
	$(PNPM) build

.PHONY: test-frontend
test-frontend: ## Frontend unit tests (vitest)
	$(PNPM) test

# ── Rust backend (src-tauri/) ─────────────────────────────────────────

.PHONY: test-rust
test-rust: ## Rust tests
	$(CARGO) test --manifest-path $(RUST_DIR)/Cargo.toml

.PHONY: lint-rust
lint-rust: ## Rust lint (must be 0 warnings)
	$(CARGO) clippy --all-targets --manifest-path $(RUST_DIR)/Cargo.toml

.PHONY: fmt
fmt: ## Format the Rust code
	$(CARGO) fmt --manifest-path $(RUST_DIR)/Cargo.toml

.PHONY: fmt-check
fmt-check: ## Rust format check (the CI gate)
	$(CARGO) fmt --manifest-path $(RUST_DIR)/Cargo.toml --check

# ── Release ───────────────────────────────────────────────────────────

.PHONY: build
build: ## Release build → src-tauri/target/release/bundle/ (signs the updater artifacts; prompts for the key password; auto NO_STRIP=1 on Fedora)
	$(if $(NO_STRIP),NO_STRIP=$(NO_STRIP) ,)$(PNPM) tauri build

# The local AppImage, deliberately NOT the release path.
#
# tauri.conf.json sets `createUpdaterArtifacts` AND ships an updater pubkey, so
# asking for only the AppImage without a signing key builds it and then aborts
# (tauri-cli 2.11.4, measured):
#
#     Finished 1 bundle at: .../bundle/appimage/Archimedes_0.1.0_amd64.AppImage
#     Error A public key has been found, but no private key. Make sure to set
#           `TAURI_SIGNING_PRIVATE_KEY` environment variable.
#
# i.e. the artifact IS written but the command exits 1, which would leave this
# recipe looking broken on every run. The `--config` overlay turns updater
# artifacts off for THIS invocation only: nothing in the shipped config moves,
# `make build` stays the signed release path, and an unsigned bundle you run
# locally is the point here. (`--no-sign` also exits 0, but it keeps the
# updater-artifact code path alive for a payload nobody publishes from here.)
# See README → Releasing for `pnpm tauri build --no-sign`, the other unsigned build.
.PHONY: appimage
appimage: ## Build ONLY the AppImage → src-tauri/target/release/bundle/appimage/ (unsigned, no updater artifacts)
	$(if $(NO_STRIP),NO_STRIP=$(NO_STRIP) ,)$(PNPM) tauri build --bundles appimage --config '{"bundle":{"createUpdaterArtifacts":false}}'

# Installs the freshly bundled AppImage the way this machine consumes it.
# `install -m 0755` is also the chmod +x — an AppImage that is not executable
# cannot be mounted — and it replaces the destination with a fresh file instead
# of truncating it in place, which matters while the previous copy is mounted.
#
# The icons, the desktop entry, the update-desktop-database refresh and the
# removal of the stale icon index are `install-desktop`'s job, so they are
# delegated here rather than duplicated. The recursive $(MAKE) sits on a line of
# its own because make EXECUTES any recipe line that mentions $(MAKE) even under
# `-n` (the sub-plan is what gets printed): folded into the shell block above it
# would install for real during a dry run — and as a plain prerequisite, `make -j`
# could run the two in either order.
.PHONY: install-appimage
install-appimage: appimage ## Build the AppImage and install it to ~/AppImages + point the desktop entry at it (Linux only)
	@newest="$$(ls -t $(APPIMAGE_DIST)/*.AppImage 2>/dev/null | head -n1)"; \
	if [ ! -f "$$newest" ]; then \
		echo "No .AppImage in $(APPIMAGE_DIST)/ — 'make appimage' produced nothing to install."; exit 1; \
	fi; \
	mkdir -p $$(dirname "$(APPIMAGE)"); \
	install -m 0755 "$$newest" "$(APPIMAGE)"; \
	echo "Installed AppImage: $$newest -> $(APPIMAGE)"
	@$(MAKE) --no-print-directory install-desktop DESKTOP_EXEC='$(APPIMAGE) %U'
# The `.AppImage` FILE's icon in the file manager is a separate mechanism from
# the desktop entry: Nautilus keeps a per-file override for
# `metadata::custom-icon-file-uri` and draws THAT instead of the type's icon, and
# no `.desktop` can supply it — hence a step of its own here rather than a bigger
# entry. Measured here, GIO keeps this metadata in the per-user store
# `~/.local/share/gvfs-metadata/` rather than as an xattr on the file (on a
# filesystem that takes xattrs it writes `user.metadata::*` there instead), so
# read it back with the SAME HOME that wrote it: `gio info $(APPIMAGE)`. Either
# way it is machine-local — it does not travel with the AppImage — which is fine,
# it describes this install, not the artifact. Both guards are load-bearing:
# `command -v gio` for a box without GIO, and `|| true` for one where GIO refuses
# metadata at that path (measured: tmpfs, and this box's /var/tmp, both exit 1);
# an icon on a file-manager row must never fail an install. The `.desktop` above
# still owns the app's identity (grid, dash, alt-tab, notification attribution);
# this only decorates the file.
	@icon="$$HOME/$(HICOLOR_ICON_REL)"; \
	if command -v gio >/dev/null 2>&1; then \
		gio set "$(APPIMAGE)" metadata::custom-icon-file-uri "file://$$icon" >/dev/null 2>&1 || true; \
		echo "  AppImage file icon= $$icon (Nautilus metadata; check with gio info)"; \
	fi
	@echo "Run it:             $(APPIMAGE)"; \
	echo "NVIDIA: if it dies on startup, run 'WEBKIT_DISABLE_DMABUF_RENDERER=1 $(APPIMAGE)' (see README)"

# The verb people type first. `install-appimage` owns the whole procedure —
# build, copy to $(APPIMAGE), re-run `install-desktop` — so this is a name and
# nothing else: a second recipe here would be a second implementation, free to
# drift. Linux-only for the reason its prerequisite is: the artifact is an
# AppImage and the icons and the entry land in ~/.local/share, so there is
# genuinely nothing to do on macOS or Windows.
#
# The platform check is raised while the Makefile is READ, keyed on
# MAKECMDGOALS, rather than from a recipe line, for two reasons: a recipe runs
# AFTER its prerequisites, so guarding there would let `make install` on macOS
# pay for a full release build before it complained; and a recipe line is never
# executed under `-n`, so a dry run would report success on a platform where
# there is nothing to install. Gating on MAKECMDGOALS is what keeps the refusal
# tied to asking for `install` — an unconditional or prerequisite-position
# $(error) is evaluated when the file is read and would break every other goal.
# Cost of refusing only for `install`: `make install-appimage` stays reachable
# off Linux and fails in someone else's voice — tauri on the bundle step, or the
# "produced nothing to install" line above — neither of which says "wrong OS".
# Guarding it too would state the same rule in two places to keep in sync.
ifeq ($(IS_LINUX),)
ifneq ($(filter install,$(MAKECMDGOALS)),)
$(error install: needs Linux — this path installs an AppImage to $(APPIMAGE) plus an entry in ~/.local/share/applications; elsewhere run 'make build' and use the bundle under $(RUST_DIR)/target/release/bundle/)
endif
endif

.PHONY: install
install: install-appimage ## Install on this machine — builds the AppImage first, then installs it + the desktop entry (Linux only)

.PHONY: clean
clean: ## Remove build artifacts (cargo target + dist)
	$(CARGO) clean --manifest-path $(RUST_DIR)/Cargo.toml
	rm -rf dist

# ── Aggregates ────────────────────────────────────────────────────────

.PHONY: test
test: test-frontend test-rust ## All unit tests (both roots)

.PHONY: check
check: ## Full AGENTS.md validation bar (the merge gate) — sequential, fast-fail
	$(CARGO) fmt --manifest-path $(RUST_DIR)/Cargo.toml --check
	$(CARGO) clippy --all-targets --manifest-path $(RUST_DIR)/Cargo.toml
	$(CARGO) test --manifest-path $(RUST_DIR)/Cargo.toml
	$(PNPM) build
	$(PNPM) test

# ── Help ──────────────────────────────────────────────────────────────

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-17s\033[0m %s\n", $$1, $$2}'
