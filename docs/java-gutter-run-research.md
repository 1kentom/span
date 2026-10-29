# Java main gutter Run research

## Scope decision

Phase 0.1 should support a deliberately narrow first action: explicitly run the current `.java` file in standalone source-file mode when it contains a conventional entry point declared as `public static void main(String[] args)` or the equivalent `String... args`. This applies even when the selected file is beneath a Maven, Gradle, or module-project ancestor. The action name and tooltip must clearly say that it runs this Java file in standalone mode. Require a JDK 11 or newer, because Java source-file launcher mode was introduced in Java 11. Do not infer Maven, Gradle, module, dependency, or project configuration from nearby files. A project main/dependency build remains a separate action using a reviewed existing run configuration.

The gutter action must explicitly save dirty source before launch. The backend then validates and launches from the authoritative current buffer/disk state, with a backend-side check to avoid launching stale disk content if the save has not completed or failed. Display actual JDK compiler diagnostics through the existing Run surface. Route stdout, stderr, process state, and exit status through the existing Run service. This is a run action, not a debugger integration.

## Feature comparison

| Product or source | Officially documented behavior | Relevance and boundary for Span |
| --- | --- | --- |
| IntelliJ IDEA | Valid Java classes with `main()` can be run from the editor gutter. The IDE compiles the file/project, creates a temporary run configuration, and shows output and exit status in its Run tool window. Its introductory guide also covers Java 25 compact source files. [Creating your first Java application](https://www.jetbrains.com/help/idea/creating-and-running-your-first-java-application.html), [Running applications](https://www.jetbrains.com/help/idea/running-applications.html) | Strong interaction reference for a conventional main action and visible run result. Span's standalone source-file mode is intentionally smaller than IDEA's compiler, project model, run configurations, and support for newer compact source files. |
| VS Code Java debugger | The Java extension pack provides `Run` and `Debug` CodeLens actions above `main()`. It can discover a main class and generate a default launch configuration in memory; persistent configuration is optional. Its settings document CodeLens enablement and a default force-build-before-launch behavior. [Running and debugging Java](https://code.visualstudio.com/docs/java/java-debugging) | Good reference for a lightweight entry-point affordance and surfaced run/debug choices. Span implements run only. This does not establish that Span uses DAP or matches VS Code launch semantics. |
| Oracle Java 21 launcher | `java [options] source-file [args ...]` selects source-file mode for a `.java` source file, compiles it in memory, and runs the first top-level class. The executed class must contain standard `public static void main(String[])`; no other source files are discovered/compiled and annotation processing is disabled. [The `java` command, Java SE 21](https://docs.oracle.com/en/java/javase/21/docs/specs/man/java.html) | Supports a single-file execution approach and informs the JDK 11+ floor. A Java file can be explicitly run this way without using a Maven/Gradle project config, but its limitations mean this mode is not a build-system or dependency-aware project runner. |
| JetBrains Fleet | JetBrains announced that Fleet stopped receiving updates and would no longer be available for download starting December 22, 2025. Earlier Fleet 1.32 notes documented projectless current-file running for some languages, but Java single-file support specifically mentioned tests, requiring Smart Mode. [The Future of Fleet](https://blog.jetbrains.com/fleet/2025/12/the-future-of-fleet/), [Fleet 1.32](https://blog.jetbrains.com/fleet/2024/03/fleet-1-32-is-here-change-line-endings-sort-selected-lines-run-single-files-without-creating-a-project-and-more/) | No current supported Fleet behavior is a reliable target. The historical announcement does not prove parity for conventional Java `main` gutter Run. |
| Zed | Current Java language docs describe an extension with JDTLS and a Java debug adapter. Debug launch is configured through `debug.json`; Java entry-point/test play buttons are described as launch scripts, with documented Maven/Gradle platform limitations. [Java in Zed](https://zed.dev/docs/languages/java), [Running and Testing](https://zed.dev/docs/running-testing), [Debugger](https://zed.dev/docs/debugger) | Useful reference for extension-provided launch tasks and explicit launch configuration. It does not establish a universal standalone Java main gutter Run contract for Span. Zed's Java debug adapter does not imply Span should implement DAP. |

## Explicit non-goals and claims

- Do not claim IntelliJ, VS Code, Fleet, or Zed parity. Their project discovery, compilation, launch configuration, build integration, and debugging differ from the chosen scope.
- Do not claim DAP support. Neither the presence of gutter Run nor reuse of an existing Run service makes this a debugger or DAP implementation.
- Do not silently infer dependencies or select a build tool. A plain source-file launch cannot resolve project dependencies by itself, even if the file sits inside a Maven, Gradle, or module workspace.
- Do not launch stale source. Saving dirty edits is explicit in the flow, followed by backend validation against the current source state.

## Acceptance checks

- A conventional standalone `.java` file with `public static void main(String[] args)` shows a Run gutter action; the `String... args` spelling is recognized equivalently.
- A dependency-free fixture at `src/main/java/com/kentom/todo/new-file.java` beneath a `pom.xml`, containing default-package `class Test` and conventional `main` printing `HelloWorld`, can be explicitly run as that file in standalone mode. The label and tooltip disclose standalone-file mode; no Maven configuration or classpath is inferred.
- A hyphenated Java filename and default-package class are accepted for source-file launch, as allowed by the JDK launcher. Do not impose a public-class/filename match requirement for this mode.
- A file without a compatible entry point has no gutter control. An unavailable or unprobed JDK, or a runtime older than 11, has no gutter control. Compilation and dependency errors are displayed from the actual Java process.
- A dirty buffer is explicitly saved before launch. If saving fails or the backend detects that the source changed after save, do not run the stale file.
- Launch the selected file using the detected JDK 11+ source-file mode and stream stdout/stderr plus exit status through the existing Run service. The gutter and toolbar use the shared current-file runner. Users can create an explicit configuration to supply program arguments or project classpaths as separate argv values.
- Do not invoke Maven/Gradle or infer a project dependency classpath. Source-launcher capabilities, including neighboring-source compilation in newer JDKs, follow the installed JDK. For a project build or a required dependency classpath, direct the user to review and use an existing run configuration.
- Compiler diagnostics come from the actual selected JDK and are shown in the existing Run surface. A separate project-aware main/dependency build must use a reviewed existing configuration.
- Cancel/stop behavior and errors are represented by the existing Run service; this feature adds no debugger session or DAP contract.

## Tracking and evidence status

[Issue #130](https://github.com/1kentom/span/issues/130) tracks this behavior and should remain open until independent implementation and native-app evidence confirms it. The observed `new-file.java` Maven-workspace case motivates the explicit standalone-file action. Local evidence below is distinct from native acceptance and hosted checks.

## Local evidence and remaining gates

- 65 focused UI tests passed: Java grammar detection, comment/string/invalid-signature rejection, real button focus/accessibility and activation, JDK availability, source-target selection and workspace races. The existing editor tests passed alongside them. TypeScript checking and the production UI build passed.
- Three Chromium browser IPC fixture checks passed: keyboard activation sends the detected configuration through the existing Run transport, dirty Cancel preserves the draft, Save and Run saves before dispatch, and missing JDK tools hide the control. This fixture does not execute Java and is not native desktop evidence.
- An owned temporary JDK 21 fixture at the exact hyphenated Maven-tree path printed `Hello World`, exited 0 and produced no `.class` or Maven `target` artifacts. A missing-dependency fixture exited 1 with actual JDK compiler diagnostics. This verifies the source-file command, separately from the UI transport.
- 12 focused Java Rust tests passed across syntax, core, and workspace suites, including the actual JDK source launch. Strict release clippy for core and syntax, all targets, passed. Independent review, hosted checks for the final commit, and native desktop verification remain pending. No project dependency resolution, DAP integration, product parity, or release readiness is established by these local checks.


## Current-file runner reconciliation

The integrated source reuses the current-file runner introduced by PR #132. Java gutter requests call `current_file_run` and `start_current_file_run`, with an explicit source path, rather than adding duplicate detected Java catalog entries. The same core preparation check validates Java source on start and restart. Toolbar Java current-file Run uses the same explicit Save and Run confirmation. All Java source arguments have a `./` prefix so a root filename such as `@Test.java` remains a literal source argument instead of Java launcher argument-file expansion.

The integrated source passed 47 focused UI checks covering the shared run store, current-file dropdown/provenance, Java parser/gutter and runtime gating, plus TypeScript checking and three Chromium IPC fixture checks. Eight focused integrated core checks passed, including actual JDK execution of the Maven-tree scratch file and an `@Test.java` filename, dirty/disk mismatch rejection, exact-command tampering rejection, and the existing current-file mapping suite. Strict release clippy for core and syntax, all targets, passed. Final native evidence is recorded separately by the integration owner. The browser fixture remains a transport test and does not execute Java.
