//! Defensive wire parsing for GitHub Copilot's VS Code quota response.

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, Result};

/// GitHub reports these as floats: `quota_remaining` is `198.3` where the
/// sibling `remaining` has already rounded to `198`, and a credit is spent in
/// fractions of one. Carrying the integers instead is what made a balance VS
/// Code shows as "1.7 / 200" read as "2 of 200".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Quota {
    pub percent_remaining: f64,
    pub entitlement: Option<f64>,
    pub remaining: Option<f64>,
    pub unlimited: bool,
    /// GitHub's own statement that the plan includes this allowance. Absent
    /// from a cache written before it was read, where every stored bucket was
    /// one we had already decided to keep.
    #[serde(default = "yes")]
    pub has_quota: bool,
    /// Under token-based billing the chat bucket is a pool of credits spent by
    /// every premium interaction, not a count of chat messages.
    #[serde(default)]
    pub token_based_billing: bool,
}

fn yes() -> bool {
    true
}

impl Quota {
    /// A bucket the plan does not include arrives as `has_quota: false` with a
    /// zero entitlement, and its `percent_remaining: 0` is the degenerate
    /// output of `remaining / entitlement` rather than an allowance that was
    /// spent. Copilot Free returns exactly that for premium interactions, and
    /// VS Code does not show the bucket at all.
    pub fn in_plan(&self) -> bool {
        self.unlimited || (self.has_quota && self.entitlement != Some(0.0))
    }

    pub fn used_pct(&self) -> i32 {
        if self.unlimited || !self.in_plan() {
            0
        } else {
            (100.0 - self.percent_remaining).round().clamp(0.0, 100.0) as i32
        }
    }

    pub fn used_and_entitlement(&self) -> Option<(f64, f64)> {
        let entitlement = self.entitlement?;
        Some(((entitlement - self.remaining?).max(0.0), entitlement))
    }

    /// The single rendering of "spent out of allowance", so the tooltip and
    /// the panel cannot disagree about how much of a credit is a credit.
    pub fn used_of_entitlement(&self) -> Option<String> {
        self.used_and_entitlement()
            .map(|(used, entitlement)| format!("{} of {}", count(used), count(entitlement)))
    }
}

/// A fractional credit keeps one decimal, as VS Code shows it; a whole count
/// stays whole rather than growing a `.0`.
pub fn count(value: f64) -> String {
    if (value.fract() * 10.0).round().abs() < f64::EPSILON {
        format!("{value:.0}")
    } else {
        format!("{value:.1}")
    }
}

/// Normalized and cacheable fields only. Raw GitHub responses can include
/// account metadata, which is neither needed for display nor retained.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    pub plan: String,
    pub premium: Option<Quota>,
    pub chat: Option<Quota>,
    pub completions: Option<Quota>,
    pub reset_at: Option<DateTime<Utc>>,
}

impl Snapshot {
    /// Labels follow what the account is actually billed for: under token-based
    /// billing GitHub's `chat` bucket is the credit pool VS Code calls
    /// "Credits", and `completions` the inline suggestions it meters.
    pub fn quotas(&self) -> impl Iterator<Item = (&'static str, &Quota)> {
        [
            ("Premium requests", "Premium requests", self.premium.as_ref()),
            ("Credits", "Chat", self.chat.as_ref()),
            ("Inline suggestions", "Completions", self.completions.as_ref()),
        ]
        .into_iter()
        .filter_map(|(credit_label, count_label, quota)| {
            let quota = quota.filter(|quota| quota.in_plan())?;
            Some((
                if quota.token_based_billing {
                    credit_label
                } else {
                    count_label
                },
                quota,
            ))
        })
    }

    pub fn worst_pct(&self) -> i32 {
        self.quotas()
            .map(|(_, quota)| quota.used_pct())
            .max()
            .unwrap_or(0)
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct Response {
    pub copilot_plan: Option<String>,
    pub quota_reset_date: Option<String>,
    pub quota_reset_date_utc: Option<String>,
    pub quota_snapshots: Option<QuotaSnapshots>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct QuotaSnapshots {
    pub premium_interactions: Option<Value>,
    pub chat: Option<Value>,
    pub completions: Option<Value>,
}

pub fn to_snapshot(response: Response) -> Result<Snapshot> {
    let quotas = response.quota_snapshots.unwrap_or_default();
    let premium = parse_quota(quotas.premium_interactions.as_ref());
    let chat = parse_quota(quotas.chat.as_ref());
    let completions = parse_quota(quotas.completions.as_ref());
    if premium.is_none() && chat.is_none() && completions.is_none() {
        return Err(AppError::Schema(
            "GitHub Copilot response contains no usable quota snapshots".into(),
        ));
    }
    let plan = response
        .copilot_plan
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "GitHub Copilot".to_string());
    let reset_at = response
        .quota_reset_date_utc
        .as_deref()
        .and_then(parse_reset)
        .or_else(|| response.quota_reset_date.as_deref().and_then(parse_reset));
    Ok(Snapshot {
        plan,
        premium,
        chat,
        completions,
        reset_at,
    })
}

/// One malformed optional bucket must not hide usable data in another. The
/// caller still rejects a response where every known bucket is unusable.
fn parse_quota(value: Option<&Value>) -> Option<Quota> {
    let object = value?.as_object()?;
    let flag = |name: &str| object.get(name).and_then(Value::as_bool);
    let unlimited = flag("unlimited").unwrap_or(false);
    let entitlement = object.get("entitlement").and_then(nonnegative);
    // `quota_remaining` is the unrounded figure; `remaining` is the same value
    // with the fraction already discarded, and only some payloads carry both.
    let remaining = object
        .get("quota_remaining")
        .and_then(nonnegative)
        .or_else(|| object.get("remaining").and_then(nonnegative));
    let percent_remaining = object
        .get("percent_remaining")
        .and_then(percent)
        .or_else(|| {
            entitlement
                .zip(remaining)
                .and_then(|(entitlement, remaining)| {
                    (entitlement > 0.0).then(|| (remaining * 100.0 / entitlement).clamp(0.0, 100.0))
                })
        });
    (unlimited || percent_remaining.is_some()).then_some(Quota {
        percent_remaining: percent_remaining.unwrap_or(100.0),
        entitlement,
        remaining,
        unlimited,
        has_quota: flag("has_quota").unwrap_or(true),
        token_based_billing: flag("token_based_billing").unwrap_or(false),
    })
}

fn nonnegative(value: &Value) -> Option<f64> {
    let value = value
        .as_f64()
        .or_else(|| value.as_str()?.trim().parse::<f64>().ok())?;
    (value.is_finite() && value >= 0.0).then_some(value)
}

fn percent(value: &Value) -> Option<f64> {
    nonnegative(value).map(|value| value.clamp(0.0, 100.0))
}

/// GitHub has returned both RFC3339 `quota_reset_date_utc` and date-only
/// `quota_reset_date`. A date-only reset means midnight UTC of that date.
fn parse_reset(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|value| value.with_timezone(&Utc))
        .or_else(|| {
            NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .ok()?
                .and_hms_opt(0, 0, 0)
                .map(|value| value.and_utc())
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_all_quota_buckets_and_date_only_reset() {
        let response: Response = serde_json::from_str(
            r#"{
                "copilot_plan":"business",
                "quota_reset_date":"2026-09-15",
                "quota_snapshots":{
                    "premium_interactions":{"entitlement":300,"remaining":45,"percent_remaining":15},
                    "chat":{"entitlement":"1000","remaining":"250"},
                    "completions":{"unlimited":true}
                }
            }"#,
        )
        .unwrap();
        let snapshot = to_snapshot(response).unwrap();
        assert_eq!(snapshot.plan, "business");
        assert_eq!(snapshot.premium.unwrap().used_pct(), 85);
        assert_eq!(
            snapshot.chat.unwrap().used_and_entitlement(),
            Some((750.0, 1000.0))
        );
        assert!(snapshot.completions.unwrap().unlimited);
        assert_eq!(
            snapshot.reset_at.unwrap().to_rfc3339(),
            "2026-09-15T00:00:00+00:00"
        );
    }

    /// The real Copilot Free payload, verbatim from `/copilot_internal/user`.
    /// `has_quota` is GitHub's own statement that a bucket is not part of the
    /// plan, `quota_remaining` carries the fraction that `remaining` rounds
    /// away, and `token_based_billing` is what makes the chat pool a credit
    /// balance rather than a message count — VS Code labels it "Credits" and
    /// shows "1.7 / 200 used" where the rounded integers say "2 of 200".
    #[test]
    fn token_based_billing_keeps_the_fraction_and_the_credit_labels() {
        let response: Response = serde_json::from_str(
            r#"{
                "copilot_plan":"individual",
                "quota_reset_date_utc":"2026-10-01T00:00:00.000Z",
                "quota_snapshots":{
                    "chat":{"percent_remaining":99.1,"quota_remaining":198.3,"remaining":198,
                            "entitlement":200,"unlimited":false,"has_quota":true,
                            "token_based_billing":true,"credits_used":1},
                    "completions":{"percent_remaining":63.0,"quota_remaining":1261.0,"remaining":1261,
                                   "entitlement":2000,"unlimited":false,"has_quota":true,
                                   "token_based_billing":true,"credits_used":739},
                    "premium_interactions":{"percent_remaining":0.0,"quota_remaining":0.0,"remaining":0,
                                            "entitlement":0,"unlimited":false,"has_quota":false,
                                            "token_based_billing":true,"credits_used":0}
                }
            }"#,
        )
        .unwrap();
        let snapshot = to_snapshot(response).unwrap();

        assert!(!snapshot.premium.clone().unwrap().in_plan());
        assert_eq!(
            snapshot.quotas().map(|(label, _)| label).collect::<Vec<_>>(),
            ["Credits", "Inline suggestions"]
        );

        let chat = snapshot.chat.clone().unwrap();
        assert_eq!(chat.used_of_entitlement().unwrap(), "1.7 of 200");
        assert_eq!(chat.used_pct(), 1);

        let completions = snapshot.completions.clone().unwrap();
        assert_eq!(completions.used_of_entitlement().unwrap(), "739 of 2000");
        assert_eq!(completions.used_pct(), 37);
        assert_eq!(snapshot.worst_pct(), 37);
    }

    /// Without token-based billing the chat bucket really is a chat-message
    /// allowance, so it must keep its own name.
    #[test]
    fn a_message_based_chat_bucket_keeps_the_chat_label() {
        let response: Response = serde_json::from_str(
            r#"{"quota_snapshots":{"chat":{"entitlement":50,"remaining":40,"percent_remaining":80}}}"#,
        )
        .unwrap();
        let snapshot = to_snapshot(response).unwrap();
        assert_eq!(
            snapshot.quotas().map(|(label, _)| label).collect::<Vec<_>>(),
            ["Chat"]
        );
        assert_eq!(
            snapshot.chat.clone().unwrap().used_of_entitlement().unwrap(),
            "10 of 50"
        );
    }

    /// Copilot Free reports premium interactions as a bucket the plan does not
    /// include: `entitlement: 0` with `percent_remaining: 0`. That zero is the
    /// degenerate output of `remaining / entitlement`, not an exhausted
    /// allowance, and reading it as "100% used" painted the whole module red
    /// while VS Code showed the same account as 0% used.
    #[test]
    fn a_bucket_the_plan_does_not_include_is_not_a_spent_one() {
        let response: Response = serde_json::from_str(
            r#"{
                "copilot_plan":"individual",
                "quota_reset_date_utc":"2026-10-01T00:00:00Z",
                "quota_snapshots":{
                    "premium_interactions":{"entitlement":0,"remaining":0,"percent_remaining":0},
                    "chat":{"entitlement":200,"remaining":198,"percent_remaining":99},
                    "completions":{"entitlement":2000,"remaining":1278,"percent_remaining":64}
                }
            }"#,
        )
        .unwrap();
        let snapshot = to_snapshot(response).unwrap();
        let premium = snapshot.premium.clone().unwrap();
        assert!(!premium.in_plan());
        assert_eq!(premium.used_pct(), 0);
        assert_eq!(
            snapshot.quotas().map(|(label, _)| label).collect::<Vec<_>>(),
            ["Chat", "Completions"]
        );
        assert_eq!(snapshot.worst_pct(), 36);
    }

    /// An allowance the plan *does* include, fully spent, still reads 100%.
    #[test]
    fn an_exhausted_bucket_still_reads_as_fully_used() {
        let response: Response = serde_json::from_str(
            r#"{"quota_snapshots":{"premium_interactions":{"entitlement":300,"remaining":0,"percent_remaining":0}}}"#,
        )
        .unwrap();
        let snapshot = to_snapshot(response).unwrap();
        assert!(snapshot.premium.clone().unwrap().in_plan());
        assert_eq!(snapshot.worst_pct(), 100);
    }

    #[test]
    fn accepts_one_good_bucket_and_rejects_an_empty_schema() {
        let partial: Response = serde_json::from_str(
            r#"{"quota_snapshots":{"chat":{"percent_remaining":"not-a-number"},"completions":{"remaining":4,"entitlement":8}}}"#,
        )
        .unwrap();
        let snapshot = to_snapshot(partial).unwrap();
        assert!(snapshot.chat.is_none());
        assert_eq!(snapshot.completions.unwrap().used_pct(), 50);

        let empty: Response = serde_json::from_str(r#"{"quota_snapshots":{}}"#).unwrap();
        assert!(to_snapshot(empty).is_err());
    }
}
