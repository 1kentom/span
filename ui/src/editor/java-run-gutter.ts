import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, gutter } from "@codemirror/view";
import { iconAssetPath } from "../lib/menuIcons";

type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];
function children(node: SyntaxNode): SyntaxNode[] {
  const result: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) result.push(child);
  return result;
}
function signature(node: SyntaxNode, state: EditorState): string {
  if (["Definition", "Modifiers", "LineComment", "BlockComment"].includes(node.name)) return "";
  const parts = children(node);
  const text = parts.length ? parts.map(child => signature(child, state)).join("") : state.sliceDoc(node.from, node.to);
  return node.name === "SpreadParameter" ? `${text}...` : text;
}

/** Uses the editor's Java grammar, so comments, strings and nested main methods cannot create controls. */
export function javaMainLine(state: EditorState): number | undefined {
  const tree = syntaxTree(state);
  if (mainLines.has(tree)) return mainLines.get(tree);
  const line = findJavaMainLine(state);
  mainLines.set(tree, line);
  return line;
}
const mainLines = new WeakMap<ReturnType<typeof syntaxTree>, number | undefined>();
function findJavaMainLine(state: EditorState): number | undefined {
  if (state.doc.length > 1024 * 1024) return;
  const tree = syntaxTree(state);
  if (tree.length !== state.doc.length || tree.topNode.name !== "Program") return;
  let invalid = false;
  tree.iterate({ enter: node => { if (node.type.isError) invalid = true; } });
  if (invalid) return;
  const first = children(tree.topNode).find(node => ["ClassDeclaration", "InterfaceDeclaration", "EnumDeclaration", "RecordDeclaration", "AnnotationTypeDeclaration"].includes(node.name));
  if (first?.name !== "ClassDeclaration") return;
  const body = first.getChild("ClassBody");
  if (!body) return;
  for (const method of children(body).filter(node => node.name === "MethodDeclaration")) {
    const name = method.getChild("Definition");
    const modifiers = method.getChild("Modifiers");
    const parameters = method.getChild("FormalParameters");
    if (!name || state.sliceDoc(name.from, name.to) !== "main" || !method.getChild("void") || !method.getChild("Block") || !modifiers || !parameters) continue;
    const flags = children(modifiers).map(node => node.name);
    if (!flags.includes("public") || !flags.includes("static")) continue;
    const values = children(parameters).filter(node => !["(", ")", "LineComment", "BlockComment"].includes(node.name));
    if (values.length !== 1 || !["FormalParameter", "SpreadParameter"].includes(values[0].name)) continue;
    if (["String[]", "java.lang.String[]", "String...", "java.lang.String..."].includes(signature(values[0], state))) return state.doc.lineAt(name.from).number;
  }
}

class JavaRunMarker extends GutterMarker {
  constructor(readonly onRun: () => void) { super(); }
  toDOM() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-java-run-button";
    button.setAttribute("aria-label", "Run Java main");
    button.title = "Run Java file (standalone, JDK 11+). Project build and classpath are not applied.";
    const icon = document.createElement("span");
    icon.className = "cm-java-run-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.style.maskImage = `url('${iconAssetPath("u-play")}')`;
    icon.style.webkitMaskImage = `url('${iconAssetPath("u-play")}')`;
    button.append(icon);
    button.addEventListener("mousedown", event => event.stopPropagation());
    button.addEventListener("click", event => { event.stopPropagation(); this.onRun(); });
    return button;
  }
}

export function javaRunGutter(onRun: () => void): Extension {
  const marker = new JavaRunMarker(onRun);
  return [gutter({
    class: "cm-java-run-gutter",
    lineMarker: (view, line) => javaMainLine(view.state) === view.state.doc.lineAt(line.from).number ? marker : null,
    lineMarkerChange: update => update.docChanged || syntaxTree(update.state) !== syntaxTree(update.startState),
  }), ViewPlugin.fromClass(class {
    constructor(readonly view: EditorView) { this.exposeControls(); }
    update() { this.exposeControls(); }
    exposeControls() {
      this.view.requestMeasure({ key: this, read: () => undefined, write: () => {
        // CodeMirror hides decorative gutters from assistive technology by
        // default. Expose only the gutter containing actual keyboard controls.
        const container = this.view.scrollDOM.querySelector<HTMLElement>(".cm-gutters");
        container?.removeAttribute("aria-hidden");
        container?.querySelectorAll<HTMLElement>(":scope > .cm-gutter").forEach(element => {
          if (element.classList.contains("cm-java-run-gutter")) element.removeAttribute("aria-hidden");
          else element.setAttribute("aria-hidden", "true");
        });
      } });
    }
    destroy() { this.view.scrollDOM.querySelector(".cm-gutters")?.setAttribute("aria-hidden", "true"); }
  }), EditorView.baseTheme({
    ".cm-java-run-gutter .cm-gutterElement": { padding: "0 2px", display: "flex", alignItems: "center" },
    ".cm-java-run-button": { width: "20px", height: "20px", border: "none", borderRadius: "4px", background: "transparent", color: "var(--success, #67b782)", padding: "2px", cursor: "pointer" },
    ".cm-java-run-button:hover": { background: "var(--surface-hover, #ffffff12)" },
    ".cm-java-run-button:focus-visible": { outline: "2px solid var(--accent)", outlineOffset: "1px" },
    ".cm-java-run-icon": { display: "block", width: "16px", height: "16px", backgroundColor: "currentColor", maskSize: "contain", maskRepeat: "no-repeat" },
  })];
}
