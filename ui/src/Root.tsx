import { ErrorBoundary, Show, createSignal, onCleanup, onMount, type Component } from "solid-js";
import { RecoveryScreen, type RecoveryActions } from "./components/RecoveryScreen";
import { BOOT_WATCHDOG_MS, startBootWatchdog } from "./lib/boot-guard";

/**
 * The app mount with its safety net: a render or mount error anywhere below shows the recovery screen instead of an
 * empty window, and so does a startup that has not signalled ready within the watchdog time (over the workbench, and
 * taken away again if the app becomes ready after all). Either way the native window is shown so the screen is seen.
 */
export function Root(props: { app: Component; timeoutMs?: number; showWindow?: () => void; actions?: Partial<RecoveryActions> }) {
  const [slow, setSlow] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const show = () => {
    try {
      props.showWindow?.();
    } catch {
      /* the Rust failsafe shows the window as well */
    }
  };
  onMount(() => {
    const stop = startBootWatchdog({
      timeoutMs: props.timeoutMs ?? BOOT_WATCHDOG_MS,
      onTimeout: () => {
        setSlow(true);
        show();
      },
      onReadyAfterTimeout: () => setSlow(false),
    });
    onCleanup(stop);
  });
  return (
    <>
      <ErrorBoundary
        fallback={(error) => {
          console.error("span: the interface failed to render", error);
          queueMicrotask(() => setFailed(true));
          show();
          return <RecoveryScreen reason="error" error={error} actions={props.actions} />;
        }}
      >
        <props.app />
      </ErrorBoundary>
      <Show when={slow() && !failed()}>
        <RecoveryScreen reason="slow" overlay actions={props.actions} />
      </Show>
    </>
  );
}
