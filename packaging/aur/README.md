# AUR packaging

> **Upstream packaging, not d4research.** The files here package the upstream [pingdotgg/t3code](https://github.com/pingdotgg/t3code) AppImage (T3 Code, MIT, Copyright (c) 2026 T3 Tools Inc.) under the AUR maintainer named in each PKGBUILD. They do not install d4research.

This directory maintains the [`t3code-bin`](https://aur.archlinux.org/packages/t3code-bin) and
[`t3code-nightly-bin`](https://aur.archlinux.org/packages/t3code-nightly-bin) packages. Both
repackage the official x86_64 and ARM64 AppImages from GitHub Releases.

## Publishing

`.github/workflows/publish-aur.yml` supports calls from another workflow and manual runs
for a specific tag. Publishing runs only in `pingdotgg/t3code`. It selects the stable or nightly
package, then updates its version and both architectures' asset names and checksums, builds it
for the host architecture, regenerates `.SRCINFO`, and pushes it to the AUR.

To validate a release on Arch Linux:

```bash
sudo pacman -Syu --needed base-devel github-cli jq namcap
GH_TOKEN=$(gh auth token) RELEASE_TAG=v0.1.7 \
  packaging/aur/scripts/release.sh
```
