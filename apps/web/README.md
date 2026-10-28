# span website

A dependency-free static marketing site based on the supplied span design reference. Serve this directory directly, for example with `python3 -m http.server 1430 --bind 127.0.0.1 --directory apps/web` from the repository root.

Production is hosted at https://span.kentom.co.ke. The Vercel `span` project is connected to the `main` branch of `1kentom/span`, with `apps/web` as its project root and no install or build step. Website content describes the phase 0.1 foundation and links to source instructions and GitHub Releases. A checked-in `releases.json` manifest contains verified public GitHub release metadata and distribution links. The page renders that manifest first, then attempts a public GitHub API refresh. API failures and rate limits preserve the verified manifest and permanent source-build/GitHub Releases links. It does not invent download links or release counts. No database, signup, or analytics backend is required.

Browser QA covers desktop and mobile layout, navigation, FAQ disclosure, local asset loading, heading structure, image alternatives, and source/release link destinations. This is separate from native editor verification.

See `ASSETS.md` for image, logo, and icon provenance.

Refresh the release manifest after publication with `node apps/web/scripts/sync-releases.mjs`. The script accepts `GH_TOKEN` or `GITHUB_TOKEN` for server-side API authentication when available. Credentials are never written into the public manifest.


## Download page

`/download/` uses the same verified release manifest as the homepage. It presents a platform recommendation, explicit architecture and package selectors, exact artifact filenames and sizes, SHA-256 values, release notes, and platform-specific manual installation steps. Nightly, Preview, and Stable use one custom listbox control; unpublished channels and architectures do not produce download links. A Mac browser's Intel user-agent token is not used to infer the processor.

The metadata module rejects external, mismatched-tag, and script URLs before creating download links. The local manifest renders first, while a failed, empty, older, or rate-limited public API response keeps that verified baseline available. No browser credentials or database are required.

Run the focused browser checks from the repository root:

```sh
pnpm exec playwright test --config apps/web/playwright.config.cjs
```

The suite starts its own local server on port 1431 and checks exact release links and SHA-256 values, explicit Mac architecture choice, platform/package selection, unavailable channels, selector keyboard behavior, copy success/failure, malicious URLs, API failure, mobile layouts, homepage navigation, and the JavaScript-free fallback. Its screenshots and logs remain local under the ignored artifact directory.
