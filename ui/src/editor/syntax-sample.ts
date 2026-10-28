import type { LanguageId } from "./languages";

/** Short snippets that show most colour tokens, for the live palette preview in Settings. */
export type SampleLanguage = Extract<LanguageId, "java" | "typescript" | "javascript" | "rust" | "python" | "json" | "css" | "html">;

export const SYNTAX_SAMPLES: Record<SampleLanguage, string> = {
  java: `package com.example.app;

import javafx.fxml.FXML;
import javafx.scene.control.ButtonType;
import static java.lang.Math.PI;

/** Shows the main dialog. */
public class MainController implements Initializable {
    private static final int MAX_ITEMS = 10;

    @FXML
    private ListView<String> items;

    @Override
    public <T extends Comparable<T>> T pick(List<T> values, int index) {
        values.forEach(value -> System.out.println(value));
        String text = """
            Hello
            """;
        return values.get(index); // first match
    }
}
`,
  typescript: `import React, { useState } from "react";
import * as path from "node:path";

/** A service with a typed handler. */
@Injectable()
export class Service<T> extends Base implements Handler {
  private readonly MAX = 3;
  name: string = "span";

  run(count: number): Promise<T> {
    const pattern = /a+b/g;
    return this.load(\`items: \${count}\`); // done
  }
}

interface Handler { id: number }
enum Mode { Fast, Slow }
const view = <Panel title="x"><div className="a" /></Panel>;
`,
  javascript: `import { readFile } from "node:fs/promises";

const LIMIT = 10;

export async function load(file, retries = 3) {
  const text = await readFile(file, "utf8");
  if (!text) throw new Error("empty");
  return text.split("\\n").map((line) => line.trim()); // lines
}
`,
  rust: `use std::collections::HashMap;
use std::{fmt, io::Read};

#[derive(Debug)]
pub struct Config<'a, T> {
    name: &'a str,
    value: T,
}

pub trait Handler {
    fn handle(&self, input: u32) -> bool;
}

const LIMIT: usize = 4;

fn main() {
    let map: HashMap<String, i32> = HashMap::new();
    println!("{}", map.len()); // count
}
`,
  python: `import os.path
from collections.abc import Mapping

LIMIT = 3

@dataclass(frozen=True)
class Config(Base):
    """Settings for a run."""

    def run(self, count: int = 1) -> None:
        print(f"{count} of {LIMIT}")  # report
        return self.value.strip()
`,
  json: `{
  "name": "span",
  "version": "0.1.0",
  "private": true,
  "scripts": { "build": "vite build" },
  "workspaces": null,
  "retries": 3
}
`,
  css: `:root { --accent: #7674df; }

.editor > .line:hover {
  color: var(--accent);
  margin: 0 12px; /* spacing */
}
`,
  html: `<!doctype html>
<main class="app" id="root">
  <h1>Span</h1>
  <a href="https://example.com">Docs</a>
</main>
`,
};

export function syntaxSample(language: SampleLanguage): string {
  return SYNTAX_SAMPLES[language];
}
