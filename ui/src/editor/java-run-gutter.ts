import { syntaxTree } from "@codemirror/language";
import { RangeSet, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, GutterMarker, ViewPlugin, lineNumberMarkers } from "@codemirror/view";
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

const runTooltip = "Run Java file (standalone, JDK 11+). Project build and classpath are not applied.";
let tooltipId = 0;

/** Renders inside the line-number cell. CodeMirror skips the number for a line with a DOM marker. */
class JavaRunMarker extends GutterMarker {
  constructor(readonly onRun: () => void) { super(); }
  eq(other: GutterMarker) { return other instanceof JavaRunMarker && other.onRun === this.onRun; }
  toDOM(view: EditorView) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-java-run-button";
    button.setAttribute("aria-label", "Run Java main");
    button.dataset.tooltip = runTooltip;
    const icon = document.createElement("span");
    icon.className = "cm-java-run-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.style.maskImage = `url('${iconAssetPath("u-play")}')`;
    icon.style.webkitMaskImage = `url('${iconAssetPath("u-play")}')`;
    button.append(icon);
    let tip: HTMLElement | undefined;
    const hide = () => { tip?.remove(); tip = undefined; button.removeAttribute("aria-describedby"); };
    const show = () => {
      if (tip || !button.isConnected) return;
      tip = document.createElement("div");
      tip.className = "cm-java-run-tooltip";
      tip.id = `cm-java-run-tooltip-${++tooltipId}`;
      tip.setAttribute("role", "tooltip");
      tip.textContent = runTooltip;
      view.dom.append(tip);
      button.setAttribute("aria-describedby", tip.id);
      // Above the icon when the window has room, otherwise to its right on the
      // same line, so the line below stays readable.
      const anchor = button.getBoundingClientRect(), size = tip.getBoundingClientRect();
      const above = anchor.top - size.height - 6 >= 0;
      tip.dataset.placement = above ? "above" : "right";
      tip.style.left = `${above ? anchor.left : anchor.right + 8}px`;
      tip.style.top = `${above ? anchor.top - size.height - 6 : anchor.top + anchor.height / 2 - size.height / 2}px`;
    };
    button.addEventListener("mouseenter", show);
    button.addEventListener("focus", show);
    button.addEventListener("mouseleave", () => { if (document.activeElement !== button) hide(); });
    button.addEventListener("blur", hide);
    button.addEventListener("keydown", event => { if (event.key === "Escape") hide(); });
    button.addEventListener("mousedown", event => event.stopPropagation());
    button.addEventListener("click", event => { event.stopPropagation(); hide(); this.onRun(); });
    return button;
  }
  destroy(dom: Node) { const id = (dom as HTMLElement).getAttribute?.("aria-describedby"); if (id) document.getElementById(id)?.remove(); }
}

function runMarkers(state: EditorState, marker: JavaRunMarker): RangeSet<GutterMarker> {
  const line = javaMainLine(state);
  return line === undefined ? RangeSet.empty : RangeSet.of(marker.range(state.doc.line(line).from));
}

/** Draws the run control in place of the line number on `main`, so no extra gutter column is added. */
export function javaRunGutter(onRun: () => void): Extension {
  const marker = new JavaRunMarker(onRun);
  const markers = StateField.define<RangeSet<GutterMarker>>({
    create: state => runMarkers(state, marker),
    update: (value, tr) => tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState) ? runMarkers(tr.state, marker) : value,
    provide: field => lineNumberMarkers.from(field),
  });
  return [markers, ViewPlugin.fromClass(class {
    constructor(readonly view: EditorView) { this.exposeControls(); }
    update() { this.exposeControls(); }
    exposeControls() {
      this.view.requestMeasure({ key: this, read: () => undefined, write: () => {
        // CodeMirror hides gutters from assistive technology by default. Expose
        // the run button while keeping plain numbers and other gutters hidden.
        const container = this.view.scrollDOM.querySelector<HTMLElement>(".cm-gutters");
        container?.removeAttribute("aria-hidden");
        container?.querySelectorAll<HTMLElement>(":scope > .cm-gutter").forEach(element => {
          if (!element.classList.contains("cm-lineNumbers")) { element.setAttribute("aria-hidden", "true"); return; }
          element.removeAttribute("aria-hidden");
          element.querySelectorAll<HTMLElement>(":scope > .cm-gutterElement").forEach(cell => {
            if (cell.querySelector(".cm-java-run-button")) cell.removeAttribute("aria-hidden");
            else cell.setAttribute("aria-hidden", "true");
          });
        });
      } });
    }
    destroy() {
      this.view.dom.querySelectorAll(".cm-java-run-tooltip").forEach(tip => tip.remove());
      this.view.scrollDOM.querySelector(".cm-gutters")?.setAttribute("aria-hidden", "true");
    }
  }), EditorView.baseTheme({
    // A 16px layout box that fits the number cell's minimum width; the round
    // hover background is painted outside it so the gutter never widens.
    ".cm-java-run-button": { display: "inline-flex", verticalAlign: "middle", width: "16px", height: "16px", margin: "0", border: "none", borderRadius: "50%", background: "transparent", color: "var(--success)", padding: "0", cursor: "pointer", position: "relative" },
    ".cm-java-run-button:hover, .cm-java-run-button:focus-visible": { background: "var(--hover)", boxShadow: "0 0 0 3px var(--hover)" },
    ".cm-java-run-button:focus-visible": { outline: "2px solid var(--accent)", outlineOffset: "2px" },
    ".cm-java-run-icon": { display: "block", width: "16px", height: "16px", backgroundColor: "currentColor", maskSize: "contain", maskRepeat: "no-repeat", maskPosition: "center" },
    ".cm-java-run-tooltip": { position: "fixed", zIndex: "300", padding: "3px 8px", pointerEvents: "none", background: "var(--editor-bg, var(--popup))", color: "var(--editor-fg, var(--text))", border: "1px solid var(--editor-guide, var(--border))", borderRadius: "5px", font: "12px/18px Inter, sans-serif", whiteSpace: "nowrap" },
  })];
}
