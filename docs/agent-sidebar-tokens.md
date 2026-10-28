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
| Text dim | #6e747b | `--faint` | #6e747b | exact |
| Accent | #726cf9 | `--accent` | #726cf9 | exact; not overridden in Light or Purple |

## Roles with no theme-level token

| Design role | Design value | Status |
| --- | --- | --- |
| Accent light | #a09bff | No token. `agent.css` derives `--agent-accent-fg` with `color-mix` from `--accent`, which is the nearest equivalent. |
| Green | #70bd8d | No theme token. `agent.css` has agent-scoped `--agent-success` and `--agent-success-surface` (different values). |
| Red | #d26979 | No theme token. `agent.css` has agent-scoped `--agent-error`, `--agent-error-surface`, `--agent-error-border`. |
| Amber | #d4ae67 | No theme token. `agent.css` has agent-scoped `--agent-warning`. Not added here because the brief limited new tokens to the surfaces and diff roles. |
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

Provenance of the values:

- Dark diff, amber surface, amber border and dock values are copied from the design file (#1c2a21, #a3cbb0, #4f7a5c, #2e2024, #d3a0a7, #8a5560, #221f19, #4d4330, #1e1d2e).
- Dark red surface and red border are not in the design as a surface; they are chosen to sit between the diff removed background and the panel. Treat as proposed.
- Light and Purple values are chosen, not supplied by the design, and have not been visually reviewed in the running app. Light values were picked for readable contrast on the Light panel (#fff); contrast ratios were not measured.

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
