# span website

A dependency-free static marketing site based on the supplied span design reference. Serve this directory directly, for example with `python3 -m http.server 1430 --bind 127.0.0.1 --directory apps/web` from the repository root.

Production is hosted at https://span.kentom.co.ke. The Vercel `span` project is connected to the `main` branch of `1kentom/span`, with `apps/web` as its project root and no install or build step. Website content describes the phase 0.1 foundation and links to source instructions and GitHub Releases. A checked-in `releases.json` manifest contains verified public GitHub release metadata and distribution links. The page renders that manifest first, then attempts a public GitHub API refresh. API failures and rate limits preserve the verified manifest and permanent source-build/GitHub Releases links. It does not invent download links or release counts. No database, signup, or analytics backend is required.

Browser QA covers desktop and mobile layout, navigation, FAQ disclosure, local asset loading, heading structure, image alternatives, and source/release link destinations. This is separate from native editor verification.

See `ASSETS.md` for image, logo, and icon provenance.

Refresh one published release using a required server-side `GH_TOKEN` or `GITHUB_TOKEN` environment variable:

```sh
node apps/web/scripts/sync-releases.mjs \
  --tag v0.1.0-nightly.20261028.27 --channel nightly
```

The helper validates the exact published tag, repository, five installer formats, asset URLs, sizes, digests, and checksums before atomically updating `releases.json`. It retains the newest release per channel and preserves the previous bytes on failure. Credentials are never written into the public manifest. The release publication job runs this helper and commits only the generated manifest through bounded fast-forward retries. Verify the resulting external Vercel deployment separately; Actions recursion suppression does not establish that deployment.

Run the helper regression suite with `node --test apps/web/scripts/sync-releases.test.mjs`. For a failed post-publication metadata update, use the main-only `Refresh release metadata` dispatch described in `docs/releases.md`; do not recreate the release tag or rerun installer publication.


## Download page

`/download/` uses the same verified release manifest as the homepage. It presents a platform recommendation, explicit architecture and package selectors, exact artifact filenames and sizes, SHA-256 values, release notes, and platform-specific manual installation steps. Nightly, Preview, and Stable use one custom listbox control; unpublished channels and architectures do not produce download links. A Mac browser's Intel user-agent token is not used to infer the processor.

The metadata module rejects external, mismatched-tag, and script URLs before creating download links. The local manifest renders first. A failed, empty, older, partial or rate-limited public API response keeps verified baseline files and channel heads available. Installer links require a positive size and SHA-256 digest. A newer notes-only release can appear in the history without replacing an installable download. No browser credentials or database are required.

Run the focused browser checks from the repository root:

```sh
pnpm exec playwright test --config apps/web/playwright.config.cjs
```

The suite starts its own local server on port 1431 and checks exact release links and SHA-256 values, explicit Mac architecture choice, platform/package selection, unavailable channels, selector keyboard behavior, copy success/failure, malicious URLs, API failure, mobile layouts, homepage navigation, and the JavaScript-free fallback. Its screenshots and logs remain local under the ignored artifact directory.


## Changelog

`/changelog/` presents a dated release timeline, a version index, channel filtering and expandable complete notes. The newest entry opens initially. Direct version fragments open and focus the corresponding release after its feed arrives. The homepage shows short readable summaries linked to the full entries. Platform summaries are derived from the actual available installers.

The release-note renderer creates DOM nodes without `innerHTML`. It supports headings, paragraphs, ordered and unordered lists, code fences, inline code, emphasis, block quotes and absolute HTTPS links. Raw HTML remains text, Markdown images do not load, and non-HTTPS or credential-bearing links are not made clickable. GitHub remains the source for the complete release archive and unsupported Markdown details. No database or browser API token is needed.

The browser suite also exercises readable notes, hostile Markdown, partial and older API feeds, notes-only releases, channel keyboard controls, direct version navigation, JavaScript-free fallback and 320/390/1440px wrapping. Use Node 22 as specified by the repository. Run the publication helper tests separately with `node --test apps/web/scripts/sync-releases.test.mjs`.

A successful source merge is not proof of a new production deployment. Vercel quota failures can leave the previous bundled manifest live even when GitHub has newer releases; verify the actual source SHA and hosted `releases.json` before declaring release freshness complete. Keep the existing deployment/project and retry when eligible. Do not bypass the quota with another project or plan change.
