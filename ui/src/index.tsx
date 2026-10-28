import { render } from "solid-js/web";
import App from "./App";
import "./styles/agent-sidebar.css";
import { markStartup, STARTUP_MARKS } from "./lib/startup";

// Imports are evaluated first, so this marks the end of loading and running the entry chunk.
markStartup(STARTUP_MARKS.entryEvaluated);
const root = document.getElementById("root");
if (root) render(() => <App />, root);
