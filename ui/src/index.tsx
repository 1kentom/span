import { render } from "solid-js/web";
import App from "./App";
import { Root } from "./Root";
import "./styles/agent-sidebar.css";
import { api } from "./lib/client";
import { markStartup, readBootTheme, STARTUP_MARKS } from "./lib/startup";

// Imports are evaluated first, so this marks the end of loading and running the entry chunk.
markStartup(STARTUP_MARKS.entryEvaluated);
// public/boot.js shows a plain fallback when the bundle never gets this far.
document.documentElement.dataset.spanEntry = "true";
const root = document.getElementById("root");
if (root) render(() => <Root app={App} showWindow={() => void api.showMainWindow(readBootTheme() ?? "dark").catch(() => undefined)} actions={{ copy: text => api.writeClipboard(text) }} />, root);
