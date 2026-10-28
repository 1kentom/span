# Agent sidebar design tokens

Maps the colour roles of the supplied agent sidebar design onto the theme tokens the app defines in `ui/src/styles/workbench.css`. Tokens are CSS custom properties set on `.ide` (Dark, the default), `.ide.theme-light` and `.ide.theme-purple`. The three themes are the `Theme` type (`Dark`, `Light`, `Purple`).

Light and Purple only override what differs from Dark. Dark values below are the `.ide` block.

## Existing tokens used

| Design role | Design value | Closest existing token | Dark value | Notes |
| --- | --- | --- | --- | --- |
| Panel background | #18191b | `--island` (also `--panel-bg`) | #18191b | exact |
| Raised surface | #1f2023 | `--popup` | #1f2023 | exact |
| Card | #1b1c1e | `--island` | #18191b | no exact token, one step lighter in the design |
| Inset | #111214 | `--field` | #111214 | exact |
| Control | #28292b | `--pill` | #28292b | exact |
| Hover | #222325 | `--hover` | #222325 | exact |
| Border (subtle) | #2c2d30 | `--sepLine` | #2c2d30 | exact |
| Border (control) | #37383a | `--pillBd` | #37383a | exact |
| Text primary | #e0e1e4 | `--text` | #e0e1e4 | exact |
| Text secondary | #c4c5c8 | `--text` | #e0e1e4 | no token, slightly dimmer in the design |
| Text muted | #898e94 | `--dim` | #898e94 | exact |
| Text dim | #6e747b | `--faint` | #6e747b | exact; the sidebar uses `--dim` for meta text instead, see Contrast below |
| Accent | #726cf9 | `--accent` | #726cf9 | exact; not overridden in Light or Purple |

## Roles with no theme-level token

| Design role | Design value | Status |
| --- | --- | --- |
| Accent light | #a09bff | No token. `agent.css` derives `--agent-accent-fg` with `color-mix` from `--accent`, which is the nearest equivalent. |
| Green, Red, Amber | #70bd8d, #d26979, #d4ae67 | Now theme tokens `--success`, `--error`, `--warning`; see New tokens. |
| Text secondary, card | see above | Mapped to the nearest token, not exact. |

## New tokens (added to all three themes)

| Role | Token | Dark | Light | Purple |
| --- | --- | --- | --- | --- |
| Diff added row background | `--diffAdd` | #1c2a21 | #e6f4ea | #1a2b2a |
| Diff added text | `--diffAddText` | #a3cbb0 | #1e5a35 | #a3cbb0 |
| Diff added gutter (line numbers) | `--diffAddGutter` | #4f7a5c | #5f9c76 | #4f7a5c |
| Diff removed row background | `--diffDel` | #2e2024 | #fbe9ec | #301f31 |
| Diff removed text | `--diffDelText` | #d3a0a7 | #8f2a3d | #d3a0a7 |
| Diff removed gutter | `--diffDelGutter` | #8a5560 | #c0707f | #8a5560 |
| Amber surface | `--amberSurface` | #221f19 | #fbf1dc | #2a2420 |
| Amber border | `--amberBorder` | #4d4330 | #e3cf9c | #54452f |
| Red surface | `--redSurface` | #2a1c20 | #fdecef | #2d1d2c |
| Red border | `--redBorder` | #5a3039 | #efb9c2 | #5c3040 |
| Accent-tinted dock background | `--accentDock` | #1e1d2e | #efeefe | #1d1b3a |
| Success text and icons | `--success` | #70bd8d | #277946 | #70bd8d |
| Warning text and icons | `--warning` | #d4ae67 | #996317 | #d4ae67 |
| Error text and icons | `--error` | #d26979 | #b7314c | #d26979 |
| Fill of text-bearing accent buttons | `--accentFill` | #5f58f0 | #5f58f0 | #5f58f0 |
| Hover of that fill | `--accentFillHover` | #544ddc | #544ddc | #544ddc |
| Text and icons on an accent fill | `--onAccent` | #fff | #fff | #fff |

`agent-sidebar.css` maps these to `--sb-success`, `--sb-warning`, `--sb-error`, `--sb-accent-fill`, `--sb-accent-fill-hover` and `--sb-on-accent`. The sidebar style sheets (`agent-sidebar.css`, `agent.css`) contain no hex literals; a test in `ui/src/lib/agent-sidebar-assets.test.ts` enforces that. The documented image-background exceptions in `viewer.css` (`--vw-image-light`, `--vw-image-dark`) are unchanged.

Provenance of the values:

- Dark diff, amber surface, amber border and dock values are copied from the design file (#1c2a21, #a3cbb0, #4f7a5c, #2e2024, #d3a0a7, #8a5560, #221f19, #4d4330, #1e1d2e).
- Dark red surface and red border are not in the design as a surface; they are chosen to sit between the diff removed background and the panel. Treat as proposed.
- Light and Purple values are chosen, not supplied by the design, and have not been visually reviewed in the running app. Light values were picked for readable contrast on the Light panel (#fff).
- The status colours were previously literals in `agent-sidebar.css`, with Light overrides; they moved into the themes unchanged. Purple uses the Dark values.

## Contrast

WCAG 2.x ratios, measured from the token values (the same formula runs in `agent-sidebar-assets.test.ts`, which requires 4.5:1). The app-wide `--accent` (#726cf9) is unchanged.

| Pair | Dark | Light | Purple |
| --- | --- | --- | --- |
| #fff on `--accent` (old filled button) | 4.02 | 4.02 | 4.02 |
| `--onAccent` on `--accentFill` (filled button now) | 5.07 | 5.07 | 5.07 |
| `--faint` on `--island` (old meta text) | 3.73 | 4.03 | 4.36 |
| `--dim` on `--island` (meta text now) | 5.33 | 6.07 | 6.92 |
| `--dim` on `--popup` | 4.93 | 6.07 | 6.36 |
| `--dim` on `--accentDock` | 5.01 | 5.29 | 6.50 |
| `--success` on `--island` | 7.83 | 5.37 | 7.83 |
| `--warning` on `--island` | 8.42 | 5.06 | 8.42 |
| `--error` on `--island` | 5.06 | 5.90 | 5.06 |

`--sb-faint` now points at `--dim`, so sidebar meta text no longer has a separate dimmer step. The icon-only send button keeps `--accent` (4.02, above the 3:1 needed for non-text). Attachment styles outside the sidebar (`attachments.css`) still use `--faint` directly and were not changed.

## Icons

Interface icons are vendored files in `ui/public/icons/`, rendered through `Icon` as a CSS mask. They use the Iconsax linear style (1.5 stroke, round caps), as the existing icons do. The design's own icon files for Check, X, Tab, Enter, Grip, Image, Maximize, More, Target, Warning and Link are hand drawn with embedded C2PA metadata and were not copied.

| Design name | Registered name | Status |
| --- | --- | --- |
| Add, Code1, Clock, Refresh2, Stop, DocumentText, SearchNormal1, Edit2, TaskSquare, TickCircle, Setting2, MessageQuestion, Copy, u-send, u-terminal, arrow-down4, arrow-right4 | same | already present |
| Warning | `Warning2` (Iconsax warning-2) | already present under that name |
| Link | `Link2` | already present, closest |
| Check | `TickCircle` | no plain check in Iconsax; closest is already present |
| X | `CloseCircle` | no plain X in Iconsax; closest is already present |
| ArrowUp | `arrow-up3` | arrow-up3 already present; the tailed ArrowUp is not to be used |
| Target | `Gps` | vendored (Iconsax gps, linear), closest match |
| Image | `Gallery` | vendored (Iconsax gallery, linear) |
| Maximize | `Maximize4` | vendored (Iconsax maximize-4, linear) |
| More | `3DotsMore` | vendored (Iconsax 3-dots-more, linear, horizontal dots) |
| Tab, Enter, Grip | none | no Iconsax match found. Suggestions: Tab as `arrow-right4` plus a `kbd` label, Enter as a `kbd` label, Grip as `3DotsMore` rotated. |
| Rewind, Fork, Shift | not vendored | not needed yet |

The local library at `hicon/icon-library/icons` is a different Iconsax download whose names do not match the classic set the app uses, and it has no `stop`, `document-text` or `task-square`. The four new files were taken from the Iconsax MCP (linear style) and normalised the same way as the existing files (single quoted attributes, `#000` stroke, clip path removed). That is a deviation from the stated source path and is worth confirming.

## Brands and fonts

All of claude, codex, gemini, copilot, opencode, qwen and mistral are already in `ui/public/brands/` and resolved by `ui/src/lib/brand-icons.ts`; provenance is in `ui/public/brands/provenance.json` and the SVGL licence in `LICENSE.svgl.txt`. The design's `brands/*.svg` files and `assets/span-logo.svg` differ byte-wise from the app copies (the design copies carry C2PA metadata), so the app copies were kept. `BrandIcon` renders both a light and a dark image and `.theme-light` in `brands.css` shows the light one; `brandIconSource` picks `light` only for the Light theme (Dark and Purple use dark).

Inter (400, 500, 600) and JetBrains Mono (400, 500) ship through `@fontsource` imports in `ui/src/App.tsx`, so nothing is hotlinked. The design uses JetBrains Mono at weight 600 in places; that weight is not imported.
