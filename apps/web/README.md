# span website

A dependency-free static marketing site based on the supplied span design reference. Serve this directory directly, for example with `python3 -m http.server 1430 --bind 127.0.0.1 --directory apps/web` from the repository root.

Vercel uses this directory as its project root, with no install or build step. The GitHub repository is `1kentom/span`. Website content describes the phase 0.1 foundation and links to source instructions and GitHub Releases. A progressive public GitHub API request displays actual published release notes and attached distribution files when available. Missing releases, API failures, and rate limits preserve the source-build baseline. It does not invent download links or release counts. No database, signup, or analytics backend is required.

Browser QA covers desktop and mobile layout, navigation, FAQ disclosure, local asset loading, heading structure, image alternatives, and source/release link destinations. This is separate from native editor verification.

See `ASSETS.md` for image, logo, and icon provenance.
