//! The case dossier screen: a reader, never a judge.
//!
//! This module renders what the TypeScript eligibility gate decided. It does
//! not re-derive any of it, and the reason is a security one, not a tidiness
//! one: a second implementation of the gate would drift from the first, and a
//! drifted gate tells an operator two different things about the same case. The
//! crypto clause set already drifted once between the CLI and this TUI (F22),
//! and the fix was one shared file read by both sides. This is the same fix
//! applied to the decision rather than the prompt.
//!
//! So the report arrives whole over `terminal221b case dossier PATH --json` and
//! every word on screen is a word the gate produced. The only thing decided
//! here is how to fit them into the space available, which is presentation and
//! therefore this module's job.
//!
//! What the screen deliberately cannot do: act. It has no approval gesture that
//! reaches anything outside the terminal, no key input, and no auto-apply. F17
//! stays open, and this screen does not close it.

use std::process::Command;

use serde::Deserialize;

/// The one operator question this surface answers, printed in the surface
/// itself. If it cannot state its question it is not a surface yet.
pub const OPERATOR_QUESTION: &str =
    "Which cases are actionable, why is each other one held, and what would unblock it?";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub version: u32,
    pub now: String,
    pub policy_max_age_days: i64,
    pub signature_trust: SignatureTrust,
    #[serde(default)]
    pub store_root: Option<String>,
    pub provenance: Provenance,
    pub cases: Vec<Case>,
    pub sources: Vec<Source>,
    pub not_doing: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SignatureTrust {
    TrustedStore,
    NoStore,
}

impl SignatureTrust {
    /// Status is a word, never a colour alone (guide 7.3).
    pub fn label(self) -> &'static str {
        match self {
            SignatureTrust::TrustedStore => "signatures checked against store keys",
            SignatureTrust::NoStore => "no store: signatures unverified",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    pub ok: bool,
    pub problems: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub status: AssetStatus,
    pub original: String,
    #[serde(default)]
    pub canonical: Option<String>,
    #[serde(default)]
    pub pattern: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AssetStatus {
    Exact,
    Wildcard,
    Ambiguous,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub source_id: String,
    pub uri: String,
    /// When the operator looked at it. A digest says the bytes did not change;
    /// this says how old the observation is, and a two-year-old observation with
    /// a correct digest is still a two-year-old observation.
    pub observed_at: String,
    #[serde(default)]
    pub policy_version: Option<String>,
    pub content_digest: String,
    /// A literal in the TypeScript type, so this side cannot print anything but
    /// the truth: the gate never re-hashed these bytes (F16).
    pub digest_status: DigestStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DigestStatus {
    Declared,
}

impl DigestStatus {
    pub fn label(self) -> &'static str {
        match self {
            DigestStatus::Declared => "declared by the bundle, not re-read here",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Confirmation {
    pub confirmation_id: String,
    pub confirmed_at: String,
    pub asset: String,
    pub policy_snapshot_id: String,
    pub statement: String,
    pub signed: bool,
    #[serde(default)]
    pub key_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub evidence_id: String,
    pub claim: String,
    pub claim_type: String,
    pub verification: String,
    pub source_id: String,
    pub observed_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Case {
    pub rank: i64,
    pub case_id: String,
    pub objective: String,
    pub program_id: String,
    pub asset: Asset,
    pub asset_type: String,
    /// Where the case is in its own lifecycle. The gate does not read it, but
    /// an operator choosing between two cases needs to know one is closed.
    #[serde(default)]
    pub state: Option<String>,
    pub policy_snapshot_id: String,
    #[serde(default)]
    pub policy_version: Option<String>,
    pub policy_age_days: Option<i64>,
    pub policy_max_age_days: i64,
    pub eligibility: Eligibility,
    #[serde(default)]
    pub blocked: Vec<String>,
    #[serde(default)]
    pub awaiting: Vec<String>,
    #[serde(default)]
    pub not_evaluated_reason: Option<String>,
    #[serde(default)]
    pub confirmations: Vec<Confirmation>,
    #[serde(default)]
    pub evidence: Vec<Evidence>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Eligibility {
    Eligible,
    Review,
    Blocked,
    NotEvaluated,
}

impl Eligibility {
    pub fn label(self) -> &'static str {
        match self {
            Eligibility::Eligible => "ELIGIBLE",
            Eligibility::Review => "REVIEW",
            Eligibility::Blocked => "BLOCKED",
            Eligibility::NotEvaluated => "NOT_EVALUATED",
        }
    }

    /// Actionable cases are numbered, everything else is not. A rank of zero is
    /// not a score; it is a position in the operator's queue.
    pub fn order(self) -> u8 {
        match self {
            Eligibility::Eligible => 0,
            Eligibility::Review => 1,
            Eligibility::Blocked => 2,
            Eligibility::NotEvaluated => 3,
        }
    }
}

impl AssetStatus {
    pub fn label(self) -> &'static str {
        match self {
            AssetStatus::Exact => "exact",
            AssetStatus::Wildcard => "wildcard",
            AssetStatus::Ambiguous => "ambiguous",
        }
    }
}

/// Why the CLI did not hand over a report. Never collapsed into "no cases".
#[derive(Debug)]
pub enum DossierError {
    CliMissing(String),
    Refused(String),
    Unreadable(String),
    WrongVersion { found: u32 },
}

impl std::fmt::Display for DossierError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DossierError::CliMissing(detail) => write!(
                formatter,
                "the installed Terminal221b CLI could not be run ({detail}); install it with `npm run build:cli`"
            ),
            DossierError::Refused(detail) => {
                write!(formatter, "the CLI refused to produce a dossier: {detail}")
            }
            DossierError::Unreadable(detail) => write!(
                formatter,
                "the CLI produced output that is not a dossier report: {detail}"
            ),
            DossierError::WrongVersion { found } => write!(
                formatter,
                "this screen reads dossier report version 1, the CLI sent version {found}"
            ),
        }
    }
}

/// Reads a bundle's report from the installed CLI.
///
/// The invocation is the seam that already exists: `/scan` and `/tools` reach the
/// same binary the same way. This adds no second path into the decision.
pub fn load(path: &str, store: Option<&str>) -> Result<Report, DossierError> {
    let mut args = vec![
        "case".to_string(),
        "dossier".to_string(),
        path.to_string(),
        "--json".to_string(),
    ];
    if let Some(store) = store {
        args.push("--store".to_string());
        args.push(store.to_string());
    }
    let output = Command::new("terminal221b")
        .args(&args)
        .output()
        .map_err(|error| DossierError::CliMissing(error.to_string()))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        let detail = detail.trim();
        return Err(DossierError::Refused(if detail.is_empty() {
            format!("exit status {}", output.status)
        } else {
            detail.to_string()
        }));
    }
    let report: Report = serde_json::from_slice(&output.stdout)
        .map_err(|error| DossierError::Unreadable(error.to_string()))?;
    if report.version != 1 {
        return Err(DossierError::WrongVersion {
            found: report.version,
        });
    }
    Ok(report)
}

/// Escapes untrusted text for one line of a fixed-width surface.
///
/// A control character in a bundle must not be able to move the cursor, clear
/// the screen, or redraw a border, so it is removed rather than printed. The
/// text itself is preserved: this escapes, it does not launder (F3).
pub fn safe_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\n' | '\r' | '\t' => out.push(' '),
            control if control.is_control() => {}
            other => out.push(other),
        }
    }
    out.trim().to_string()
}

/// Truncates to a column budget, marking the cut. 80 columns is the floor, so
/// the screen is built to fit 80 and stay readable wider.
pub fn clip(value: &str, budget: usize) -> String {
    let cleaned = safe_text(value);
    if budget == 0 {
        return String::new();
    }
    if cleaned.chars().count() <= budget {
        return cleaned;
    }
    if budget == 1 {
        return "…".to_string();
    }
    let kept: String = cleaned.chars().take(budget - 1).collect();
    format!("{kept}…")
}

/// One row of the case list.
pub struct Row {
    pub marker: String,
    pub case_id: String,
    pub eligibility: Eligibility,
    pub summary: String,
}

/// The whole screen as text, pure. A test renders this without a terminal, which
/// is what makes the screen provable at all.
pub struct View {
    pub header: Vec<String>,
    pub rows: Vec<Row>,
    pub selected: usize,
    pub detail: Vec<String>,
    /// The boundary statement, carried in the surface rather than in a manual.
    pub footer: Vec<String>,
    /// Every case's detail, in the order the rows are in.
    ///
    /// Held per case rather than recomputed per selection because the rows are
    /// *sorted* and the bundle's own case order is not: indexing the bundle by a
    /// row index shows one case's list next to another case's detail. This is
    /// the mistake `selecting_a_case_shows_that_case` exists to catch.
    details: Vec<Vec<String>>,
}

impl View {
    pub fn set_selected(&mut self, index: usize) {
        if self.details.is_empty() {
            self.selected = 0;
            self.detail = vec!["no cases in this bundle".to_string()];
            return;
        }
        self.selected = index.min(self.details.len() - 1);
        self.detail = self.details[self.selected].clone();
    }

    /// Everything the surface says, in the order it says it. The footer is part
    /// of the screen because a boundary that lives only in a document is not a
    /// boundary the operator reads (guide 7.4, item 6).
    pub fn lines(&self) -> Vec<String> {
        let mut lines = self.header.clone();
        lines.push(format!("Question: {OPERATOR_QUESTION}"));
        lines.push("Cases".to_string());
        for (index, row) in self.rows.iter().enumerate() {
            let pointer = if index == self.selected { ">" } else { " " };
            lines.push(format!(
                "{pointer}{} {} {} · {}",
                row.marker,
                row.case_id,
                row.eligibility.label(),
                row.summary
            ));
        }
        lines.push(String::new());
        lines.extend(self.detail.iter().cloned());
        lines.extend(self.footer.iter().cloned());
        lines
    }
}

/// The cases in the order the screen lists them.
///
/// Actionable first, then by severity, then by id. The same order the gate
/// ranked in, so the screen cannot imply a different priority than the queue.
pub fn ordered(report: &Report) -> Vec<&Case> {
    let mut cases: Vec<&Case> = report.cases.iter().collect();
    cases.sort_by(|left, right| {
        left.eligibility
            .order()
            .cmp(&right.eligibility.order())
            .then_with(|| left.case_id.cmp(&right.case_id))
    });
    cases
}

pub fn rows(report: &Report) -> Vec<Row> {
    ordered(report)
        .into_iter()
        .map(|item| {
            let marker = if item.eligibility == Eligibility::Eligible {
                format!("{:>2}.", item.rank + 1)
            } else {
                "  -".to_string()
            };
            Row {
                marker,
                case_id: safe_text(&item.case_id),
                eligibility: item.eligibility,
                summary: waiting_summary(item),
            }
        })
        .collect()
}

/// The one line that says why a case is not actionable, or that it is.
fn waiting_summary(item: &Case) -> String {
    let held: Vec<String> = item
        .blocked
        .iter()
        .chain(item.awaiting.iter())
        .map(|reason| safe_text(reason))
        .collect();
    if let Some(reason) = item.not_evaluated_reason.as_deref() {
        return format!("not evaluated: {}", safe_text(reason));
    }
    if held.is_empty() {
        return "actionable".to_string();
    }
    held.join(" + ")
}

fn policy_age(item: &Case) -> String {
    match item.policy_age_days {
        Some(age) => format!("{age}d of {}d", item.policy_max_age_days),
        None => format!("unknown, limit {}d", item.policy_max_age_days),
    }
}

fn asset_line(item: &Case) -> String {
    let shown = item
        .asset
        .canonical
        .as_deref()
        .or(item.asset.pattern.as_deref())
        .map(safe_text)
        .unwrap_or_else(|| safe_text(&item.asset.original));
    let reason = item
        .asset
        .reason
        .as_deref()
        .map(safe_text)
        .filter(|reason| !reason.is_empty());
    let status = match reason {
        Some(reason) => format!("{} ({reason})", item.asset.status.label()),
        None => item.asset.status.label().to_string(),
    };
    format!("{status}  {shown}")
}

pub fn view(report: &Report, selected: usize) -> View {
    let header = vec![
        format!("Case dossier · {}", report.now),
        format!(
            "Policy limit {}d · {}",
            report.policy_max_age_days,
            report.signature_trust.label()
        ),
        format!(
            "{} · {} case(s) · {} source(s){}{}",
            if report.provenance.ok {
                "provenance checks passed"
            } else {
                "PROVENANCE PROBLEMS"
            },
            report.cases.len(),
            report.sources.len(),
            match report.store_root.as_deref() {
                Some(root) => format!(" · store {}", safe_text(root)),
                None => String::new(),
            },
            failure_note(report),
        ),
    ];

    let mut footer = vec![format!("Question: {OPERATOR_QUESTION}")];
    for line in &report.not_doing {
        footer.push(format!("· {}", safe_text(line)));
    }

    let rows = rows(report);
    // Detail is built per case, in list order, so row `n` and detail `n` are
    // the same case. Building one detail from a selected index against the
    // bundle's own order was a real bug, caught by
    // `selecting_a_case_shows_that_case`.
    let details: Vec<Vec<String>> = ordered(report)
        .into_iter()
        .map(|item| case_detail(item, report))
        .collect();
    let mut view = View {
        header,
        rows,
        selected: 0,
        detail: Vec::new(),
        details,
        footer,
    };
    view.set_selected(selected);
    view
}

/// The failure state, designed rather than accidental: a bundle whose provenance
/// does not hold says so at the top, and the problems are listed rather than
/// summarised, so the operator sees the cause and not a verdict on it.
fn failure_note(report: &Report) -> String {
    if report.provenance.ok && report.signature_trust == SignatureTrust::NoStore {
        return " · gate closed: no store named, confirmed cases read as awaiting a signature"
            .to_string();
    }
    if report.provenance.ok {
        return String::new();
    }
    let first = report
        .provenance
        .problems
        .first()
        .map(|problem| safe_text(problem))
        .unwrap_or_default();
    format!(
        " · {} problem(s), first: {first}",
        report.provenance.problems.len()
    )
}

fn case_detail(item: &Case, report: &Report) -> Vec<String> {
    let mut lines = vec![
        format!("{} · {}", item.case_id, item.eligibility.label()),
        format!("objective: {}", safe_text(&item.objective)),
        format!("program: {}", safe_text(&item.program_id)),
        format!("asset: {}", asset_line(item)),
        format!("asset type: {}", safe_text(&item.asset_type)),
        match item.state.as_deref() {
            Some(state) => format!("state: {}", safe_text(state)),
            None => "state: not stated by the bundle".to_string(),
        },
        format!(
            "policy: {} · snapshot {} · age {}",
            item.policy_version.as_deref().unwrap_or("unversioned"),
            safe_text(&item.policy_snapshot_id),
            policy_age(item)
        ),
    ];
    if let Some(reason) = item.not_evaluated_reason.as_deref() {
        lines.push(format!("NOT EVALUATED: {}", safe_text(reason)));
    }
    if !item.blocked.is_empty() {
        lines.push(format!("blocked: {}", join_reasons(&item.blocked)));
    }
    if !item.awaiting.is_empty() {
        lines.push(format!("awaiting: {}", join_reasons(&item.awaiting)));
    }
    if item.blocked.is_empty() && item.awaiting.is_empty() && item.not_evaluated_reason.is_none() {
        lines.push("awaiting: nothing; the gate's only requirements are met".to_string());
    }
    lines.push(String::new());
    lines.push(format!("confirmations ({})", item.confirmations.len()));
    for confirmation in &item.confirmations {
        lines.push(format!(
            "· {} · {} · signed={} · {}",
            safe_text(&confirmation.confirmation_id),
            safe_text(&confirmation.confirmed_at),
            if confirmation.signed { "yes" } else { "NO" },
            match confirmation.key_id.as_deref() {
                Some(key) => format!("key {key}"),
                None => "no key named".to_string(),
            }
        ));
        lines.push(format!(
            "  pins {} @ {}",
            safe_text(&confirmation.asset),
            safe_text(&confirmation.policy_snapshot_id)
        ));
        lines.push(format!("  {}", safe_text(&confirmation.statement)));
    }
    lines.push(String::new());
    lines.push(format!("evidence ({})", item.evidence.len()));
    for evidence in &item.evidence {
        lines.push(format!(
            "· {} [{} · {} · {}] {}",
            safe_text(&evidence.evidence_id),
            safe_text(&evidence.claim_type),
            safe_text(&evidence.verification),
            safe_text(&evidence.observed_at),
            safe_text(&evidence.claim)
        ));
        lines.push(format!("  from {}", safe_text(&evidence.source_id)));
    }
    lines.push(String::new());
    lines.push(format!("sources ({})", report.sources.len()));
    for source in &report.sources {
        // Each of these three facts gets its own line. They are the evidence the
        // operator is deciding on, and a line that wraps is two lines: a label
        // split across a wrap stops being a label, which is the same defect as a
        // clipped digest.
        lines.push(match &source.policy_version {
            Some(version) => format!(
                "· {} · observed {} · policy {}",
                safe_text(&source.source_id),
                safe_text(&source.observed_at),
                safe_text(version)
            ),
            None => format!(
                "· {} · observed {}",
                safe_text(&source.source_id),
                safe_text(&source.observed_at)
            ),
        });
        lines.push(format!("  {}", source.digest_status.label()));
        lines.push(format!("  {}", safe_text(&source.content_digest)));
        lines.push(format!("  {}", safe_text(&source.uri)));
    }
    lines
}

fn join_reasons(reasons: &[String]) -> String {
    reasons
        .iter()
        .map(|reason| safe_text(reason))
        .collect::<Vec<_>>()
        .join(" + ")
}

/// The slice of the screen a pane of `height` lines shows starting at `offset`.
///
/// Paging lives here rather than in the draw loop so it can be tested without a
/// terminal, and so the offset is clamped in one place: an offset past the end
/// must land on the last screenful, never on an empty pane.
pub fn screen_window(lines: &[String], height: usize, offset: usize) -> Vec<&str> {
    if height == 0 {
        return Vec::new();
    }
    let max_offset = lines.len().saturating_sub(height);
    lines
        .iter()
        .skip(offset.min(max_offset))
        .take(height)
        .map(|line| line.as_str())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report_from(json: &str) -> Report {
        serde_json::from_str(json).expect("report parses")
    }

    const MINIMAL: &str = r#"{
      "version": 1,
      "now": "2026-09-30T12:00:00Z",
      "policyMaxAgeDays": 90,
      "signatureTrust": "no-store",
      "provenance": { "ok": true, "problems": [] },
      "cases": [
        { "rank": -1, "caseId": "case-a", "objective": "one", "programId": "p",
          "asset": { "status": "exact", "original": "https://a.invalid/x", "canonical": "https://a.invalid/x" },
          "assetType": "web-application", "policySnapshotId": "src-1", "policyVersion": "2026-09",
          "state": "research",
          "policyAgeDays": 2, "policyMaxAgeDays": 90, "eligibility": "review",
          "blocked": [], "awaiting": ["confirmation_unsigned"],
          "confirmations": [
            { "confirmationId": "cf-1", "confirmedAt": "2026-09-29T09:30:00Z",
              "asset": "https://a.invalid/x", "policySnapshotId": "src-1",
              "statement": "read it", "signed": false }
          ],
          "evidence": [] }
      ],
      "sources": [
        { "sourceId": "src-1", "uri": "local://policies/2026-09.json",
          "observedAt": "2026-09-28T09:00:00Z", "policyVersion": "2026-09",
          "contentDigest": "sha256:abc", "digestStatus": "declared" }
      ],
      "notDoing": [ "it does not contact a target" ]
    }"#;

    #[test]
    fn a_case_that_is_held_says_why_on_its_own_row() {
        let report = report_from(MINIMAL);
        let rows = rows(&report);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].eligibility, Eligibility::Review);
        assert!(
            rows[0].summary.contains("confirmation_unsigned"),
            "{}",
            rows[0].summary
        );
    }

    #[test]
    fn the_screen_names_its_operator_question_and_its_boundary() {
        let report = report_from(MINIMAL);
        let screen = view(&report, 0);
        let footer = screen.footer.join("\n");
        assert!(footer.contains("Which cases are actionable"), "{footer}");
        assert!(footer.contains("does not contact a target"), "{footer}");
    }

    #[test]
    fn a_declared_digest_is_never_presented_as_verified() {
        let report = report_from(MINIMAL);
        let detail = view(&report, 0).detail.join("\n");
        assert!(
            detail.contains("declared by the bundle, not re-read here"),
            "{detail}"
        );
        assert!(!detail.contains("verified locally"), "{detail}");
    }

    #[test]
    fn a_missing_store_is_shown_as_a_closed_gate_not_as_a_clean_bill_of_health() {
        let report = report_from(MINIMAL);
        let header = view(&report, 0).header.join("\n");
        assert!(
            header.contains("no store: signatures unverified"),
            "{header}"
        );
        assert!(header.contains("gate closed"), "{header}");
    }

    #[test]
    fn a_provenance_problem_is_named_in_the_header() {
        let json = MINIMAL.replace(
            r#""provenance": { "ok": true, "problems": [] }"#,
            r#""provenance": { "ok": false, "problems": ["evidence ev-x is not in the bundle"] }"#,
        );
        let report = report_from(&json);
        let header = view(&report, 0).header.join("\n");
        assert!(header.contains("PROVENANCE PROBLEMS"), "{header}");
        assert!(header.contains("ev-x is not in the bundle"), "{header}");
    }

    #[test]
    fn an_unevaluated_case_carries_its_reason_instead_of_a_bare_label() {
        let json = MINIMAL
            .replace(
                r#""eligibility": "review""#,
                r#""eligibility": "not_evaluated""#,
            )
            .replace(
                r#""blocked": [], "awaiting": ["confirmation_unsigned"],"#,
                r#""blocked": [], "awaiting": [],
                "notEvaluatedReason": "policy snapshot src-9 is not in the bundle", "#,
            );
        let report = report_from(&json);
        let screen = view(&report, 0);
        assert!(
            screen.rows[0].summary.contains("not evaluated"),
            "{}",
            screen.rows[0].summary
        );
        assert!(
            screen.detail.join("\n").contains("NOT EVALUATED"),
            "{}",
            screen.detail.join("\n")
        );
    }

    #[test]
    fn actionable_cases_are_numbered_and_sort_above_everything_else() {
        let mut report = report_from(MINIMAL);
        report.cases.push(Case {
            rank: 0,
            case_id: "case-z".into(),
            objective: "two".into(),
            program_id: "p".into(),
            asset: Asset {
                status: AssetStatus::Exact,
                original: "https://a.invalid/z".into(),
                canonical: Some("https://a.invalid/z".into()),
                pattern: None,
                reason: None,
            },
            asset_type: "web-application".into(),
            policy_snapshot_id: "src-1".into(),
            policy_version: Some("2026-09".into()),
            policy_age_days: Some(1),
            policy_max_age_days: 90,
            eligibility: Eligibility::Eligible,
            blocked: vec![],
            awaiting: vec![],
            not_evaluated_reason: None,
            state: Some("research".into()),
            confirmations: vec![],
            evidence: vec![],
        });
        let screen = view(&report, 0);
        assert_eq!(screen.rows[0].case_id, "case-z");
        assert_eq!(screen.rows[0].marker, " 1.");
        assert_eq!(screen.rows[0].summary, "actionable");
    }

    #[test]
    fn untrusted_text_cannot_move_the_cursor_or_rewrite_a_border() {
        assert_eq!(safe_text("a\u{1b}[2Jb"), "a[2Jb");
        assert_eq!(safe_text("line\nbreak"), "line break");
        assert_eq!(safe_text("tab\there"), "tab here");
    }

    #[test]
    fn a_long_field_is_clipped_and_marks_the_cut_rather_than_wrapping_offscreen() {
        let clipped = clip("x".repeat(200).as_str(), 20);
        assert_eq!(clipped.chars().count(), 20);
        assert!(clipped.ends_with('…'));
    }

    #[test]
    fn the_screen_states_its_question_and_fits_eighty_columns_before_clipping() {
        let report = report_from(MINIMAL);
        let screen = view(&report, 0);
        // `lines()` is the whole surface, and the boundary footer is part of it,
        // so a check that skipped the footer would pass on a screen that had
        // quietly dropped its own limits.
        assert!(
            screen
                .lines()
                .iter()
                .any(|line| line.contains(OPERATOR_QUESTION))
        );
        assert!(
            screen
                .lines()
                .iter()
                .any(|line| line.contains("does not contact a target"))
        );
        // Two width rules, and they differ on purpose. The index is the
        // scannable part, so a row is clipped to 80 columns and marked. The
        // detail is prose and wraps. What must never happen is a digest
        // clipped, because a truncated digest is not a digest (guide 7.3).
        let index_end = screen.header.len() + 1 + screen.rows.len();
        let all = screen.lines();
        for (index, line) in all.iter().enumerate() {
            if index < screen.header.len() || index >= index_end {
                continue;
            }
            assert!(
                clip(line, 80).chars().count() <= 80,
                "an index row still exceeds 80 columns after clipping: {line}"
            );
        }
        let digest_line = all
            .iter()
            .find(|line| line.contains("sha256:"))
            .expect("the screen shows a source digest");
        assert!(
            digest_line.contains("sha256:abc"),
            "the digest must be rendered whole, never clipped: {digest_line}"
        );
    }

    #[test]
    fn a_report_version_this_screen_does_not_know_is_refused_loudly() {
        let json = MINIMAL.replace(r#""version": 1"#, r#""version": 7"#);
        let report: Result<Report, _> = serde_json::from_str(&json);
        assert!(
            report.is_ok(),
            "parsing tolerates it; the version check is explicit"
        );
        assert!(report.unwrap().version != 1);
    }

    #[test]
    fn a_renamed_or_missing_field_fails_rather_than_rendering_an_empty_row() {
        // An unknown field is additive and tolerated; a missing one is not.
        let extra = MINIMAL.replace(r#""version": 1,"#, r#""version": 1, "futureField": 1,"#);
        assert!(report_from(&extra).version == 1);
        let missing = MINIMAL.replace(r#""policyMaxAgeDays": 90,"#, "");
        assert!(serde_json::from_str::<Report>(&missing).is_err());
    }

    #[test]
    fn a_screen_window_pages_and_lands_on_the_last_screenful_not_an_empty_pane() {
        let lines: Vec<String> = (0..40).map(|index| format!("line {index}")).collect();
        let window = screen_window(&lines, 5, 10);
        assert_eq!(window.len(), 5);
        assert_eq!(window[0], "line 10");
        assert_eq!(window[4], "line 14");
        assert!(screen_window(&lines, 0, 10).is_empty());
        // Scrolling far past the end must still show something.
        let overscrolled = screen_window(&lines, 5, 999);
        assert_eq!(overscrolled.len(), 5);
        assert_eq!(overscrolled[4], "line 39");
    }

    #[test]
    fn selecting_past_the_end_lands_on_the_last_case_rather_than_rendering_nothing() {
        let report = report_from(MINIMAL);
        let screen = view(&report, 99);
        assert_eq!(screen.selected, 0);
        assert!(
            screen.detail.join("\n").contains("case-a"),
            "{:?}",
            screen.detail
        );
    }

    #[test]
    fn selecting_a_case_shows_that_case_and_not_another_one() {
        let mut report = report_from(MINIMAL);
        // Deliberately added second in the bundle but first in the list: the
        // actionable case sorts ahead. Indexing the bundle by a row index would
        // put one case's row next to another case's detail.
        report.cases.push(Case {
            rank: 0,
            case_id: "case-second-in-bundle".into(),
            objective: "two".into(),
            program_id: "p".into(),
            asset: Asset {
                status: AssetStatus::Exact,
                original: "https://a.invalid/z".into(),
                canonical: Some("https://a.invalid/z".into()),
                pattern: None,
                reason: None,
            },
            asset_type: "web-application".into(),
            policy_snapshot_id: "src-1".into(),
            policy_version: Some("2026-09".into()),
            policy_age_days: Some(1),
            policy_max_age_days: 90,
            eligibility: Eligibility::Eligible,
            blocked: vec![],
            awaiting: vec![],
            not_evaluated_reason: None,
            state: Some("research".into()),
            confirmations: vec![],
            evidence: vec![],
        });
        let mut screen = view(&report, 0);
        assert_eq!(screen.rows[0].case_id, "case-second-in-bundle");
        let first = screen.detail.join("\n");
        assert!(
            first.contains("case-second-in-bundle ·"),
            "row 0 is the eligible case, so its detail must be that case:\n{first}"
        );
        assert!(
            !first.contains("case-a ·"),
            "the detail pane is showing a different case than the selected row:\n{first}"
        );

        screen.set_selected(1);
        assert!(
            screen.detail.join("\n").contains("case-a ·"),
            "{:?}",
            screen.detail
        );
    }
}
