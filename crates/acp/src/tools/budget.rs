//! Per-delegation budgets (#53): turns, tokens and cost when the agent
//! reports them, and a wall clock timeout.
use super::result::FailureReason;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::{Duration, Instant};

/// Limits for one delegation (one child session and its follow-ups).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Budget {
    /// Prompts sent to the child: the delegation plus each `message`.
    pub max_turns: u32,
    /// Tokens: the larger of the peak ACP `usage_update.used` (context) and
    /// the sum of `PromptResponse.usage.totalTokens` (unstable) over turns.
    /// Only enforced when the agent reports either.
    pub max_tokens: Option<u64>,
    /// Wall clock seconds from the delegation, in policy seconds.
    pub timeout_seconds: u64,
    /// Only enforced when the agent reports a cost.
    pub max_cost: Option<f64>,
}

impl Default for Budget {
    /// 20 turns, 30 minutes, no token or cost limit unless the lead or the
    /// user sets one (see docs/decisions/0003-span-agents-tool-server.md).
    fn default() -> Self {
        Self {
            max_turns: 20,
            max_tokens: None,
            timeout_seconds: 30 * 60,
            max_cost: None,
        }
    }
}

/// What a lead may ask for in `delegate`. Every field can only lower the
/// server's budget, never raise it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetRequest {
    pub max_turns: Option<u32>,
    pub max_tokens: Option<u64>,
    pub timeout_seconds: Option<u64>,
    pub max_cost: Option<f64>,
}

fn lower<T: PartialOrd + Copy>(ceiling: Option<T>, asked: Option<T>) -> Option<T> {
    match (ceiling, asked) {
        (Some(c), Some(a)) => Some(if a < c { a } else { c }),
        (c, None) => c,
        (None, a) => a,
    }
}

impl Budget {
    pub fn narrowed(&self, request: &BudgetRequest) -> Budget {
        Budget {
            max_turns: request
                .max_turns
                .map_or(self.max_turns, |t| t.clamp(1, self.max_turns)),
            max_tokens: lower(self.max_tokens, request.max_tokens),
            timeout_seconds: request
                .timeout_seconds
                .map_or(self.timeout_seconds, |t| t.clamp(1, self.timeout_seconds)),
            max_cost: lower(self.max_cost, request.max_cost.filter(|c| *c >= 0.0)),
        }
    }
}

/// What a delegation has used so far.
#[derive(Debug, Clone)]
pub struct Meter {
    pub turns: u32,
    /// Peak context tokens from `usage_update`.
    pub tokens: Option<u64>,
    /// Sum of per-turn `totalTokens` from prompt responses.
    pub spent_tokens: u64,
    pub context_size: Option<u64>,
    pub cost: Option<f64>,
    pub currency: Option<String>,
    pub started: Instant,
}

impl Meter {
    pub fn new() -> Self {
        Self {
            turns: 0,
            tokens: None,
            spent_tokens: 0,
            context_size: None,
            cost: None,
            currency: None,
            started: Instant::now(),
        }
    }

    /// Tokens to compare with the budget, `None` when nothing was reported.
    pub fn used_tokens(&self) -> Option<u64> {
        match (self.tokens, self.spent_tokens) {
            (None, 0) => None,
            (context, spent) => Some(context.unwrap_or(0).max(spent)),
        }
    }

    /// Elapsed time in policy seconds (`second` is one second in
    /// production and shorter in time-scaled tests).
    pub fn elapsed(&self, second: Duration) -> u64 {
        (self.started.elapsed().as_nanos() / second.as_nanos().max(1)) as u64
    }

    /// The first limit this meter is over, with a reason for the lead.
    pub fn over(&self, budget: &Budget, second: Duration) -> Option<(FailureReason, String)> {
        if let (Some(limit), Some(used)) = (budget.max_tokens, self.used_tokens()) {
            if used > limit {
                return Some((
                    FailureReason::BudgetExceeded,
                    format!("reported {used} tokens, over the {limit} token budget"),
                ));
            }
        }
        if let (Some(limit), Some(cost)) = (budget.max_cost, self.cost) {
            if cost > limit {
                return Some((
                    FailureReason::BudgetExceeded,
                    format!(
                        "reported cost {cost} {}, over the {limit} budget",
                        self.currency.clone().unwrap_or_default()
                    ),
                ));
            }
        }
        let elapsed = self.elapsed(second);
        if elapsed >= budget.timeout_seconds {
            return Some((
                FailureReason::Timeout,
                format!(
                    "ran for {elapsed} s, the delegation timeout is {} s",
                    budget.timeout_seconds
                ),
            ));
        }
        None
    }

    /// Whether one more turn fits.
    pub fn turn_allowed(&self, budget: &Budget) -> Result<(), String> {
        if self.turns >= budget.max_turns {
            Err(format!(
                "this delegation already used {} of {} turns",
                self.turns, budget.max_turns
            ))
        } else {
            Ok(())
        }
    }
}

impl Default for Meter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_lead_can_lower_but_never_raise_the_budget() {
        let ceiling = Budget {
            max_turns: 5,
            max_tokens: Some(1000),
            timeout_seconds: 60,
            max_cost: None,
        };
        let asked = BudgetRequest {
            max_turns: Some(50),
            max_tokens: Some(10_000),
            timeout_seconds: Some(10),
            max_cost: Some(0.5),
        };
        let narrowed = ceiling.narrowed(&asked);
        assert_eq!(narrowed.max_turns, 5);
        assert_eq!(narrowed.max_tokens, Some(1000));
        assert_eq!(narrowed.timeout_seconds, 10);
        assert_eq!(narrowed.max_cost, Some(0.5));
    }

    #[test]
    fn unreported_usage_never_trips_a_token_or_cost_limit() {
        let budget = Budget {
            max_tokens: Some(1),
            max_cost: Some(0.0),
            ..Budget::default()
        };
        let meter = Meter::new();
        assert!(meter.over(&budget, Duration::from_secs(1)).is_none());
        let mut meter = meter;
        meter.tokens = Some(2);
        assert_eq!(
            meter.over(&budget, Duration::from_secs(1)).unwrap().0,
            FailureReason::BudgetExceeded
        );
    }
}
