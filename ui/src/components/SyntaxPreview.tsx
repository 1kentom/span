import { createEffect, onCleanup, onMount } from "solid-js";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { loadLanguage } from "../editor/languages";
import { syntaxHighlightStyle } from "../editor/syntax-highlight";
import { syntaxSample, type SampleLanguage } from "../editor/syntax-sample";
import { SYNTAX_TOKENS, THEME_BACKGROUNDS, cssVariable, type SyntaxPalette, type SyntaxTheme } from "../editor/syntax-palette";
import "../styles/editor.css";
import "../styles/syntax.css";

/**
 * Read only editor that shows a sample through the same highlight style the real editor uses.
 * The palette is written inline on the wrapper, so it previews a theme that is not the active one
 * and updates the moment a colour changes, without touching the rest of the app.
 */
export function SyntaxPreview(props: { language: SampleLanguage; theme: SyntaxTheme; palette: SyntaxPalette }) {
  let host!: HTMLDivElement;
  let wrapper!: HTMLDivElement;
  let view: EditorView | undefined;
  const language = new Compartment();
  let generation = 0;

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: syntaxSample(props.language),
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ "aria-label": "Syntax preview", "aria-readonly": "true", tabindex: "0" }),
          syntaxHighlighting(syntaxHighlightStyle), syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          language.of([]),
        ],
      }),
    });
  });
  onCleanup(() => { generation += 1; view?.destroy(); view = undefined; });

  createEffect(() => {
    const id = props.language;
    const token = ++generation;
    void loadLanguage(id).then((support) => {
      if (!view || token !== generation) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: syntaxSample(id) },
        effects: language.reconfigure(support ?? []),
      });
    });
  });

  createEffect(() => {
    const palette = props.palette;
    for (const id of SYNTAX_TOKENS) wrapper.style.setProperty(cssVariable(id), palette[id]);
    wrapper.style.setProperty("--editor-bg", THEME_BACKGROUNDS[props.theme]);
    wrapper.style.setProperty("--editor-fg", palette.variable);
  });

  return <div ref={wrapper} class="span-editor syn-preview" data-theme={props.theme} data-language={props.language}><div class="span-editor-surface" ref={host} /></div>;
}

export default SyntaxPreview;
