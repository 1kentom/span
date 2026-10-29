//! Keep the process transport's I/O wake identity stable across SDK callers.
use agent_client_protocol::{AcpAgent, Agent, Client, ConnectTo};
use futures_util::task::AtomicWaker;
use std::{
    future::Future,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll, Wake, Waker},
};

/// The SDK polls owned transports under different Shared-future contexts.
/// async-io wakes its previous I/O waiter when the wake identity changes,
/// which can keep an idle macOS transport awake. Forward real wakes to the
/// current caller through one transport identity, without a timer or delay.
pub(crate) struct Process(pub AcpAgent);

impl ConnectTo<Client> for Process {
    async fn connect_to(self, client: impl ConnectTo<Agent>) -> agent_client_protocol::Result<()> {
        StableWake::new(ConnectTo::<Client>::connect_to(self.0, client)).await
    }
}

#[derive(Default)]
struct Forward {
    parent: AtomicWaker,
}
impl Wake for Forward {
    fn wake(self: Arc<Self>) {
        self.parent.wake();
    }
    fn wake_by_ref(self: &Arc<Self>) {
        self.parent.wake();
    }
}

struct StableWake<F> {
    future: Pin<Box<F>>,
    forward: Arc<Forward>,
    waker: Waker,
}
impl<F> StableWake<F> {
    fn new(future: F) -> Self {
        let forward = Arc::new(Forward::default());
        Self {
            future: Box::pin(future),
            waker: Waker::from(forward.clone()),
            forward,
        }
    }
}
impl<F: Future> Future for StableWake<F> {
    type Output = F::Output;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        // Register first: a wake during the inner poll must reach this caller.
        this.forward.parent.register(cx.waker());
        this.future
            .as_mut()
            .poll(&mut Context::from_waker(&this.waker))
    }
}
impl<F> Drop for StableWake<F> {
    fn drop(&mut self) {
        // A stale I/O waker must neither retain nor wake a cancelled caller.
        self.forward.parent.take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Mutex,
    };

    #[derive(Default)]
    struct Counter(AtomicUsize);
    impl Wake for Counter {
        fn wake(self: Arc<Self>) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
    fn parent() -> (Arc<Counter>, Waker) {
        let count = Arc::new(Counter::default());
        (count.clone(), Waker::from(count))
    }

    #[test]
    fn child_keeps_one_identity_and_wakes_the_latest_caller() {
        let seen = Arc::new(Mutex::new(Vec::<Waker>::new()));
        let captured = seen.clone();
        let mut future = StableWake::new(std::future::poll_fn(move |cx| {
            captured.lock().unwrap().push(cx.waker().clone());
            Poll::<()>::Pending
        }));
        let (first_count, first) = parent();
        let (second_count, second) = parent();
        assert!(Pin::new(&mut future)
            .poll(&mut Context::from_waker(&first))
            .is_pending());
        assert!(Pin::new(&mut future)
            .poll(&mut Context::from_waker(&second))
            .is_pending());
        let seen = seen.lock().unwrap();
        assert!(seen[0].will_wake(&seen[1]));
        seen[0].wake_by_ref();
        assert_eq!(first_count.0.load(Ordering::SeqCst), 0);
        assert_eq!(second_count.0.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn wake_during_poll_is_forwarded_and_errors_are_unchanged() {
        let (count, waker) = parent();
        let mut first = true;
        let mut future = StableWake::new(std::future::poll_fn(move |cx| {
            if std::mem::take(&mut first) {
                cx.waker().wake_by_ref();
                Poll::Pending
            } else {
                Poll::Ready(Err::<(), _>("transport error"))
            }
        }));
        assert!(Pin::new(&mut future)
            .poll(&mut Context::from_waker(&waker))
            .is_pending());
        assert_eq!(count.0.load(Ordering::SeqCst), 1);
        assert_eq!(
            Pin::new(&mut future).poll(&mut Context::from_waker(&waker)),
            Poll::Ready(Err("transport error"))
        );
    }

    #[test]
    fn concurrent_wake_and_caller_registration_do_not_lose_readiness() {
        use std::sync::Barrier;
        for _ in 0..64 {
            let ready = Arc::new(AtomicBool::new(false));
            let observed = ready.clone();
            let mut future = StableWake::new(std::future::poll_fn(move |_| {
                if observed.load(Ordering::SeqCst) {
                    Poll::Ready(())
                } else {
                    Poll::Pending
                }
            }));
            let (_, first) = parent();
            assert!(Pin::new(&mut future)
                .poll(&mut Context::from_waker(&first))
                .is_pending());
            let (count, current) = parent();
            let child = future.waker.clone();
            let start = Arc::new(Barrier::new(2));
            let wake_start = start.clone();
            let waking = std::thread::spawn(move || {
                wake_start.wait();
                ready.store(true, Ordering::SeqCst);
                child.wake();
            });
            start.wait();
            let result = Pin::new(&mut future).poll(&mut Context::from_waker(&current));
            waking.join().unwrap();
            assert!(
                result.is_ready() || count.0.load(Ordering::SeqCst) > 0,
                "A pending caller lost its concurrent readiness wake"
            );
        }
    }

    #[test]
    fn cancellation_drops_owned_work_and_releases_the_parent() {
        struct Pending {
            dropped: Arc<AtomicBool>,
            child: Arc<Mutex<Option<Waker>>>,
        }
        impl Future for Pending {
            type Output = ();
            fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
                *self.child.lock().unwrap() = Some(cx.waker().clone());
                Poll::Pending
            }
        }
        impl Drop for Pending {
            fn drop(&mut self) {
                self.dropped.store(true, Ordering::SeqCst);
            }
        }
        let dropped = Arc::new(AtomicBool::new(false));
        let child = Arc::new(Mutex::new(None));
        let (count, waker) = parent();
        let mut future = StableWake::new(Pending {
            dropped: dropped.clone(),
            child: child.clone(),
        });
        assert!(Pin::new(&mut future)
            .poll(&mut Context::from_waker(&waker))
            .is_pending());
        drop(future);
        assert!(dropped.load(Ordering::SeqCst));
        child.lock().unwrap().take().unwrap().wake();
        assert_eq!(count.0.load(Ordering::SeqCst), 0);
        assert_eq!(Arc::strong_count(&count), 2);
    }
}
