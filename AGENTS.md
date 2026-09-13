# AGENTS.md

## Release process

### Version bump points

Four files carry the version string; all must be bumped together:

| File | Field |
|---|---|
| `appinfo.json` | `version` |
| `package.json` | `version` |
| `com.cheerchen.decotv.manifest.json` | `version` |
| `com.cheerchen.decotv.manifest.json` | `ipkUrl` (filename embeds version) |

`com.cheerchen.decotv.manifest.json` `ipkHash.sha256` is **not** bumped manually — `scripts/package.sh --release` fills it after building the IPK.

### Build flow

```sh
# 1. If new files were added to the payload since last release, re-record:
scripts/package.sh --update-contents

# 2. Build IPK + sync manifest (fills sha256):
scripts/package.sh --release

# 3. After uploading, verify the published asset matches the manifest:
scripts/package.sh --verify-release
```

`ares-package` is non-reproducible — identical inputs yield different sha256. The `--release` build must be the **last** build before uploading; rebuilding invalidates the manifest hash.

### CHANGELOG

- Write the new version entry at the top of `CHANGELOG.md` **before** the release commit.
- User reviews the draft before committing.
- Do not expose ad-filter detection specifics (features used, signal types, classification thresholds) in user-facing text. Describe **what** changed and **why**, not **how** the filter identifies ads.

### Release assets

Every release has exactly **two** assets — no more, no less:

1. `com.cheerchen.decotv_<version>_all.ipk`
2. `com.cheerchen.decotv.manifest.json`

The manifest is required for Homebrew Channel auto-update. Forgetting it breaks silent updates.

### Release body format

Follow the previous release's format exactly. The established structure is:

1. Chinese section first (`## 新增` / `## 改进` / `## 修复` / `## 安装`)
2. `---` separator
3. English section (`## New` / `## Improvements` / `## Fixes` / `## Install`)
4. Install block in both languages includes the `opkg install` command with the versioned IPK filename.

Check the previous release body with `gh release view <prev-tag> --json body --jq .body` before drafting.

### Tag

Previous releases use **annotated** tags (`git tag -a`), not lightweight tags. `gh release create` creates a lightweight tag by default — after creating the release, verify the tag type and convert if needed:

```sh
git tag -d v<version>                          # delete lightweight
git tag -a v<version> -m "Release <version>"   # recreate as annotated
git push origin v<version> --force             # update remote
```

Or create the annotated tag first, then `gh release create v<version>` to attach assets to the existing tag.

### Commit message

Release commits use the format:

```
Release <version>

Docs: CHANGELOG <version> entry. Version bumps across appinfo.json /
package.json. [ipk-contents.txt re-recorded if changed]. Manifest synced
to the <version> IPK (sha256 <first 8 hex>...).
```

### Post-release verification

After `gh release create` + tag fixup, verify the release is published
(`isDraft: false`) — deleting and recreating the tag can flip the
release back to draft:

```sh
gh release view v<version> --json isDraft --jq .isDraft   # must be false
gh release edit v<version> --draft=false                  # fix if true
```
