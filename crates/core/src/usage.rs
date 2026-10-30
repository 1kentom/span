//! Usage ledger (ADR 0012): token and cost counters Span observed per
//! session, a dated price table, API-equivalent cost estimates, and
//! aggregation by day, agent, model and session. Pure: no IO.
//!
//! Every dollar figure here is an estimate of what the same tokens would cost
//! on the provider's pay-as-you-go API. It is never a subscription bill. A
//! model without a price contributes tokens but no cost, and a row whose
//! usage has no price reports `known: false` rather than zero.
use crate::session_meta::{SessionMeta, SessionUsage, UsageBucket};
use crate::usage_import::is_imported_agent;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::{BTreeMap, HashMap};

/// The bundled price table, transcribed from the providers' official pricing
/// pages on its `asOf` date. Users override single models in settings.
const BUNDLED_PRICES: &str = include_str!("usage_prices.json");

/// Token counts of one turn, or a sum of turns. Zero means not reported.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(default, rename_all = "camelCase")]
pub struct TokenCounts {
    /// Input tokens as the agent reported them (see `input_includes_cache`).
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    /// Reasoning tokens. Reported as part of `output` by the providers this
    /// table prices, so never added to the cost a second time.
    pub thought: u64,
    /// The agent's own total when it sent one, else the sum of the parts.
    pub total: u64,
}

impl TokenCounts {
    pub fn is_empty(&self) -> bool {
        self.input == 0
            && self.output == 0
            && self.cache_read == 0
            && self.cache_write == 0
            && self.thought == 0
            && self.total == 0
    }
    /// The reported total, or input plus output plus cache tokens.
    pub fn effective_total(&self) -> u64 {
        if self.total > 0 {
            self.total
        } else {
            self.input
                .saturating_add(self.output)
                .saturating_add(self.cache_read)
                .saturating_add(self.cache_write)
        }
    }
    pub fn add(&mut self, other: &TokenCounts) {
        self.input = self.input.saturating_add(other.input);
        self.output = self.output.saturating_add(other.output);
        self.cache_read = self.cache_read.saturating_add(other.cache_read);
        self.cache_write = self.cache_write.saturating_add(other.cache_write);
        self.thought = self.thought.saturating_add(other.thought);
        self.total = self.total.saturating_add(other.effective_total());
    }
}

/// Where a price table came from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PriceSource {
    pub provider: String,
    pub url: String,
}

/// USD per million tokens for one model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModelPrice {
    pub id: String,
    pub label: String,
    /// `anthropic`, `openai`, `google`, or `custom` for a settings override.
    pub provider: String,
    /// Short names an agent may use for the model, such as `opus`.
    #[serde(default)]
    pub aliases: Vec<String>,
    pub input: f64,
    pub output: f64,
    /// Cache hits. Absent: the input rate.
    #[serde(default)]
    pub cache_read: Option<f64>,
    /// Cache writes (the 5 minute rate where a provider has several).
    /// Absent: the input rate, as for providers that do not bill writes.
    #[serde(default)]
    pub cache_write: Option<f64>,
    #[serde(default)]
    pub note: Option<String>,
}

/// A dated price table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PriceTable {
    pub as_of: String,
    pub currency: String,
    pub unit: String,
    pub sources: Vec<PriceSource>,
    pub models: Vec<ModelPrice>,
}

/// One `agents.usage.prices.<model>` entry: USD per million tokens. The key
/// is a model id or id prefix as the agent names the model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PriceOverride {
    pub input: f64,
    pub output: f64,
    #[serde(default)]
    #[specta(optional)]
    pub cache_read: Option<f64>,
    #[serde(default)]
    #[specta(optional)]
    pub cache_write: Option<f64>,
}

// Settings derive `Eq`; rates are plain finite numbers compared by value.
impl Eq for PriceOverride {}

impl PriceOverride {
    fn valid(&self) -> bool {
        let ok = |v: f64| v.is_finite() && (0.0..=10_000.0).contains(&v);
        ok(self.input)
            && ok(self.output)
            && self.cache_read.is_none_or(ok)
            && self.cache_write.is_none_or(ok)
    }
}

/// How a model id found its price.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PriceMatchKind {
    /// The id names the priced model.
    Exact,
    /// A short name the table maps to the current model of that line.
    Alias,
    /// A longer id of a priced model, such as a variant or a dated snapshot.
    Family,
    /// The user's own price from settings.
    Override,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PriceMatch {
    pub id: String,
    pub label: String,
    pub kind: PriceMatchKind,
    #[serde(default)]
    pub note: Option<String>,
}

impl PriceTable {
    /// The bundled table. It is part of the binary, so a parse failure is a
    /// build defect caught by the unit tests.
    pub fn bundled() -> PriceTable {
        serde_json::from_str(BUNDLED_PRICES).expect("bundled usage price table is valid JSON")
    }

    /// The table with the user's overrides placed first. Invalid entries
    /// (negative, not finite, absurdly large) are ignored.
    pub fn with_overrides(mut self, overrides: &BTreeMap<String, PriceOverride>) -> PriceTable {
        let mut custom: Vec<ModelPrice> = overrides
            .iter()
            .filter(|(key, value)| !normalize_model(key).is_empty() && value.valid())
            .map(|(key, value)| ModelPrice {
                id: normalize_model(key),
                label: key.trim().to_owned(),
                provider: "custom".into(),
                aliases: vec![],
                input: value.input,
                output: value.output,
                cache_read: value.cache_read,
                cache_write: value.cache_write,
                note: None,
            })
            .collect();
        custom.append(&mut self.models);
        self.models = custom;
        self
    }

    /// The price for a model id as an agent names it. Overrides first (the
    /// longest key the id starts with), then an exact id, an alias, and the longest priced id the
    /// model id extends (`gpt-5.5-codex` is priced as `gpt-5.5`).
    pub fn lookup(&self, model: &str) -> Option<(&ModelPrice, PriceMatchKind)> {
        let id = normalize_model(model);
        if id.is_empty() {
            return None;
        }
        let custom = |p: &&ModelPrice| p.provider == "custom";
        if let Some(price) = self
            .models
            .iter()
            .filter(custom)
            .filter(|p| id.starts_with(&p.id))
            .max_by_key(|p| p.id.len())
        {
            return Some((price, PriceMatchKind::Override));
        }
        let table = || self.models.iter().filter(|p| p.provider != "custom");
        if let Some(price) = table().find(|p| p.id == id) {
            return Some((price, PriceMatchKind::Exact));
        }
        if let Some(price) = table().find(|p| p.aliases.contains(&id)) {
            return Some((price, PriceMatchKind::Alias));
        }
        table()
            .filter(|p| extends(&id, &p.id))
            .max_by_key(|p| p.id.len())
            .map(|p| (p, PriceMatchKind::Family))
    }

    pub fn info(&self) -> PriceTableInfo {
        PriceTableInfo {
            as_of: self.as_of.clone(),
            currency: self.currency.clone(),
            unit: self.unit.clone(),
            sources: self.sources.clone(),
            models: self.models.len() as u32,
        }
    }
}

/// `id` is a longer form of `base`: `base` followed by a separator and a
/// part that does not start with a digit, so `claude-opus-4` never prices
/// `claude-opus-4-8` and `gpt-5` never prices `gpt-5.1`.
fn extends(id: &str, base: &str) -> bool {
    let Some(rest) = id.strip_prefix(base) else {
        return false;
    };
    let mut chars = rest.chars();
    matches!(chars.next(), Some('-' | '_' | ':' | '@'))
        && chars.next().is_some_and(|c| !c.is_ascii_digit())
}

/// Lowercase id without a provider prefix (`anthropic/`, `openai:`,
/// `anthropic.`), a context suffix (`[1m]`), or a date snapshot suffix
/// (`-20250514`, `-2025-05-14`). Claude ids use dashes for versions, so a
/// `claude-opus-4.5` style id is read as `claude-opus-4-5`.
pub fn normalize_model(model: &str) -> String {
    let mut id = model.trim().to_ascii_lowercase();
    if let Some(index) = id.find('[') {
        id.truncate(index);
    }
    if let Some(index) = id.rfind('/') {
        id = id[index + 1..].to_owned();
    }
    for prefix in ["anthropic.", "openai:", "google:", "anthropic:", "models/"] {
        if let Some(rest) = id.strip_prefix(prefix) {
            id = rest.to_owned();
        }
    }
    let strip_date = |text: &str| -> Option<usize> {
        let bytes = text.as_bytes();
        let n = bytes.len();
        // -YYYYMMDD
        if n > 9
            && bytes[n - 9] == b'-'
            && bytes[n - 8..].iter().all(u8::is_ascii_digit)
            && bytes[n - 8] == b'2'
        {
            return Some(n - 9);
        }
        // -YYYY-MM-DD
        if n > 11
            && bytes[n - 11] == b'-'
            && bytes[n - 10] == b'2'
            && bytes[n - 10..n - 6].iter().all(u8::is_ascii_digit)
            && bytes[n - 6] == b'-'
            && bytes[n - 5..n - 3].iter().all(u8::is_ascii_digit)
            && bytes[n - 3] == b'-'
            && bytes[n - 2..].iter().all(u8::is_ascii_digit)
        {
            return Some(n - 11);
        }
        None
    };
    if let Some(end) = strip_date(&id) {
        id.truncate(end);
    }
    if id.starts_with("claude") {
        id = id.replace('.', "-");
    }
    id.trim().to_owned()
}

/// Whether a provider's input count already contains the cache hits. OpenAI
/// and Google report cached tokens as a part of the prompt tokens; Anthropic
/// reports fresh input, cache reads and cache writes apart.
fn input_includes_cache(provider: &str) -> bool {
    matches!(provider, "openai" | "google")
}

/// API-equivalent cost of `tokens` at `price`, in USD.
pub fn estimate_usd(tokens: &TokenCounts, price: &ModelPrice) -> f64 {
    let fresh_input = if input_includes_cache(&price.provider) {
        tokens.input.saturating_sub(tokens.cache_read)
    } else {
        tokens.input
    };
    let per = |count: u64, rate: f64| count as f64 * rate / 1_000_000.0;
    per(fresh_input, price.input)
        + per(tokens.output, price.output)
        + per(tokens.cache_read, price.cache_read.unwrap_or(price.input))
        + per(tokens.cache_write, price.cache_write.unwrap_or(price.input))
}

/// An inclusive range of local calendar days, `YYYY-MM-DD`. Absent bounds are
/// open.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageRange {
    #[serde(default)]
    #[specta(optional)]
    pub from: Option<String>,
    #[serde(default)]
    #[specta(optional)]
    pub to: Option<String>,
    /// Minutes east of UTC of the viewer's time zone, used to place imported
    /// usage (kept per UTC hour) on local days. Absent: UTC.
    #[serde(default)]
    #[specta(optional)]
    pub utc_offset_minutes: Option<i32>,
    #[serde(default)]
    #[specta(optional)]
    pub source: Option<UsageSource>,
}

/// Which usage a range covers (ADR 0012): what Span tracked over ACP, what
/// the opt-in importers read from agents' local logs, or both.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum UsageSource {
    #[default]
    All,
    Tracked,
    Imported,
}

impl UsageRange {
    fn includes(&self, meta: &SessionMeta) -> bool {
        let imported = is_imported_agent(&meta.agent_id);
        match self.source.unwrap_or_default() {
            UsageSource::All => true,
            UsageSource::Tracked => !imported,
            UsageSource::Imported => imported,
        }
    }
    fn contains(&self, day: &str) -> bool {
        self.from.as_deref().is_none_or(|from| day >= from)
            && self.to.as_deref().is_none_or(|to| day <= to)
    }
}

/// A cost figure. `known` is false when none of the usage has a price or a
/// reported cost: the UI then shows no amount, never zero. `complete` is
/// false when some tokens had neither.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageCost {
    /// `reported_usd + estimated_usd`.
    pub usd: f64,
    /// Cost the agent itself reported over ACP, in USD.
    pub reported_usd: f64,
    /// Span's estimate from tokens and the price table.
    pub estimated_usd: f64,
    /// Tokens that have neither a price nor a reported cost.
    pub unpriced_tokens: u64,
    pub known: bool,
    pub complete: bool,
}

impl UsageCost {
    pub(crate) fn add(&mut self, other: &UsageCost) {
        self.usd += other.usd;
        self.reported_usd += other.reported_usd;
        self.estimated_usd += other.estimated_usd;
        self.unpriced_tokens = self.unpriced_tokens.saturating_add(other.unpriced_tokens);
        self.known |= other.known;
        self.complete = self.complete && other.complete;
    }
    pub(crate) fn empty() -> UsageCost {
        UsageCost {
            complete: true,
            ..UsageCost::default()
        }
    }
}

/// Sums for a group of buckets.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    pub tokens: TokenCounts,
    pub turns: u32,
    /// Turns whose agent reported token counts.
    pub turns_with_tokens: u32,
    pub sessions: u32,
    pub cost: UsageCost,
}

impl Default for UsageTotals {
    fn default() -> Self {
        UsageTotals {
            tokens: TokenCounts::default(),
            turns: 0,
            turns_with_tokens: 0,
            sessions: 0,
            cost: UsageCost::empty(),
        }
    }
}

impl UsageTotals {
    fn add_bucket(&mut self, bucket: &UsageBucket, cost: &UsageCost) {
        self.tokens.add(&bucket.tokens());
        self.turns = self.turns.saturating_add(bucket.turns);
        self.turns_with_tokens = self
            .turns_with_tokens
            .saturating_add(bucket.turns_with_tokens);
        self.cost.add(cost);
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PriceTableInfo {
    pub as_of: String,
    pub currency: String,
    pub unit: String,
    pub sources: Vec<PriceSource>,
    pub models: u32,
}

/// One agent's share of a day.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DaySlice {
    pub agent_id: String,
    pub tokens: u64,
    pub cost: UsageCost,
}

/// One model of one agent on one day, for the chart's by-model view.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DayModelSlice {
    pub agent_id: String,
    pub model: String,
    pub tokens: u64,
    pub cost: UsageCost,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DayUsage {
    pub day: String,
    pub agents: Vec<DaySlice>,
    /// The same day by agent and model.
    #[serde(default)]
    pub models: Vec<DayModelSlice>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    pub agent_id: String,
    pub name: String,
    pub totals: UsageTotals,
    /// Read from the agent's local logs rather than tracked by Span.
    pub imported: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    /// The model as the agent named it. Empty when the agent named none.
    pub model: String,
    pub agent_ids: Vec<String>,
    pub price: Option<PriceMatch>,
    pub totals: UsageTotals,
}

/// One session's usage in the range.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsageRow {
    /// Read from the agent's local logs rather than tracked by Span.
    pub imported: bool,
    pub agent_id: String,
    pub agent_name: String,
    pub session_id: String,
    pub title: Option<String>,
    pub first_seen_ms: u64,
    pub last_active_ms: u64,
    pub models: Vec<String>,
    pub totals: UsageTotals,
    /// Peak context window occupancy the agent reported, and the window size.
    pub context_peak: u64,
    pub context_size: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub range: UsageRange,
    pub totals: UsageTotals,
    /// Every day of the range, oldest first, with zero days filled in. For
    /// an open range it starts at the first recorded day.
    pub days: Vec<DayUsage>,
    /// Most tokens first.
    pub agents: Vec<AgentUsage>,
    /// Most tokens first.
    pub models: Vec<ModelUsage>,
    /// The model with the most tokens (turns when no tokens were reported).
    pub top_model: Option<String>,
    pub prices: PriceTableInfo,
    /// Sessions with any usage counters at all, in or out of the range.
    pub tracked_sessions: u32,
}

/// The cost of one bucket: the agent's reported USD cost when it sent one,
/// else an estimate from its tokens, else unknown.
pub fn bucket_cost(bucket: &UsageBucket, prices: &PriceTable) -> UsageCost {
    let tokens = bucket.tokens();
    let reported = bucket.cost_micros > 0 && bucket.currency.as_deref() == Some("USD");
    if reported {
        let usd = bucket.cost_micros as f64 / 1_000_000.0;
        return UsageCost {
            usd,
            reported_usd: usd,
            estimated_usd: 0.0,
            unpriced_tokens: 0,
            known: true,
            complete: true,
        };
    }
    if tokens.is_empty() {
        return UsageCost::empty();
    }
    match prices.lookup(&bucket.model) {
        Some((price, _)) => {
            let usd = estimate_usd(&tokens, price);
            UsageCost {
                usd,
                reported_usd: 0.0,
                estimated_usd: usd,
                unpriced_tokens: 0,
                known: true,
                complete: true,
            }
        }
        None => UsageCost {
            unpriced_tokens: tokens.effective_total(),
            known: false,
            complete: false,
            ..UsageCost::default()
        },
    }
}

fn has_usage(usage: &Option<SessionUsage>) -> bool {
    usage.as_ref().is_some_and(|u| !u.buckets.is_empty())
}

fn agent_name(meta: &SessionMeta) -> String {
    if meta.connection_name.trim().is_empty() {
        meta.agent_id.clone()
    } else {
        meta.connection_name.clone()
    }
}

/// Totals by day, agent and model over `sessions` for `range`.
pub fn summarize(
    sessions: &[SessionMeta],
    range: &UsageRange,
    prices: &PriceTable,
) -> UsageSummary {
    let mut totals = UsageTotals::default();
    let mut days: BTreeMap<String, BTreeMap<String, (u64, UsageCost)>> = BTreeMap::new();
    #[allow(clippy::type_complexity)]
    let mut day_models: BTreeMap<String, BTreeMap<(String, String), (u64, UsageCost)>> =
        BTreeMap::new();
    let mut agents: HashMap<String, AgentUsage> = HashMap::new();
    let mut models: HashMap<String, ModelUsage> = HashMap::new();
    let mut tracked = 0u32;
    for meta in sessions.iter().filter(|meta| range.includes(meta)) {
        if !has_usage(&meta.usage) {
            continue;
        }
        tracked += 1;
        let usage = meta.usage.as_ref().expect("checked above");
        let mut counted = false;
        let mut agent_counted = false;
        let mut models_counted: Vec<String> = vec![];
        for bucket in usage.buckets.iter().filter(|b| range.contains(&b.day)) {
            let cost = bucket_cost(bucket, prices);
            counted = true;
            totals.add_bucket(bucket, &cost);
            let day = days.entry(bucket.day.clone()).or_default();
            let slice = day
                .entry(meta.agent_id.clone())
                .or_insert_with(|| (0, UsageCost::empty()));
            slice.0 = slice.0.saturating_add(bucket.tokens().effective_total());
            slice.1.add(&cost);
            let model_slice = day_models
                .entry(bucket.day.clone())
                .or_default()
                .entry((meta.agent_id.clone(), bucket.model.clone()))
                .or_insert_with(|| (0, UsageCost::empty()));
            model_slice.0 = model_slice
                .0
                .saturating_add(bucket.tokens().effective_total());
            model_slice.1.add(&cost);
            let agent = agents
                .entry(meta.agent_id.clone())
                .or_insert_with(|| AgentUsage {
                    agent_id: meta.agent_id.clone(),
                    name: agent_name(meta),
                    totals: UsageTotals::default(),
                    imported: is_imported_agent(&meta.agent_id),
                });
            agent.totals.add_bucket(bucket, &cost);
            if !agent_counted {
                agent.totals.sessions += 1;
                agent_counted = true;
            }
            let model = models
                .entry(bucket.model.clone())
                .or_insert_with(|| ModelUsage {
                    model: bucket.model.clone(),
                    agent_ids: vec![],
                    price: prices.lookup(&bucket.model).map(|(p, kind)| PriceMatch {
                        id: p.id.clone(),
                        label: p.label.clone(),
                        kind,
                        note: p.note.clone(),
                    }),
                    totals: UsageTotals::default(),
                });
            model.totals.add_bucket(bucket, &cost);
            if !model.agent_ids.contains(&meta.agent_id) {
                model.agent_ids.push(meta.agent_id.clone());
            }
            if !models_counted.contains(&bucket.model) {
                model.totals.sessions += 1;
                models_counted.push(bucket.model.clone());
            }
        }
        if counted {
            totals.sessions += 1;
        }
    }
    let first = range
        .from
        .clone()
        .or_else(|| days.keys().next().cloned())
        .filter(|day| parse_day(day).is_some());
    let last = range
        .to
        .clone()
        .or_else(|| days.keys().next_back().cloned())
        .filter(|day| parse_day(day).is_some());
    let mut day_rows: Vec<DayUsage> = vec![];
    if let (Some(first), Some(last)) = (first, last) {
        for day in day_span(&first, &last, 400) {
            let slices = days.remove(&day).unwrap_or_default();
            let models = day_models
                .remove(&day)
                .unwrap_or_default()
                .into_iter()
                .map(|((agent_id, model), (tokens, cost))| DayModelSlice {
                    agent_id,
                    model,
                    tokens,
                    cost,
                })
                .collect();
            day_rows.push(DayUsage {
                day,
                models,
                agents: slices
                    .into_iter()
                    .map(|(agent_id, (tokens, cost))| DaySlice {
                        agent_id,
                        tokens,
                        cost,
                    })
                    .collect(),
            });
        }
    }
    let mut agents: Vec<AgentUsage> = agents.into_values().collect();
    agents.sort_by(|a, b| {
        b.totals
            .tokens
            .total
            .cmp(&a.totals.tokens.total)
            .then(b.totals.turns.cmp(&a.totals.turns))
            .then(a.agent_id.cmp(&b.agent_id))
    });
    let mut models: Vec<ModelUsage> = models.into_values().collect();
    models.sort_by(|a, b| {
        b.totals
            .tokens
            .total
            .cmp(&a.totals.tokens.total)
            .then(b.totals.turns.cmp(&a.totals.turns))
            .then(a.model.cmp(&b.model))
    });
    let top_model = models
        .iter()
        .find(|m| !m.model.is_empty() && (m.totals.tokens.total > 0 || m.totals.turns > 0))
        .map(|m| m.model.clone());
    UsageSummary {
        range: range.clone(),
        totals,
        days: day_rows,
        agents,
        models,
        top_model,
        prices: prices.info(),
        tracked_sessions: tracked,
    }
}

/// Sessions with usage in `range`, most recently active first.
pub fn session_rows(
    sessions: &[SessionMeta],
    range: &UsageRange,
    prices: &PriceTable,
) -> Vec<SessionUsageRow> {
    let mut rows: Vec<SessionUsageRow> = sessions
        .iter()
        .filter(|meta| range.includes(meta))
        .filter_map(|meta| {
            let usage = meta.usage.as_ref()?;
            let mut totals = UsageTotals::default();
            let mut models: Vec<String> = vec![];
            for bucket in usage.buckets.iter().filter(|b| range.contains(&b.day)) {
                totals.add_bucket(bucket, &bucket_cost(bucket, prices));
                if !bucket.model.is_empty() && !models.contains(&bucket.model) {
                    models.push(bucket.model.clone());
                }
            }
            if totals.turns == 0 && totals.tokens.is_empty() && !totals.cost.known {
                return None;
            }
            totals.sessions = 1;
            Some(SessionUsageRow {
                imported: is_imported_agent(&meta.agent_id),
                agent_id: meta.agent_id.clone(),
                agent_name: agent_name(meta),
                session_id: meta.session_id.clone(),
                title: meta.title_override.clone(),
                first_seen_ms: meta.first_seen_ms,
                last_active_ms: meta.last_active_ms,
                models,
                totals,
                context_peak: usage.context_peak,
                context_size: usage.context_size,
            })
        })
        .collect();
    rows.sort_by(|a, b| {
        b.last_active_ms
            .cmp(&a.last_active_ms)
            .then(a.session_id.cmp(&b.session_id))
    });
    rows
}

/// `(year, month, day)` of a valid `YYYY-MM-DD`.
pub fn parse_day(day: &str) -> Option<(i64, u32, u32)> {
    let bytes = day.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year: i64 = day[0..4].parse().ok()?;
    let month: u32 = day[5..7].parse().ok()?;
    let date: u32 = day[8..10].parse().ok()?;
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        _ => return None,
    };
    (1..=days_in_month)
        .contains(&date)
        .then_some((year, month, date))
}

/// Days since 1970-01-01 of a calendar date.
pub fn days_since_epoch(year: i64, month: u32, day: u32) -> i64 {
    days_from_civil(year, month, day)
}

/// Days since 1970-01-01 (Howard Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let m = i64::from(month);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `YYYY-MM-DD` of a day number (`civil_from_days`).
pub fn day_from_number(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

/// The UTC calendar day of a Unix millisecond time.
pub fn utc_day(ms: u64) -> String {
    day_from_number((ms / 86_400_000) as i64)
}

/// Every day from `first` to `last` inclusive, at most `cap` days (the most
/// recent ones when the span is longer).
fn day_span(first: &str, last: &str, cap: usize) -> Vec<String> {
    let (Some(a), Some(b)) = (parse_day(first), parse_day(last)) else {
        return vec![];
    };
    let start = days_from_civil(a.0, a.1, a.2);
    let end = days_from_civil(b.0, b.1, b.2);
    if end < start {
        return vec![];
    }
    let start = start.max(end - cap as i64 + 1);
    (start..=end).map(day_from_number).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_meta::{ContextReading, ReportedCost, SessionMetaPatch, UsagePatch};
    use crate::SessionMetaStore;

    fn tokens(input: u64, output: u64, cache_read: u64, cache_write: u64) -> TokenCounts {
        TokenCounts {
            input,
            output,
            cache_read,
            cache_write,
            ..TokenCounts::default()
        }
    }

    fn turn(day: &str, model: &str, tokens: Option<TokenCounts>, cost: Option<u64>) -> UsagePatch {
        UsagePatch {
            day: Some(day.into()),
            model: Some(model.into()),
            tokens,
            cost_total: cost.map(|micros| ReportedCost {
                micros,
                currency: "USD".into(),
            }),
            context: None,
            turns: None,
        }
    }

    fn record(store: &SessionMetaStore, agent: &str, session: &str, usage: UsagePatch, now: u64) {
        let mut patch = SessionMetaPatch::new(agent, session);
        patch.connection_name = Some(agent.to_uppercase());
        patch.usage = Some(usage);
        store.upsert_at(patch, now).unwrap();
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn usage_bundled_table_parses_with_dated_official_sources() {
        let table = PriceTable::bundled();
        assert_eq!(table.currency, "USD");
        assert!(parse_day(&table.as_of).is_some());
        assert_eq!(table.sources.len(), 3);
        assert!(table.sources.iter().all(|s| s.url.starts_with("https://")));
        let mut ids: Vec<&str> = table.models.iter().map(|m| m.id.as_str()).collect();
        ids.sort();
        let before = ids.len();
        ids.dedup();
        assert_eq!(before, ids.len(), "duplicate model ids");
        for model in &table.models {
            assert_eq!(
                normalize_model(&model.id),
                model.id,
                "{} is not normalized",
                model.id
            );
            assert!(model.input >= 0.0 && model.output > 0.0, "{}", model.id);
        }
    }

    #[test]
    fn usage_lookup_matches_exact_alias_family_and_snapshot_ids() {
        let table = PriceTable::bundled();
        let kind = |model: &str| table.lookup(model).map(|(p, k)| (p.id.clone(), k));
        assert_eq!(
            kind("claude-opus-5-5"),
            Some(("claude-opus-5-5".into(), PriceMatchKind::Exact))
        );
        assert_eq!(
            kind("anthropic/Claude-Opus-4.5"),
            Some(("claude-opus-4-5".into(), PriceMatchKind::Exact))
        );
        assert_eq!(
            kind("claude-sonnet-4-5-20250929"),
            Some(("claude-sonnet-4-5".into(), PriceMatchKind::Exact))
        );
        assert_eq!(
            kind("opus[1m]"),
            Some(("claude-opus-5-5".into(), PriceMatchKind::Alias))
        );
        assert_eq!(
            kind("gpt-5.5-codex"),
            Some(("gpt-5.5".into(), PriceMatchKind::Family))
        );
        // A version number is never a family suffix.
        assert_eq!(kind("claude-opus-4-9"), None);
        assert_eq!(kind("gpt-5.9"), None);
        assert_eq!(kind("default"), None);
        assert_eq!(kind(""), None);
    }

    #[test]
    fn usage_overrides_win_and_invalid_overrides_are_ignored() {
        let mut overrides = BTreeMap::new();
        overrides.insert(
            "claude-opus".to_owned(),
            PriceOverride {
                input: 1.0,
                output: 2.0,
                cache_read: None,
                cache_write: None,
            },
        );
        overrides.insert(
            "my-local-model".to_owned(),
            PriceOverride {
                input: -1.0,
                output: 2.0,
                cache_read: None,
                cache_write: None,
            },
        );
        let table = PriceTable::bundled().with_overrides(&overrides);
        let (price, kind) = table.lookup("claude-opus-5-5").unwrap();
        assert_eq!(kind, PriceMatchKind::Override);
        assert!(close(price.input, 1.0));
        assert!(table.lookup("my-local-model").is_none());
    }

    #[test]
    fn usage_estimate_counts_cache_once_per_provider_convention() {
        let table = PriceTable::bundled();
        let (opus, _) = table.lookup("claude-opus-5-5").unwrap();
        // Anthropic: input excludes cache. 1M fresh at $4, 1M out at $20,
        // 1M cache read at $0.20, 1M cache write at $5.
        let usd = estimate_usd(&tokens(1_000_000, 1_000_000, 1_000_000, 1_000_000), opus);
        assert!(close(usd, 29.2), "{usd}");
        let (gpt, _) = table.lookup("gpt-5.5").unwrap();
        // OpenAI: cached input is part of input. 1M input of which 0.5M
        // cached: 0.5M at $5 + 0.5M at $0.50, plus 0.1M out at $30.
        let usd = estimate_usd(&tokens(1_000_000, 100_000, 500_000, 0), gpt);
        assert!(close(usd, 2.5 + 0.25 + 3.0), "{usd}");
    }

    #[test]
    fn usage_turns_add_and_cumulative_cost_adds_only_its_growth() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionMetaStore::in_directory(dir.path(), "/w");
        record(
            &store,
            "claude",
            "s1",
            turn(
                "2026-10-01",
                "opus",
                Some(tokens(100, 10, 0, 0)),
                Some(50_000),
            ),
            1,
        );
        record(
            &store,
            "claude",
            "s1",
            turn(
                "2026-10-01",
                "opus",
                Some(tokens(200, 20, 0, 0)),
                Some(80_000),
            ),
            2,
        );
        // A replayed report of the same total adds nothing.
        record(
            &store,
            "claude",
            "s1",
            UsagePatch {
                turns: Some(0),
                ..turn("2026-10-01", "opus", None, Some(80_000))
            },
            3,
        );
        let meta = store.get("claude", "s1").unwrap().unwrap();
        let usage = meta.usage.unwrap();
        assert_eq!(usage.buckets.len(), 1);
        let bucket = &usage.buckets[0];
        assert_eq!((bucket.input, bucket.output, bucket.total), (300, 30, 330));
        assert_eq!(bucket.turns, 2);
        assert_eq!(bucket.cost_micros, 80_000);
        // A lower total means the agent's counter restarted.
        record(
            &store,
            "claude",
            "s1",
            turn("2026-10-02", "opus", None, Some(10_000)),
            4,
        );
        let usage = store.get("claude", "s1").unwrap().unwrap().usage.unwrap();
        let second = usage
            .buckets
            .iter()
            .find(|b| b.day == "2026-10-02")
            .unwrap();
        assert_eq!(second.cost_micros, 10_000);
        assert_eq!(second.turns_with_tokens, 0);
    }

    #[test]
    fn usage_context_readings_keep_the_peak_and_a_bare_reading_makes_no_bucket() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionMetaStore::in_directory(dir.path(), "/w");
        for used in [5_000, 90_000, 30_000] {
            let patch = UsagePatch {
                context: Some(ContextReading {
                    used,
                    size: 200_000,
                }),
                turns: Some(0),
                ..UsagePatch::default()
            };
            record(&store, "codex", "s", patch, 1);
        }
        let usage = store.get("codex", "s").unwrap().unwrap().usage.unwrap();
        assert_eq!((usage.context_peak, usage.context_size), (90_000, 200_000));
        assert!(usage.buckets.is_empty());
    }

    #[test]
    fn usage_buckets_fold_without_losing_counts() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionMetaStore::in_directory(dir.path(), "/w");
        for day in 1..=40u32 {
            let day = format!("2026-08-{:02}", ((day - 1) % 31) + 1);
            let month_day = if day.ends_with("31") {
                day.clone()
            } else {
                day
            };
            record(
                &store,
                "claude",
                "s",
                turn(&month_day, "opus", Some(tokens(10, 1, 0, 0)), None),
                1,
            );
        }
        let usage = store.get("claude", "s").unwrap().unwrap().usage.unwrap();
        assert!(usage.buckets.len() <= crate::MAX_USAGE_BUCKETS);
        let input: u64 = usage.buckets.iter().map(|b| b.input).sum();
        let turns: u32 = usage.buckets.iter().map(|b| b.turns).sum();
        assert_eq!((input, turns), (400, 40));
    }

    #[test]
    fn usage_invalid_day_falls_back_to_the_utc_day_and_currency_must_be_a_code() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionMetaStore::in_directory(dir.path(), "/w");
        let mut patch = turn("2026-02-30", "m", Some(tokens(1, 1, 0, 0)), None);
        patch.cost_total = Some(ReportedCost {
            micros: 5,
            currency: "usd".into(),
        });
        // 2026-10-29T00:00:00Z
        record(&store, "a", "s", patch, 1_793_232_000_000);
        let usage = store.get("a", "s").unwrap().unwrap().usage.unwrap();
        assert_eq!(usage.buckets[0].day, "2026-10-29");
        assert_eq!(usage.buckets[0].cost_micros, 0);
        assert!(usage.cost_seen.is_none());
    }

    #[test]
    fn usage_summary_groups_by_day_agent_and_model_and_never_prices_unknown_as_zero() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionMetaStore::in_directory(dir.path(), "/w");
        record(
            &store,
            "claude",
            "a",
            turn(
                "2026-10-27",
                "claude-opus-5-5",
                Some(tokens(1_000_000, 0, 0, 0)),
                None,
            ),
            10,
        );
        record(
            &store,
            "claude",
            "a",
            turn(
                "2026-10-29",
                "claude-opus-5-5",
                Some(tokens(0, 1_000_000, 0, 0)),
                None,
            ),
            20,
        );
        record(
            &store,
            "codex",
            "b",
            turn("2026-10-29", "gpt-5.5", None, Some(1_500_000)),
            30,
        );
        record(
            &store,
            "local",
            "c",
            turn(
                "2026-10-28",
                "mystery-model",
                Some(tokens(500, 500, 0, 0)),
                None,
            ),
            40,
        );
        let sessions = store.list().unwrap();
        let table = PriceTable::bundled();
        let range = UsageRange {
            from: Some("2026-10-26".into()),
            to: Some("2026-10-29".into()),
            ..UsageRange::default()
        };
        let summary = summarize(&sessions, &range, &table);
        assert_eq!(summary.days.len(), 4);
        assert_eq!(summary.days[0].day, "2026-10-26");
        assert!(summary.days[0].agents.is_empty());
        assert_eq!(summary.totals.sessions, 3);
        assert_eq!(summary.totals.turns, 4);
        // $4 input + $20 output estimated, $1.50 reported, the rest unpriced.
        assert!(close(summary.totals.cost.estimated_usd, 24.0));
        assert!(close(summary.totals.cost.reported_usd, 1.5));
        assert!(close(summary.totals.cost.usd, 25.5));
        assert_eq!(summary.totals.cost.unpriced_tokens, 1000);
        assert!(summary.totals.cost.known && !summary.totals.cost.complete);
        let local = summary
            .agents
            .iter()
            .find(|a| a.agent_id == "local")
            .unwrap();
        assert!(
            !local.totals.cost.known,
            "unknown price must not read as $0"
        );
        assert_eq!(summary.agents[0].agent_id, "claude");
        assert_eq!(summary.agents[0].name, "CLAUDE");
        assert_eq!(summary.top_model.as_deref(), Some("claude-opus-5-5"));
        let mystery = summary
            .models
            .iter()
            .find(|m| m.model == "mystery-model")
            .unwrap();
        assert!(mystery.price.is_none());

        let today = UsageRange {
            from: Some("2026-10-29".into()),
            to: Some("2026-10-29".into()),
            ..UsageRange::default()
        };
        let summary = summarize(&sessions, &today, &table);
        assert_eq!(summary.totals.sessions, 2);
        assert_eq!(summary.tracked_sessions, 3);
        let rows = session_rows(&sessions, &today, &table);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].session_id, "b", "most recently active first");

        let all = summarize(&sessions, &UsageRange::default(), &table);
        assert_eq!(all.days.first().map(|d| d.day.as_str()), Some("2026-10-27"));
        assert_eq!(all.days.len(), 3);
    }

    #[test]
    fn usage_all_stores_are_read_and_foreign_files_skipped() {
        let dir = tempfile::tempdir().unwrap();
        for root in ["/one", "/two"] {
            let store = SessionMetaStore::in_directory(dir.path(), root);
            record(
                &store,
                "claude",
                root,
                turn("2026-10-29", "opus", None, None),
                1,
            );
        }
        std::fs::write(dir.path().join("notes.json"), "{}").unwrap();
        std::fs::write(dir.path().join("0123456789abcdef.json.corrupt"), "x").unwrap();
        let all = SessionMetaStore::list_all_in(dir.path(), 10).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(
            SessionMetaStore::list_all_in(dir.path(), 1).unwrap().len(),
            1
        );
        let missing = dir.path().join("absent");
        assert!(SessionMetaStore::list_all_in(&missing, 10)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn usage_day_arithmetic_round_trips() {
        for day in ["1970-01-01", "2000-02-29", "2026-10-29", "2027-01-01"] {
            let (y, m, d) = parse_day(day).unwrap();
            assert_eq!(day_from_number(days_from_civil(y, m, d)), day);
        }
        assert!(parse_day("2026-13-01").is_none());
        assert!(parse_day("2026-1-01").is_none());
        assert_eq!(day_span("2026-12-30", "2027-01-02", 400).len(), 4);
        assert_eq!(day_span("2026-01-01", "2026-12-31", 30).len(), 30);
        assert_eq!(utc_day(0), "1970-01-01");
    }
}
