import { StreamLanguage, type StreamParser } from "@codemirror/language";
import { clike } from "@codemirror/legacy-modes/mode/clike";

/** Small grammars for formats that have no official or legacy CodeMirror mode. */

const words = (list: string) => Object.fromEntries(list.split(" ").map((word) => [word, true]));

export const goModParser: StreamParser<unknown> = {
  name: "go.mod",
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match(/^\/\/.*/)) return "comment";
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^`[^`]*`?/)) return "string";
    if (stream.match("=>")) return "operator";
    if (stream.sol() && stream.match(/^(?:module|go|toolchain|godebug|require|replace|exclude|retract|use|ignore|tool)\b/)) return "keyword";
    if (stream.match(/^v\d+\.\d+\.\d+[\w.+-]*/)) return "number";
    if (stream.match(/^\d+(?:\.\d+)*/)) return "number";
    if (stream.match(/^[()[\],]/)) return "punctuation";
    stream.match(/^[^\s()[\],]+/) || stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "//" } },
};

export const makefileParser: StreamParser<unknown> = {
  name: "makefile",
  token(stream) {
    if (stream.sol() && stream.match(/^[ \t]*(?:-?include|sinclude|ifeq|ifneq|ifdef|ifndef|else|endif|define|endef|export|unexport|override|vpath|undefine|private)\b/)) return "keyword";
    if (stream.sol() && stream.match(/^[A-Za-z0-9_.$(){}%/ -]+?(?=\s*[:+?!]?=)/)) return "def";
    if (stream.sol() && stream.match(/^[^\s#:=\t][^#:=]*?(?=:(?![:=]?=)|::)/)) return "variableName.function";
    if (stream.eatSpace()) return null;
    if (stream.match(/^#.*/)) return "comment";
    if (stream.match(/^\$[({][^)}\n]*[)}]/) || stream.match(/^\$[@<^?*%+|]/) || stream.match(/^\$\$/)) return "variableName.special";
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'[^']*'?/)) return "string";
    if (stream.match(/^(?:::?=|[:+?!]?=|:|\|)/)) return "operator";
    if (stream.match(/^-[A-Za-z-]+/)) return "atom";
    stream.match(/^[^\s#$"':=+?!|]+/) || stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "#" } },
};

const batchKeywords = /^(?:if|else|for|in|do|goto|call|exit|set|echo|setlocal|endlocal|enabledelayedexpansion|shift|pause|not|exist|defined|errorlevel|equ|neq|lss|leq|gtr|geq|cd|chdir|pushd|popd|start|copy|move|del|erase|md|mkdir|rd|rmdir|type|title|cls|choice|timeout|where|findstr|find|xcopy|robocopy)(?![\w-])/i;
export const batchParser: StreamParser<unknown> = {
  name: "batch",
  token(stream) {
    if (stream.sol() && stream.match(/^\s*@?(?:rem(?:\s.*|$)|::.*)/i)) return "comment";
    if (stream.eatSpace()) return null;
    if (stream.sol() && stream.match(/^:[\w.-]+/)) return "labelName";
    if (stream.match(/^@/)) return "operator";
    if (stream.match(/^%~?[\w:~,*-]*%?/) || stream.match(/^![\w:~,*-]+!/) || stream.match(/^%%~?\w/)) return "variableName.special";
    if (stream.match(/^"[^"\n]*"?/)) return "string";
    if (stream.match(/^\d+(?![\w.])/)) return "number";
    if (stream.match(/^\/[A-Za-z?]\b/)) return "atom";
    if (stream.match(batchKeywords)) return "keyword";
    if (stream.match(/^(?:&&|\|\||[&|<>=^()])/)) return "operator";
    stream.match(/^[^\s%!"&|<>=^()@]+/) || stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "REM " } },
};

interface GraphqlState { block: boolean }
export const graphqlParser: StreamParser<GraphqlState> = {
  name: "graphql",
  startState: () => ({ block: false }),
  token(stream, state) {
    if (state.block) {
      while (!stream.eol()) { if (stream.match('"""')) { state.block = false; break; } stream.next(); }
      return "string";
    }
    if (stream.eatSpace()) return null;
    if (stream.match(/^#.*/)) return "comment";
    if (stream.match('"""')) { state.block = true; return "string"; }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)) return "number";
    if (stream.match(/^\$[A-Za-z_]\w*/)) return "variableName.special";
    if (stream.match(/^@[A-Za-z_]\w*/)) return "meta";
    if (stream.match(/^(?:true|false|null)\b/)) return "atom";
    if (stream.match(/^(?:query|mutation|subscription|fragment|on|type|interface|union|enum|input|scalar|schema|extend|implements|directive|repeatable)\b/)) return "keyword";
    if (stream.match(/^\.\.\./)) return "operator";
    if (stream.match(/^[{}()[\]:!=|&,]/)) return "punctuation";
    if (stream.match(/^[A-Z]\w*/)) return "typeName";
    if (stream.match(/^[A-Za-z_]\w*(?=\s*[:(])/)) return "propertyName";
    stream.match(/^\w+/) || stream.next();
    return "variableName";
  },
  languageData: { commentTokens: { line: "#" } },
};

interface HclState { comment: boolean; string: boolean; heredoc: string | null }
const hclKeywords = /^(?:resource|data|variable|output|locals|module|provider|terraform|provisioner|dynamic|moved|import|check|removed|for|in|if|else|endif|endfor|backend|required_providers|required_version|lifecycle|depends_on|content)\b/;
export const hclParser: StreamParser<HclState> = {
  name: "hcl",
  startState: () => ({ comment: false, string: false, heredoc: null }),
  token(stream, state) {
    if (state.heredoc) {
      if (stream.sol() && stream.match(new RegExp(`^\\s*${state.heredoc}\\s*$`))) { state.heredoc = null; return "string"; }
      if (stream.match(/^\$\{[^}]*\}?/)) return "variableName.special";
      stream.match(/^[^$]+/) || stream.next();
      return "string";
    }
    if (state.comment) {
      while (!stream.eol()) { if (stream.match("*/")) { state.comment = false; break; } stream.next(); }
      return "comment";
    }
    if (state.string) {
      if (stream.match(/^[$%]\{[^}]*\}?/)) return "variableName.special";
      while (!stream.eol()) {
        if (stream.peek() === "$" || stream.peek() === "%") { if (stream.match(/^[$%]\{/, false)) break; }
        const character = stream.next();
        if (character === "\\") stream.next();
        else if (character === '"') { state.string = false; break; }
      }
      return "string";
    }
    if (stream.eatSpace()) return null;
    if (stream.match(/^(?:#|\/\/).*/)) return "comment";
    if (stream.match("/*")) { state.comment = true; return "comment"; }
    const heredoc = stream.match(/^<<-?\s*([A-Za-z_]\w*)\s*$/) as RegExpMatchArray | null;
    if (heredoc) { state.heredoc = heredoc[1]; return "string"; }
    if (stream.eat('"')) { state.string = true; return "string"; }
    if (stream.match(/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)) return "number";
    if (stream.match(/^(?:true|false|null)\b/)) return "atom";
    if (stream.match(hclKeywords)) return "keyword";
    if (stream.match(/^(?:var|local|each|count|self|path|module|data)(?=\.)/)) return "variableName.standard";
    if (stream.match(/^[A-Za-z_][\w-]*(?=\s*\()/)) return "variableName.function";
    if (stream.match(/^[A-Za-z_][\w-]*(?=\s*=(?![=>]))/)) return "propertyName";
    if (stream.match(/^(?:=>|==|!=|<=|>=|&&|\|\||\.\.\.|[=+\-*/%<>!?:])/)) return "operator";
    if (stream.match(/^[{}()[\],.]/)) return "punctuation";
    stream.match(/^[\w-]+/) || stream.next();
    return "variableName";
  },
  languageData: { commentTokens: { line: "#", block: { open: "/*", close: "*/" } } },
};

const zigParser = clike({
  name: "zig",
  keywords: words("addrspace align allowzero and anyframe anytype asm async await break callconv catch comptime const continue defer else enum errdefer error export extern fn for if inline linksection noalias noinline nosuspend opaque or orelse packed pub resume return struct suspend switch test threadlocal try union unreachable usingnamespace var volatile while"),
  types: words("bool f16 f32 f64 f80 f128 void noreturn type anyerror comptime_int comptime_float isize usize i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 c_int c_uint c_long c_char"),
  blockKeywords: words("else for if switch while catch defer errdefer"),
  atoms: words("true false null undefined"),
  hooks: { "@": (stream: { eatWhile(re: RegExp): void }) => { stream.eatWhile(/[\w]/); return "builtin"; } },
});

export const goModLanguage = () => StreamLanguage.define(goModParser);
export const makefileLanguage = () => StreamLanguage.define(makefileParser);
export const batchLanguage = () => StreamLanguage.define(batchParser);
export const graphqlLanguage = () => StreamLanguage.define(graphqlParser);
export const hclLanguage = () => StreamLanguage.define(hclParser);
export const zigLanguage = () => StreamLanguage.define(zigParser);
