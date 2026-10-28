# Model vendor marks

These marks identify the vendor of a model in the model picker. They come from the taifa-ai project: the SVGs are the inline glyph strings in its `frontend/src/lib/glyphs.ts`, written out as files with an `xmlns` attribute added, and the PNGs are copied byte for byte from its `frontend/static/model-icons/`. Two vendors there publish raster marks only, so those stay PNG. DeepSeek, NVIDIA, Meta (Llama) and MiniMax come from the `simple-icons` package, version 16.29.0 (the version taifa-ai pins), copied unchanged except for `fill="currentColor"` added to the root element. The package was fetched with `npm pack` and extracted with tar, and it is not a dependency of this project. All artwork is served locally.

`provenance.json` records the source commit, the simple-icons package version, the source path of each mark, and SHA-256 hashes. The SVGs were inspected as XML and contain no scripts, event attributes, embedded documents, images, or external references.

Single-colour marks use `currentColor` and are drawn as a mask so they follow the theme. Brand-coloured marks keep their colour. Vendors already covered by the agent marks one folder up (OpenAI, Claude, Gemini, Mistral, Qwen, Z.ai) reuse those files instead of a second copy.

Logos and names identify their respective vendors. Their owners retain trademark rights and any applicable brand restrictions. The simple-icons icon files are CC0 1.0, but the marks they depict are trademarks of their owners, and that CC0 grant does not cover the marks. The taifa-ai source project ships no licence file, and the span project license does not establish separate rights to redistribute third-party artwork.

Models with no sourced mark (for example OpenCode's own stealth models) show the agent mark instead of fabricated artwork.
