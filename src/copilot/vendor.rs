//! GitHub Copilot Waybar renderer.

use std::collections::HashMap;

use chrono::{DateTime, Utc};

use crate::countdown;
use crate::format::{placeholders, substitute, updated_at_hm};
use crate::pacing::PaceSeverity;
use crate::pango::{color_span, escape, severity_color, severity_for};
use crate::theme::Theme;
use crate::tooltip::{Line as TooltipLine, render_bordered};
use crate::vendor::{RenderOpts, VendorId, VendorOutcome};
use crate::waybar::{Class, WaybarOutput};

use super::fetch::FetchOutcome;
use super::types::{Snapshot, count};

/// Headline the worst quota the plan actually has rather than a fixed bucket:
/// `severity` already colours the module from `worst_pct`, and a plan without
/// premium requests (Copilot Free) otherwise shows a figure for an allowance
/// that does not exist.
pub const DEFAULT_FORMAT: &str = "{copilot_pct}% · {copilot_reset}";
const UNAVAILABLE: &str = "—";

impl From<FetchOutcome> for VendorOutcome {
    fn from(outcome: FetchOutcome) -> Self {
        outcome.map(crate::usage::VendorSnapshot::Copilot)
    }
}

pub fn build_placeholders(snap: &Snapshot, now: DateTime<Utc>) -> HashMap<&'static str, String> {
    let premium = quota_values(snap.premium.as_ref());
    let chat = quota_values(snap.chat.as_ref());
    let completions = quota_values(snap.completions.as_ref());
    let reset = countdown::format(snap.reset_at, now);
    placeholders([
        ("icon", "󰊤".to_string()),
        ("vendor_short", VendorId::Copilot.short_name().to_string()),
        ("plan", crate::display::sanitize_untrusted_field(&snap.plan)),
        ("session_pct", premium.percent.clone()),
        ("session_reset", reset.clone()),
        ("weekly_pct", chat.percent.clone()),
        ("weekly_reset", reset.clone()),
        (
            "copilot_plan",
            crate::display::sanitize_untrusted_field(&snap.plan),
        ),
        ("copilot_reset", reset),
        ("copilot_pct", snap.worst_pct().to_string()),
        ("copilot_premium_pct", premium.percent),
        ("copilot_premium_used", premium.used),
        ("copilot_premium_limit", premium.limit),
        ("copilot_chat_pct", chat.percent),
        ("copilot_chat_used", chat.used),
        ("copilot_chat_limit", chat.limit),
        ("copilot_completions_pct", completions.percent),
        ("copilot_completions_used", completions.used),
        ("copilot_completions_limit", completions.limit),
    ])
}

struct QuotaValues {
    percent: String,
    used: String,
    limit: String,
}

fn quota_values(quota: Option<&super::types::Quota>) -> QuotaValues {
    let Some(quota) = quota.filter(|quota| quota.in_plan()) else {
        return QuotaValues {
            percent: UNAVAILABLE.into(),
            used: UNAVAILABLE.into(),
            limit: UNAVAILABLE.into(),
        };
    };
    if quota.unlimited {
        return QuotaValues {
            percent: "0".into(),
            used: "0".into(),
            limit: "unlimited".into(),
        };
    }
    let (used, limit) = quota
        .used_and_entitlement()
        .map(|(used, limit)| (count(used), count(limit)))
        .unwrap_or_else(|| (UNAVAILABLE.into(), UNAVAILABLE.into()));
    QuotaValues {
        percent: quota.used_pct().to_string(),
        used,
        limit,
    }
}

pub fn severity(snap: &Snapshot) -> PaceSeverity {
    severity_for(snap.worst_pct())
}

pub fn render(
    outcome: &VendorOutcome,
    snap: &Snapshot,
    theme: &Theme,
    opts: &RenderOpts,
    now: DateTime<Utc>,
) -> WaybarOutput {
    let severity = severity(snap);
    let format = opts.format.as_deref().unwrap_or(DEFAULT_FORMAT);
    let mut values = build_placeholders(snap, now);
    for key in ["plan", "copilot_plan"] {
        if let Some(value) = values.get_mut(key) {
            *value = escape(value);
        }
    }
    let mut text = substitute(format, &values);
    if outcome.stale {
        text.push_str(" ⏸");
    }
    let icon = opts
        .icon
        .as_deref()
        .filter(|icon| !icon.is_empty())
        .map(|icon| format!("{} ", escape(icon)))
        .unwrap_or_default();
    let tooltip = opts
        .tooltip_format
        .as_deref()
        .map(|format| substitute(format, &values))
        .unwrap_or_else(|| render_tooltip(outcome, snap, theme, now));
    WaybarOutput {
        text: color_span(severity_color(severity, theme), &format!("{icon}{text}")),
        tooltip,
        class: Class::from(severity),
    }
}

fn render_tooltip(
    outcome: &VendorOutcome,
    snap: &Snapshot,
    theme: &Theme,
    now: DateTime<Utc>,
) -> String {
    let mut lines = vec![TooltipLine::Center(format!(
        "<span font_weight='bold' foreground='{}'>GitHub Copilot {}</span>",
        theme.blue,
        escape(&crate::display::sanitize_untrusted_field(&snap.plan))
    ))];
    lines.push(TooltipLine::Sep);
    lines.push(TooltipLine::Body(String::new()));
    for (label, quota) in snap.quotas() {
        let usage = if quota.unlimited {
            "Unlimited".to_string()
        } else if let Some(used) = quota.used_of_entitlement() {
            format!("{}% · {used} used", quota.used_pct())
        } else {
            format!("{}% · {:.0}% remaining", quota.used_pct(), quota.percent_remaining)
        };
        lines.push(TooltipLine::Body(format!("  {label}  {}", escape(&usage))));
    }
    lines.push(TooltipLine::Body(format!(
        "  Resets  {}",
        escape(&countdown::format(snap.reset_at, now))
    )));
    if outcome.stale {
        lines.push(TooltipLine::Body(String::new()));
        lines.push(TooltipLine::Body(format!(
            " <span foreground='{}'>  ⏸  Showing cached data</span>",
            theme.orange
        )));
    }
    if let Some((code, message)) = outcome.last_error.as_ref()
        && *code != 0
    {
        lines.push(TooltipLine::Body(String::new()));
        lines.push(TooltipLine::Sep);
        lines.push(TooltipLine::Body(format!(
            " <span foreground='{}'>  HTTP {code}: {}</span>",
            theme.orange,
            escape(message)
        )));
    }
    lines.push(TooltipLine::Body(String::new()));
    lines.push(TooltipLine::Sep);
    lines.push(TooltipLine::Body(format!(
        " <span foreground='{}'>  Updated {}</span>",
        theme.dim,
        updated_at_hm(now, outcome.cache_age)
    )));
    render_bordered(&lines, theme)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::copilot::types::Quota;

    fn opts() -> RenderOpts {
        RenderOpts {
            format: None,
            tooltip_format: None,
            icon: None,
            pace_tolerance: 5,
            format_pace_color: false,
            tooltip_pace_pts: false,
        }
    }

    fn sample() -> Snapshot {
        Snapshot {
            plan: "Pro".into(),
            premium: Some(Quota {
                percent_remaining: 15.0,
                entitlement: Some(300.0),
                remaining: Some(45.0),
                unlimited: false,
                has_quota: true,
                token_based_billing: false,
            }),
            chat: None,
            completions: None,
            reset_at: None,
        }
    }

    #[test]
    fn exposes_provider_and_generic_quota_placeholders() {
        let values = build_placeholders(&sample(), Utc::now());
        assert_eq!(values["vendor_short"], "ghc");
        assert_eq!(values["copilot_premium_pct"], "85");
        assert_eq!(values["copilot_premium_used"], "255");
        assert_eq!(values["session_pct"], "85");
        assert_eq!(values["weekly_pct"], UNAVAILABLE);
    }

    /// Copilot Free has no premium-request allowance at all. Headlining that
    /// empty bucket showed a permanent 100% in a module whose colour came from
    /// `worst_pct`, so the number and the colour disagreed; VS Code shows the
    /// same account's real quotas instead.
    #[test]
    fn a_plan_without_premium_requests_headlines_its_worst_real_quota() {
        let snap = Snapshot {
            plan: "individual".into(),
            premium: Some(Quota {
                percent_remaining: 0.0,
                entitlement: Some(0.0),
                remaining: Some(0.0),
                unlimited: false,
                has_quota: true,
                token_based_billing: false,
            }),
            chat: Some(Quota {
                percent_remaining: 99.0,
                entitlement: Some(200.0),
                remaining: Some(198.0),
                unlimited: false,
                has_quota: true,
                token_based_billing: false,
            }),
            completions: Some(Quota {
                percent_remaining: 64.0,
                entitlement: Some(2000.0),
                remaining: Some(1278.0),
                unlimited: false,
                has_quota: true,
                token_based_billing: false,
            }),
            reset_at: None,
        };
        let values = build_placeholders(&snap, Utc::now());
        assert_eq!(values["copilot_pct"], "36");
        assert_eq!(values["copilot_premium_pct"], UNAVAILABLE);
        assert_eq!(values["copilot_premium_limit"], UNAVAILABLE);
        assert_eq!(values["copilot_completions_pct"], "36");
        assert_eq!(severity(&snap), PaceSeverity::Low);

        let outcome = VendorOutcome::fresh(crate::usage::VendorSnapshot::Copilot(snap.clone()));
        let output = render(&outcome, &snap, &Theme::default(), &opts(), Utc::now());
        assert!(output.text.contains("36%"));
        assert!(!output.text.contains("100%"));
        assert!(!output.tooltip.contains("Premium requests"));
    }

    #[test]
    fn renderer_headlines_the_worst_quota_and_canonical_provider_name() {
        let snap = sample();
        let outcome = VendorOutcome::fresh(crate::usage::VendorSnapshot::Copilot(snap.clone()));
        let output = render(
            &outcome,
            &snap,
            &Theme::default(),
            &opts(),
            Utc::now(),
        );
        assert!(output.text.contains("85%"));
        assert!(output.tooltip.contains("GitHub Copilot Pro"));
    }
}
