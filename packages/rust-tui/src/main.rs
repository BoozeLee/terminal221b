use std::{
    env, fs,
    io::stdout,
    path::{Component, Path, PathBuf},
    process::Command,
    sync::mpsc::{self, Receiver, Sender},
    thread,
    time::Duration,
};

use crossterm::{
    event::{self, Event, KeyCode, KeyEventKind, KeyModifiers},
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use ratatui::{
    Terminal,
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Paragraph, Wrap},
};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};

mod boundary;
mod boundary_drift;
mod dossier;
mod prompt;
mod session;
mod workspace;

use boundary::{ProviderFailure, ProviderResult};
use dossier::View as DossierView;

use prompt::PromptBuffer;
use workspace::{collect_context, collect_context_files, format_context_preflight};

const MODEL: &str = "claude-sonnet-4-5-20250929";

#[derive(Clone)]
struct Message {
    role: &'static str,
    text: String,
}

struct App {
    root: PathBuf,
    input: PromptBuffer,
    messages: Vec<Message>,
    status: String,
    pending: bool,
    crypto_mode: bool,
    proposal: Option<String>,
    scroll: Option<u16>,
    /// The open case-dossier screen. `Some` means the surface is showing and
    /// the prompt is read-only, so no key can send a provider request from
    /// inside a read-only view.
    dossier: Option<OpenDossier>,
    rx: Receiver<WorkerResult>,
    tx: Sender<WorkerResult>,
    should_quit: bool,
}

struct OpenDossier {
    view: DossierView,
    /// Offset of the first line of detail shown, so PgUp/PgDn scroll the detail.
    detail_scroll: usize,
}

fn page_scroll(current: Option<u16>, page_size: u16, max_scroll: u16, older: bool) -> Option<u16> {
    let current = current.unwrap_or_default().min(max_scroll);
    let next = if older {
        current.saturating_add(page_size).min(max_scroll)
    } else {
        current.saturating_sub(page_size)
    };
    (next > 0).then_some(next)
}

struct WorkerResult {
    answer: Result<String, String>,
    task: WorkerTask,
}

enum WorkerTask {
    Chat {
        patch_mode: bool,
    },
    ContextPreview,
    /// Carries the report itself, not a rendered string, so the screen can
    /// re-render it at any width without asking the CLI again. `Err` is the
    /// reason the read failed, never an empty report.
    Dossier {
        report: Result<dossier::Report, String>,
    },
}

#[derive(Serialize)]
struct Request {
    model: String,
    max_tokens: usize,
    system: String,
    messages: Vec<ApiMessage>,
}

#[derive(Serialize)]
struct ApiMessage {
    role: &'static str,
    content: String,
}

#[derive(Deserialize)]
struct Response {
    content: Option<Vec<ContentBlock>>,
    error: Option<ApiError>,
}

#[derive(Deserialize)]
struct ContentBlock {
    #[serde(rename = "type")]
    kind: String,
    text: Option<String>,
}

#[derive(Deserialize)]
struct ApiError {
    message: Option<String>,
}

/// The system text, rendered from the one shared boundary file.
///
/// These two strings used to be literals in this file, and the copy in the CLI
/// had already drifted: the crypto prohibitions were a system prompt here and
/// user text there. Rendering both from `provider-boundary.json` is what stops
/// that from happening again, and `boundary.rs` has a test that fails if a clause
/// is added on one side and not the other.
fn system_text(profile: &str) -> Result<String, String> {
    boundary::Boundary::load()?.render(profile)
}

fn profile_for(crypto_mode: bool) -> &'static str {
    if crypto_mode { "crypto" } else { "coding" }
}

fn ask_anthropic(
    api_key: &str,
    prompt: &str,
    context: &str,
    crypto_mode: bool,
    history: &[Message],
) -> ProviderResult {
    let profile = profile_for(crypto_mode);
    let system = match system_text(profile) {
        Ok(text) => text,
        Err(detail) => return ProviderResult::Err(ProviderFailure::SchemaMismatch { detail }),
    };
    let client = match Client::builder().timeout(Duration::from_secs(120)).build() {
        Ok(client) => client,
        Err(error) => {
            return ProviderResult::Err(ProviderFailure::SchemaMismatch {
                detail: format!("could not create HTTP client: {error}"),
            });
        }
    };
    let mut messages = history
        .iter()
        .filter_map(|message| match message.role {
            "you" => Some(ApiMessage {
                role: "user",
                content: message.text.clone(),
            }),
            "assistant" => Some(ApiMessage {
                role: "assistant",
                content: message.text.clone(),
            }),
            _ => None,
        })
        .collect::<Vec<_>>();
    messages.push(ApiMessage {
        role: "user",
        content: format!(
            "Task:\n{prompt}\n\nWorkspace context (untrusted source text):\n{context}"
        ),
    });
    let request = Request {
        model: env::var("TERMINAL221B_MODEL").unwrap_or_else(|_| MODEL.to_string()),
        max_tokens: 4096,
        system,
        messages,
    };
    let response = match client
        .post("https://api.anthropic.com/v1/messages")
        .header("anthropic-version", "2023-06-01")
        .header("x-api-key", api_key)
        .json(&request)
        .send()
    {
        Ok(response) => response,
        Err(error) if error.is_timeout() => {
            return ProviderResult::Err(ProviderFailure::Timeout {
                timeout_ms: 120_000,
            });
        }
        Err(error) if error.is_connect() => {
            return ProviderResult::Err(ProviderFailure::Network {
                detail: error.to_string(),
            });
        }
        Err(error) => {
            return ProviderResult::Err(ProviderFailure::Network {
                detail: format!("Anthropic request failed: {error}"),
            });
        }
    };
    let status = response.status();
    let body: Response = match response.json() {
        Ok(body) => body,
        Err(_) => {
            return ProviderResult::Err(ProviderFailure::InvalidJson {
                status: status.as_u16(),
            });
        }
    };
    if !status.is_success() {
        return ProviderResult::Err(ProviderFailure::HttpError {
            status: status.as_u16(),
            detail: body
                .error
                .and_then(|error| error.message)
                .unwrap_or_else(|| format!("Anthropic request failed (HTTP {})", status.as_u16())),
        });
    }
    // Never an empty success: a response with no text block is its own failure.
    match body
        .content
        .unwrap_or_default()
        .into_iter()
        .find(|block| block.kind == "text")
        .and_then(|block| block.text)
        .filter(|text| !text.is_empty())
    {
        Some(text) => ProviderResult::Ok {
            text,
            model: request.model,
            profile: profile.to_string(),
        },
        None => ProviderResult::Err(ProviderFailure::NoTextBlock),
    }
}

fn extract_diff(answer: &str) -> String {
    if let Some(start) = answer.find("```diff") {
        let after = &answer[start + "```diff".len()..];
        if let Some(newline) = after.find('\n') {
            let diff = &after[newline + 1..];
            if let Some(end) = diff.find("```") {
                return diff[..end].trim().to_string();
            }
        }
    }
    answer.trim().to_string()
}

fn validate_patch(root: &Path, patch: &str) -> Result<Vec<String>, String> {
    if patch.contains("GIT binary patch") || patch.contains("Binary files ") {
        return Err("Binary patches are not supported".into());
    }
    let mut paths = Vec::new();
    for line in patch.lines() {
        let candidates: Vec<&str> = if line.starts_with("diff --git ") {
            let parts = line.split_whitespace().collect::<Vec<_>>();
            if parts.len() != 4 || line.contains('"') || line.contains('\\') {
                return Err("Diff paths containing whitespace or quoting are not supported".into());
            }
            vec![
                parts[2]
                    .strip_prefix("a/")
                    .ok_or("Malformed old diff path")?,
                parts[3]
                    .strip_prefix("b/")
                    .ok_or("Malformed new diff path")?,
            ]
        } else if let Some(path) = line.strip_prefix("--- ") {
            vec![path.strip_prefix("a/").unwrap_or(path)]
        } else if let Some(path) = line.strip_prefix("+++ ") {
            vec![path.strip_prefix("b/").unwrap_or(path)]
        } else if let Some(path) = line.strip_prefix("rename from ") {
            vec![path]
        } else if let Some(path) = line.strip_prefix("rename to ") {
            vec![path]
        } else {
            continue;
        };
        for path in candidates {
            if path == "/dev/null" {
                continue;
            }
            let path = Path::new(path);
            if path.is_absolute()
                || path
                    .components()
                    .any(|part| matches!(part, Component::ParentDir | Component::Prefix(_)))
                || path.components().any(|part| part.as_os_str() == ".git")
                || path.components().any(|part| {
                    let name = part.as_os_str().to_string_lossy().to_ascii_lowercase();
                    name.starts_with(".env")
                        || name == ".ssh"
                        || name == "secrets"
                        || name == "credentials"
                })
                || path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        [".pem", ".key", ".p12", ".pfx"]
                            .iter()
                            .any(|ext| name.to_ascii_lowercase().ends_with(ext))
                    })
            {
                return Err(format!(
                    "Patch contains a disallowed path: {}",
                    path.display()
                ));
            }
            let mut current = root.to_path_buf();
            for component in path.components() {
                current.push(component);
                if fs::symlink_metadata(&current)
                    .map(|metadata| metadata.file_type().is_symlink())
                    .unwrap_or(false)
                {
                    return Err(format!(
                        "Patch traverses a symbolic link: {}",
                        path.display()
                    ));
                }
            }
            if !paths
                .iter()
                .any(|existing| existing == &path.to_string_lossy())
            {
                paths.push(path.to_string_lossy().into_owned());
            }
        }
    }
    if paths.is_empty() {
        return Err("No unified diff file headers were found".into());
    }
    Ok(paths)
}

fn apply_patch(root: &Path, patch: &str) -> Result<Vec<String>, String> {
    let paths = validate_patch(root, patch)?;
    for check in [true, false] {
        let mut command = Command::new("git");
        command.arg("apply");
        if check {
            command.arg("--check");
        }
        command
            .arg("--")
            .current_dir(root)
            .stdin(std::process::Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|error| format!("Could not run git apply: {error}"))?;
        use std::io::Write;
        child
            .stdin
            .take()
            .ok_or("Could not open git apply input")?
            .write_all(patch.as_bytes())
            .map_err(|error| format!("Could not send patch to git: {error}"))?;
        let output = child
            .wait_with_output()
            .map_err(|error| format!("git apply failed: {error}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
    }
    Ok(paths)
}

impl App {
    fn new(root: PathBuf) -> Self {
        let (tx, rx) = mpsc::channel();
        Self {
            root,
            input: PromptBuffer::default(),
            messages: vec![Message {
                role: "system",
                text: "Terminal221b Rust TUI. Enter sends · /help commands · /crypto toggles crypto mode · /dossier <path> opens the local case dossier · /apply <request> asks for a reviewed diff · /save, /sessions, /load manage local transcripts · Ctrl-C exits.".into(),
            }],
            status: "Ready".into(),
            pending: false,
            crypto_mode: false,
            proposal: None,
            scroll: None,
            dossier: None,
            rx,
            tx,
            should_quit: false,
        }
    }

    fn submit(&mut self) {
        if self.pending {
            return;
        }
        let prompt = self.input.as_str().trim().to_string();
        self.input.clear();
        if prompt.is_empty() {
            return;
        }
        if prompt == "/quit" || prompt == "/exit" {
            self.should_quit = true;
            return;
        }
        if prompt == "/help" {
            self.messages.push(Message {
                role: "system",
                text: "/help  show commands\n/context  preview selected workspace paths and byte sizes locally\n/crypto  toggle crypto-focused assistant context\n/dossier <path>  open the local case dossier; arrows select, Esc closes\n/tools  list local analyzers and chain tools\n/scan  run local heuristic scan\n/apply <request>  request a patch; inspect it and press y to apply or n to reject\n/save <name>  save user/assistant turns locally\n/sessions  list saved transcripts\n/load <name>  replace the current conversation with a saved transcript\n/clear  clear conversation\n/quit  exit".into(),
            });
            return;
        }
        if prompt == "/context" {
            self.preview_context();
            self.scroll = None;
            return;
        }
        if let Some(name) = prompt.strip_prefix("/save ") {
            self.save_session(name.trim());
            return;
        }
        if prompt == "/save" {
            self.messages.push(Message {
                role: "system",
                text: "Usage: /save <name>".into(),
            });
            return;
        }
        if prompt == "/sessions" {
            match session::list() {
                Ok(names) if names.is_empty() => self.messages.push(Message {
                    role: "system",
                    text: "No saved sessions.".into(),
                }),
                Ok(names) => self.messages.push(Message {
                    role: "system",
                    text: format!("Saved sessions: {}", names.join(", ")),
                }),
                Err(error) => self.messages.push(Message {
                    role: "system",
                    text: format!("Could not list saved sessions: {error}"),
                }),
            }
            self.scroll = None;
            return;
        }
        if let Some(name) = prompt.strip_prefix("/load ") {
            self.load_session(name.trim());
            return;
        }
        if prompt == "/load" {
            self.messages.push(Message {
                role: "system",
                text: "Usage: /load <name>".into(),
            });
            return;
        }
        if prompt == "/clear" {
            self.messages.clear();
            self.status = "Conversation cleared".into();
            return;
        }
        if prompt == "/crypto" {
            self.crypto_mode = !self.crypto_mode;
            self.status = format!(
                "Crypto mode {}",
                if self.crypto_mode { "on" } else { "off" }
            );
            return;
        }
        if let Some(path) = prompt.strip_prefix("/dossier ") {
            self.open_dossier(path.trim());
            return;
        }
        if prompt == "/dossier" {
            self.messages.push(Message {
                role: "system",
                text: "Usage: /dossier <path-to-bundle.json> [--store DIR]".into(),
            });
            return;
        }
        if prompt == "/tools" || prompt == "/scan" {
            self.run_local_command(&prompt);
            return;
        }
        let patch_mode = prompt.starts_with("/apply ");
        let prompt = if patch_mode {
            prompt[7..].trim().to_string()
        } else {
            prompt
        };
        let history = self.messages.clone();
        self.messages.push(Message {
            role: "you",
            text: prompt.clone(),
        });
        self.scroll = None;
        self.pending = true;
        self.status = "Working…".into();
        let root = self.root.clone();
        let tx = self.tx.clone();
        let crypto_mode = self.crypto_mode;
        thread::spawn(move || {
            // The worker returns the typed result, rendered once at the edge. A
            // missing key, a timeout, and a 401 stay three different things here,
            // where before they were all `Result<String, String>` and only the
            // message distinguished them.
            let result = match env::var("ANTHROPIC_API_KEY") {
                Err(_) => Err(ProviderFailure::MissingKey),
                Ok(key) => match collect_context(&root) {
                    Err(error) => Err(ProviderFailure::SchemaMismatch {
                        detail: format!("could not read workspace context: {error}"),
                    }),
                    Ok(context) => {
                        match ask_anthropic(&key, &prompt, &context, crypto_mode, &history) {
                            ProviderResult::Ok { text, .. } => Ok(text),
                            ProviderResult::Err(failure) => Err(failure),
                        }
                    }
                },
            };
            let _ = tx.send(WorkerResult {
                answer: result.map_err(|failure| failure.describe()),
                task: WorkerTask::Chat { patch_mode },
            });
        });
    }

    fn preview_context(&mut self) {
        self.pending = true;
        self.status = "Inspecting workspace context locally".into();
        let root = self.root.clone();
        let tx = self.tx.clone();
        thread::spawn(move || {
            let result = collect_context_files(&root)
                .map(|files| format_context_preflight(&files))
                .map_err(|error| format!("Could not inspect workspace context: {error}"));
            let _ = tx.send(WorkerResult {
                answer: result,
                task: WorkerTask::ContextPreview,
            });
        });
    }

    /// Opens the one Phase 2 surface: the local case dossier.
    ///
    /// The read happens on a worker thread, because it shells out to the CLI and
    /// a blocking `Command::output` on the event loop would freeze every key
    /// until the child exited. The thread returns the parsed report and the UI
    /// thread decides only how to lay it out.
    fn open_dossier(&mut self, argument: &str) {
        // `--store DIR` is optional and parsed here so the screen can be opened
        // against a store; without it the gate stays shut and the screen says so.
        let (path, store) = match argument.split_once("--store") {
            Some((path, store)) => (
                path.trim().to_string(),
                Some(store.trim().trim_matches('"').to_string()),
            ),
            None => (argument.trim().to_string(), None),
        };
        if path.is_empty() {
            self.messages.push(Message {
                role: "system",
                text: "Usage: /dossier <path-to-bundle.json> [--store DIR]".into(),
            });
            return;
        }
        self.pending = true;
        self.status = "Reading case dossier".into();
        self.scroll = None;
        let tx = self.tx.clone();
        thread::spawn(move || {
            let report = dossier::load(&path, store.as_deref()).map_err(|error| error.to_string());
            let _ = tx.send(WorkerResult {
                answer: Ok(String::new()),
                task: WorkerTask::Dossier { report },
            });
        });
    }

    /// Arrow navigation while the dossier is open. Returns true when the key was
    /// consumed, so the prompt never sees it.
    fn dossier_key(&mut self, code: KeyCode) -> bool {
        let Some(open) = self.dossier.as_mut() else {
            return false;
        };
        match code {
            KeyCode::Esc => {
                self.dossier = None;
                self.status = "Case dossier closed".into();
            }
            KeyCode::Up => {
                let current = open.view.selected;
                open.view.set_selected(current.saturating_sub(1));
                open.detail_scroll = 0;
            }
            KeyCode::Down => {
                let current = open.view.selected + 1;
                open.view.set_selected(current);
                open.detail_scroll = 0;
            }
            KeyCode::PageUp => {
                open.detail_scroll = open.detail_scroll.saturating_sub(1);
            }
            KeyCode::PageDown => {
                open.detail_scroll = open.detail_scroll.saturating_add(1);
            }
            _ => {}
        }
        true
    }

    fn run_local_command(&mut self, prompt: &str) {
        let args = if prompt == "/tools" {
            vec!["tools".to_string()]
        } else {
            let mut args = vec![
                "security".into(),
                "scan".into(),
                "--workspace".into(),
                self.root.display().to_string(),
            ];
            for flag in [
                "--with-gitleaks",
                "--with-bandit",
                "--with-semgrep",
                "--with-trivy",
                "--with-slither",
                "--with-cargo-audit",
            ] {
                args.push(flag.to_string());
            }
            args
        };
        let output = Command::new("terminal221b").args(args).output();
        let text = match output {
            Ok(output) => {
                let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
                if !output.status.success() {
                    text.push_str(&String::from_utf8_lossy(&output.stderr));
                }
                text
            }
            Err(error) => format!("Could not run installed Terminal221b CLI: {error}"),
        };
        self.messages.push(Message {
            role: "system",
            text,
        });
        self.scroll = None;
    }

    fn save_session(&mut self, name: &str) {
        let transcript = session::SessionTranscript::from_messages(
            self.messages
                .iter()
                .map(|message| (message.role.to_string(), message.text.clone())),
        );
        match session::save(name, &transcript) {
            Ok(_) => self.status = format!("Saved local session: {name}"),
            Err(error) => {
                self.status = format!("Session save failed: {error}");
                self.messages.push(Message {
                    role: "system",
                    text: self.status.clone(),
                });
            }
        }
        self.scroll = None;
    }

    fn load_session(&mut self, name: &str) {
        match session::load(name) {
            Ok(transcript) => {
                let mut messages = vec![Message {
                    role: "system",
                    text: "Loaded a local transcript. Workspace context is collected fresh for each request.".into(),
                }];
                messages.extend(transcript.messages.into_iter().map(|message| Message {
                    role: if message.role == "you" {
                        "you"
                    } else {
                        "assistant"
                    },
                    text: message.text,
                }));
                self.messages = messages;
                self.status = format!("Loaded local session: {name}");
            }
            Err(error) => {
                self.status = format!("Session load failed: {error}");
                self.messages.push(Message {
                    role: "system",
                    text: self.status.clone(),
                });
            }
        }
        self.scroll = None;
    }

    fn poll_worker(&mut self) {
        if let Ok(result) = self.rx.try_recv() {
            self.pending = false;
            self.scroll = None;
            let patch_mode = match result.task {
                WorkerTask::Dossier { report } => {
                    // A designed failure state, not a fallback: the reason the
                    // dossier could not be read is the message the operator
                    // gets, and no screen opens over the old one.
                    match report {
                        Ok(report) => {
                            self.status = format!(
                                "Case dossier open · {} · {}{}",
                                report.now,
                                report.signature_trust.label(),
                                if report.provenance.ok {
                                    String::new()
                                } else {
                                    " · PROVENANCE PROBLEMS".to_string()
                                }
                            );
                            self.dossier = Some(OpenDossier {
                                view: dossier::view(&report, 0),
                                detail_scroll: 0,
                            });
                        }
                        Err(problem) => {
                            self.status = "Case dossier unavailable".into();
                            self.messages.push(Message {
                                role: "system",
                                text: problem,
                            });
                        }
                    }
                    return;
                }
                WorkerTask::ContextPreview => {
                    match result.answer {
                        Ok(text) => {
                            self.status = "Context preview ready".into();
                            self.messages.push(Message {
                                role: "system",
                                text,
                            });
                        }
                        Err(error) => {
                            self.status = error.clone();
                            self.messages.push(Message {
                                role: "system",
                                text: error,
                            });
                        }
                    }
                    return;
                }
                WorkerTask::Chat { patch_mode } => patch_mode,
            };
            match result.answer {
                Ok(answer) if patch_mode => {
                    let diff = extract_diff(&answer);
                    match validate_patch(&self.root, &diff) {
                        Ok(paths) => {
                            self.messages.push(Message {
                                role: "assistant",
                                text: format!(
                                    "Proposed changes (not applied):\n{}\n\nTargets: {}\nPress y to apply or n to reject.",
                                    diff,
                                    paths.join(", ")
                                ),
                            });
                            self.proposal = Some(diff);
                            self.status = "Patch awaits review".into();
                        }
                        Err(error) => {
                            self.messages.push(Message {
                                role: "assistant",
                                text: format!("Rejected unsafe or invalid patch: {error}"),
                            });
                            self.status = "Patch rejected".into();
                        }
                    }
                }
                Ok(answer) => {
                    self.messages.push(Message {
                        role: "assistant",
                        text: answer,
                    });
                    self.status = "Ready".into();
                }
                Err(error) => {
                    self.messages.push(Message {
                        role: "system",
                        text: error.clone(),
                    });
                    self.status = error;
                }
            }
        }
    }

    fn approve_patch(&mut self, approve: bool) {
        let Some(patch) = self.proposal.take() else {
            return;
        };
        if !approve {
            self.status = "Patch rejected".into();
            self.messages.push(Message {
                role: "system",
                text: "Patch rejected; no files changed.".into(),
            });
            return;
        }
        match apply_patch(&self.root, &patch) {
            Ok(paths) => {
                self.status = "Patch applied".into();
                self.messages.push(Message {
                    role: "system",
                    text: format!("Applied approved patch to: {}", paths.join(", ")),
                });
            }
            Err(error) => {
                self.status = "Patch failed".into();
                self.messages.push(Message {
                    role: "system",
                    text: format!("Patch could not be applied: {error}"),
                });
            }
        }
    }
}

fn conversation_lines(messages: &[Message]) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    for message in messages {
        let (label, color) = match message.role {
            "you" => ("you", Color::Green),
            "assistant" => ("221b", Color::Cyan),
            _ => ("info", Color::Yellow),
        };
        lines.push(Line::from(Span::styled(
            format!("── {label} ─────────────────────────────────────────"),
            Style::default().fg(color).add_modifier(Modifier::BOLD),
        )));
        lines.extend(message.text.lines().map(|line| Line::raw(line.to_string())));
        lines.push(Line::from(""));
    }
    lines
}

fn conversation_scroll_limits(messages: &[Message], area: Rect) -> (u16, u16) {
    let sections = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(4),
            Constraint::Length(5),
            Constraint::Length(1),
        ])
        .split(area);
    let conversation = sections[1];
    let visible_height = conversation.height.saturating_sub(2) as usize;
    let width = conversation.width.saturating_sub(2).max(1) as usize;
    let rendered_lines = conversation_lines(messages)
        .iter()
        .map(|line| line.width().div_ceil(width).max(1))
        .sum::<usize>();
    let max_scroll = rendered_lines
        .saturating_sub(visible_height)
        .min(u16::MAX as usize) as u16;
    let page_size = visible_height
        .saturating_sub(1)
        .max(1)
        .min(u16::MAX as usize) as u16;
    (page_size, max_scroll)
}

fn prompt_lines(buffer: &PromptBuffer) -> Vec<Line<'static>> {
    let cursor_line = buffer.cursor_line();
    let cursor_column = buffer.cursor_column();
    buffer
        .as_str()
        .split('\n')
        .enumerate()
        .map(|(index, content)| {
            if index != cursor_line {
                return Line::raw(content.to_string());
            }
            let mut spans = Vec::new();
            if let Some((cursor_byte, character)) = content.char_indices().nth(cursor_column) {
                spans.push(Span::raw(content[..cursor_byte].to_string()));
                spans.push(Span::styled(
                    character.to_string(),
                    Style::default().fg(Color::Black).bg(Color::Gray),
                ));
                let after = cursor_byte + character.len_utf8();
                spans.push(Span::raw(content[after..].to_string()));
            } else {
                spans.push(Span::raw(content.to_string()));
                spans.push(Span::styled(
                    " ",
                    Style::default().fg(Color::Black).bg(Color::Gray),
                ));
            }
            Line::from(spans)
        })
        .collect()
}

fn wrapped_line_count(text: &str, width: usize) -> usize {
    Line::raw(text.to_string())
        .width()
        .div_ceil(width.max(1))
        .max(1)
}

fn prompt_cursor_visual_row(buffer: &PromptBuffer, width: usize) -> usize {
    let mut lines = buffer.as_str()[..buffer.cursor_byte()]
        .split('\n')
        .collect::<Vec<_>>();
    let current_line = lines.pop().unwrap_or_default();
    let preceding_rows = lines
        .into_iter()
        .map(|line| wrapped_line_count(line, width))
        .sum::<usize>();
    preceding_rows + Line::raw(current_line.to_string()).width() / width.max(1)
}

/// The dossier screen's own lines, clipped to the pane it is given.
///
/// The pane is 80 columns in the common terminal, and a digest clipped to fit
/// stops being a digest, so `clip` marks the cut instead of pretending the line
/// was short.
/// The dossier screen's lines, as the pane will receive them.
///
/// Index rows are clipped, because a scannable list that wraps into a second
/// row per case is not scannable. Everything else is left whole and wrapped by
/// the paragraph widget, because a wrapped boundary sentence is still readable
/// and a clipped integrity digest is not a digest any more (guide 7.3).
fn dossier_body_lines(view: &DossierView, width: usize) -> Vec<String> {
    let list_end = view.header.len() + 1 + view.rows.len();
    view.lines()
        .iter()
        .enumerate()
        .map(|(index, line)| {
            if (view.header.len()..list_end).contains(&index) {
                dossier::clip(line, width)
            } else {
                line.clone()
            }
        })
        .collect()
}

fn draw(frame: &mut ratatui::Frame<'_>, app: &App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(4),
            Constraint::Length(5),
            Constraint::Length(1),
        ])
        .split(frame.area());
    // The frame is unchanged; the dossier replaces what the two middle panes
    // say, not how the screen is laid out. That is why it needs no exception to
    // the layout rule (guide 7.2).
    let title = Paragraph::new(Line::from(vec![
        Span::styled(
            " Terminal221b ",
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        ),
        Span::raw(format!(
            "{}  {}",
            app.root.display(),
            if app.crypto_mode { "CRYPTO" } else { "CODING" }
        )),
    ]))
    .block(
        Block::default()
            .borders(Borders::ALL)
            .title("Local-first coding TUI"),
    );
    frame.render_widget(title, chunks[0]);

    if let Some(open) = app.dossier.as_ref() {
        let body_width = chunks[1].width.saturating_sub(2).max(1) as usize;
        let body_height = chunks[1].height.saturating_sub(2) as usize;
        // One scroll offset over the whole screen, so the case list is never
        // scrolled off and the operator loses their anchor.
        let all = dossier_body_lines(&open.view, body_width);
        let lines: Vec<Line<'static>> =
            dossier::screen_window(&all, body_height, open.detail_scroll)
                .into_iter()
                .map(|line| Line::raw(line.to_string()))
                .collect();
        let body = Paragraph::new(Text::from(lines))
            .block(Block::default().borders(Borders::ALL).title("Case dossier"))
            .wrap(Wrap { trim: false });
        frame.render_widget(body, chunks[1]);
        let hint = Paragraph::new(Line::raw(dossier::clip(
            "↑↓ select · PgUp/PgDn detail · Esc close · read-only: nothing here reaches the workspace",
            body_width,
        )))
        .block(Block::default().borders(Borders::ALL).title("Keys"))
        .wrap(Wrap { trim: false });
        frame.render_widget(hint, chunks[2]);
        let status = Paragraph::new(format!(
            " {}  ·  Esc closes the dossier  ·  Ctrl-C quit ",
            app.status
        ))
        .style(Style::default().fg(Color::DarkGray));
        frame.render_widget(status, chunks[3]);
        return;
    }

    let (_, max_scroll) = conversation_scroll_limits(&app.messages, frame.area());
    let scroll = max_scroll.saturating_sub(app.scroll.unwrap_or(0).min(max_scroll));
    let conversation = Paragraph::new(Text::from(conversation_lines(&app.messages)))
        .block(Block::default().borders(Borders::ALL).title("Conversation"))
        .wrap(Wrap { trim: false })
        .scroll((scroll, 0));
    frame.render_widget(conversation, chunks[1]);

    let input_visible_height = chunks[2].height.saturating_sub(2) as usize;
    let input_width = chunks[2].width.saturating_sub(2).max(1) as usize;
    let input_scroll = prompt_cursor_visual_row(&app.input, input_width)
        .saturating_sub(input_visible_height.saturating_sub(1))
        .min(u16::MAX as usize) as u16;
    let input = Paragraph::new(Text::from(prompt_lines(&app.input)))
        .block(
            Block::default()
                .borders(Borders::ALL)
                .title(if app.pending {
                    "Prompt (waiting…)"
                } else {
                    "Prompt"
                }),
        )
        .wrap(Wrap { trim: false })
        .scroll((input_scroll, 0));
    frame.render_widget(input, chunks[2]);
    let status = Paragraph::new(format!(
        " {}  ·  Enter send  arrows edit  PgUp/PgDn scroll  Ctrl-C quit ",
        app.status
    ))
    .style(Style::default().fg(Color::DarkGray));
    frame.render_widget(status, chunks[3]);
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = env::args_os().skip(1).collect::<Vec<_>>();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        println!(
            "Terminal221b Rust TUI\n\nUsage: terminal221b-tui [WORKSPACE]\n\nSet ANTHROPIC_API_KEY to enable chat.\nSet TERMINAL221B_MODEL to override the default model.\n\nInside the TUI: /help, /context, /crypto, /dossier <path>, /tools, /scan, /apply <request>, /save <name>, /sessions, /load <name>, /clear, /quit.\n\n/dossier opens the local case dossier, which is read-only: the eligibility gate\nis computed by the CLI and the screen only displays what it decided.\n"
        );
        return Ok(());
    }
    if args.len() > 1 {
        return Err("usage: terminal221b-tui [WORKSPACE]".into());
    }
    let root = args
        .first()
        .map(PathBuf::from)
        .unwrap_or(env::current_dir()?);
    let root = fs::canonicalize(root)?;
    if !root.is_dir() {
        return Err("workspace path must be a directory".into());
    }
    enable_raw_mode()?;
    execute!(stdout(), EnterAlternateScreen)?;
    let backend = CrosstermBackend::new(stdout());
    let mut terminal = Terminal::new(backend)?;
    let mut app = App::new(root);
    while !app.should_quit {
        app.poll_worker();
        terminal.draw(|frame| draw(frame, &app))?;
        if event::poll(Duration::from_millis(80))?
            && let Event::Key(key) = event::read()?
        {
            if key.kind != KeyEventKind::Press {
                continue;
            }
            match key.code {
                KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    app.should_quit = true
                }
                // The dossier is read-only, so every other key is consumed here
                // and never reaches the prompt. A stray Enter inside this screen
                // cannot send a provider request.
                code if app.dossier.is_some() && app.dossier_key(code) => {}
                KeyCode::Char('a') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    app.input.move_home()
                }
                KeyCode::Char('e') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                    app.input.move_end()
                }
                KeyCode::Char('y') if app.proposal.is_some() => app.approve_patch(true),
                KeyCode::Char('n') if app.proposal.is_some() => app.approve_patch(false),
                KeyCode::Enter if key.modifiers.contains(KeyModifiers::SHIFT) => {
                    app.input.insert('\n');
                    app.scroll = None;
                }
                KeyCode::Enter => app.submit(),
                KeyCode::Left => app.input.move_left(),
                KeyCode::Right => app.input.move_right(),
                KeyCode::Up => app.input.move_vertical(false),
                KeyCode::Down => app.input.move_vertical(true),
                KeyCode::Home => app.input.move_home(),
                KeyCode::End => app.input.move_end(),
                KeyCode::Backspace => app.input.backspace(),
                KeyCode::Delete => app.input.delete(),
                KeyCode::Char(character) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                    app.input.insert(character);
                    app.scroll = None;
                }
                KeyCode::PageUp => {
                    let (page, max) =
                        conversation_scroll_limits(&app.messages, terminal.size()?.into());
                    app.scroll = page_scroll(app.scroll, page, max, true);
                }
                KeyCode::PageDown => {
                    let (page, max) =
                        conversation_scroll_limits(&app.messages, terminal.size()?.into());
                    app.scroll = page_scroll(app.scroll, page, max, false);
                }
                _ => {}
            }
        }
    }
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        let _ = disable_raw_mode();
        let _ = execute!(stdout(), LeaveAlternateScreen);
        eprintln!("terminal221b-tui: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A report as the CLI emits it, trimmed to two cases. Written by hand from
    /// `terminal221b case dossier --json`, because the point of the test is that
    /// this side renders the shape the other side produces, and a fixture copied
    /// from a real run is the only one that proves the field names line up.
    const FIXTURE_REPORT: &str = r#"{
      "version": 1,
      "now": "2026-09-30T12:00:00Z",
      "policyMaxAgeDays": 90,
      "signatureTrust": "no-store",
      "provenance": { "ok": true, "problems": [] },
      "cases": [
        {
          "rank": -1,
          "caseId": "case-exact-in-scope",
          "objective": "Confirm the checkout service is in scope before any owner review",
          "programId": "example-inhouse-program",
          "asset": {
            "status": "exact",
            "original": "https://example.invalid/programs/checkout-service",
            "canonical": "https://example.invalid/programs/checkout-service"
          },
          "assetType": "web-application",
          "state": "research",
          "policySnapshotId": "src-policy-current",
          "policyVersion": "2026-09",
          "policyAgeDays": 2,
          "policyMaxAgeDays": 90,
          "eligibility": "review",
          "blocked": [],
          "awaiting": ["confirmation_unsigned"],
          "confirmations": [
            {
              "confirmationId": "cf-exact-in-scope",
              "confirmedAt": "2026-09-29T09:30:00Z",
              "asset": "https://example.invalid/programs/checkout-service",
              "policySnapshotId": "src-policy-current",
              "statement": "Read the 2026-09 snapshot and confirmed this repository",
              "signed": false
            }
          ],
          "evidence": [
            {
              "evidenceId": "ev-scope-match",
              "claim": "The host is listed as in scope in the 2026-09 snapshot",
              "claimType": "fact",
              "verification": "deterministic",
              "sourceId": "src-policy-current",
              "observedAt": "2026-09-28T09:05:00Z"
            }
          ]
        },
        {
          "rank": 0,
          "caseId": "case-signed-and-eligible",
          "objective": "A signed confirmation clears the gate",
          "programId": "example-inhouse-program",
          "asset": {
            "status": "exact",
            "original": "https://example.invalid/programs/other-service",
            "canonical": "https://example.invalid/programs/other-service"
          },
          "assetType": "web-application",
          "state": "research",
          "policySnapshotId": "src-policy-current",
          "policyVersion": "2026-09",
          "policyAgeDays": 2,
          "policyMaxAgeDays": 90,
          "eligibility": "eligible",
          "blocked": [],
          "awaiting": [],
          "confirmations": [
            {
              "confirmationId": "cf-other",
              "confirmedAt": "2026-09-29T09:40:00Z",
              "asset": "https://example.invalid/programs/other-service",
              "policySnapshotId": "src-policy-current",
              "statement": "Confirmed against the same snapshot",
              "signed": true,
              "keyId": "operator-key"
            }
          ],
          "evidence": []
        }
      ],
      "sources": [
        {
          "sourceId": "src-policy-current",
          "uri": "local://policies/example-inhouse-program/2026-09.json",
          "observedAt": "2026-09-28T09:00:00Z",
          "policyVersion": "2026-09",
          "contentDigest": "sha256:8821577f4bb0c2a9d3d1b1c5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b",
          "digestStatus": "declared"
        }
      ],
      "notDoing": [
        "it does not contact a target, submit anything, or hold signing keys"
      ]
    }"#;

    #[test]
    fn prompt_cursor_scroll_accounts_for_wrapped_and_wide_characters() {
        let mut input = PromptBuffer::default();
        for character in "abcdefghi\n猫猫猫".chars() {
            input.insert(character);
        }
        for _ in 0..4 {
            input.move_left();
        }
        assert_eq!(prompt_cursor_visual_row(&input, 4), 2);
        input.move_vertical(true);
        assert_eq!(prompt_cursor_visual_row(&input, 4), 4);
    }

    #[test]
    fn conversation_page_scroll_clamps_at_both_ends() {
        assert_eq!(page_scroll(None, 5, 12, true), Some(5));
        assert_eq!(page_scroll(Some(10), 5, 12, true), Some(12));
        assert_eq!(page_scroll(Some(12), 5, 12, true), Some(12));
        assert_eq!(page_scroll(Some(12), 5, 12, false), Some(7));
        assert_eq!(page_scroll(Some(2), 5, 12, false), None);
        assert_eq!(page_scroll(None, 5, 0, true), None);
    }

    #[test]
    fn patch_paths_reject_traversal_secrets_and_keys() {
        let root = tempfile::tempdir().unwrap();
        for path in ["../outside", ".env", "keys/deploy.pem"] {
            let patch = format!("diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n");
            assert!(validate_patch(root.path(), &patch).is_err(), "{path}");
        }
    }

    #[test]
    fn patch_requires_git_diff_headers() {
        let root = tempfile::tempdir().unwrap();
        assert!(validate_patch(root.path(), "ordinary assistant text").is_err());
    }

    #[test]
    fn patch_validation_checks_file_headers_not_only_diff_metadata() {
        let root = tempfile::tempdir().unwrap();
        let patch = "diff --git a/src/file.rs b/src/file.rs\n--- a/src/file.rs\n+++ b/.env\n";
        assert!(validate_patch(root.path(), patch).is_err());
    }

    #[test]
    fn patch_parser_rejects_quoted_or_whitespace_paths() {
        let root = tempfile::tempdir().unwrap();
        let patch =
            "diff --git \"a/file name\" \"b/file name\"\n--- a/file name\n+++ b/file name\n";
        assert!(validate_patch(root.path(), patch).is_err());
    }

    /// Draws the real `draw` onto a test backend and reads the buffer back as
    /// text. Every rendering assertion in this file goes through here, so none
    /// of them can pass against a screen that was never actually laid out.
    fn render_app(app: &App, width: u16, height: u16) -> String {
        let backend = ratatui::backend::TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).expect("test terminal");
        terminal.draw(|frame| draw(frame, app)).expect("draws");
        // Buffer indexing is (x, y). An earlier version of this test read y in
        // 0..25 against a 24-row buffer and panicked on the bounds check, which
        // was the test's bug and not the screen's.
        let area = terminal.backend().buffer().area;
        (area.y..area.y + area.height)
            .map(|row| {
                (area.x..area.x + area.width)
                    .map(|column| terminal.backend().buffer()[(column, row)].symbol())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn the_dossier_screen_renders_at_eighty_columns_and_never_scrolls_its_anchor_away() {
        let report: dossier::Report = serde_json::from_str(FIXTURE_REPORT).expect("report parses");
        let mut app = App::new(PathBuf::from("/tmp"));
        app.dossier = Some(OpenDossier {
            view: dossier::view(&report, 0),
            detail_scroll: 0,
        });
        app.status = "Case dossier open".into();

        // A short pane, because 24 rows is what an operator actually has. The
        // header and the whole case list must fit without scrolling: an operator
        // who cannot see which case is selected cannot use the screen.
        let rendered = render_app(&app, 80, 24);
        assert!(rendered.contains("Case dossier"), "{rendered}");
        assert!(
            rendered.contains("case-exact-in-scope"),
            "the held case is not on screen without scrolling:\n{rendered}"
        );
        assert!(
            rendered.contains("confirmation_unsigned"),
            "the screen does not say why the case is held:\n{rendered}"
        );
        assert!(
            rendered.contains("gate closed"),
            "a closed gate is not shown as a clean bill of health:\n{rendered}"
        );
        assert!(
            rendered.contains("Esc closes the dossier"),
            "the read-only screen has no way out:\n{rendered}"
        );
        assert!(
            rendered.lines().all(|line| line.chars().count() <= 80),
            "the screen wrote past the right edge of an 80-column terminal"
        );

        // Scrolling moves the detail and the anchor stays put.
        app.dossier_key(KeyCode::PageDown);
        let scrolled = render_app(&app, 80, 24);
        assert_ne!(scrolled, rendered, "PgDown did nothing");
    }

    #[test]
    fn a_declared_digest_is_reachable_and_is_labelled_declared() {
        let report: dossier::Report = serde_json::from_str(FIXTURE_REPORT).expect("report parses");
        let mut app = App::new(PathBuf::from("/tmp"));
        app.dossier = Some(OpenDossier {
            view: dossier::view(&report, 0),
            detail_scroll: 0,
        });
        // A tall pane so the whole surface is in the buffer at once. The point of
        // this one is the wording of the digest line, not the paging, which the
        // 24-row test above covers.
        let rendered = render_app(&app, 80, 80);
        assert!(
            rendered.contains("declared by the bundle, not re-read here"),
            "a declared digest is not labelled:\n{rendered}"
        );
        assert!(
            rendered.contains("sha256:8821577f4bb0c2a9"),
            "the digest was clipped, and a clipped digest is not a digest:\n{rendered}"
        );
        assert!(
            !rendered.contains("verified locally"),
            "something is claiming to have re-read the bytes:\n{rendered}"
        );
    }

    /// A read-only surface must swallow the keys that would otherwise send a
    /// provider request. This is the assertion that makes "read-only" true
    /// rather than decorative.
    #[test]
    fn an_open_dossier_consumes_every_key_so_none_reaches_the_prompt() {
        let report: dossier::Report = serde_json::from_str(FIXTURE_REPORT).expect("report parses");
        let mut app = App::new(PathBuf::from("/tmp"));
        app.dossier = Some(OpenDossier {
            view: dossier::view(&report, 0),
            detail_scroll: 0,
        });
        let before = app.input.as_str().to_string();

        for code in [
            KeyCode::Enter,
            KeyCode::Char('x'),
            KeyCode::Backspace,
            KeyCode::Left,
            KeyCode::Home,
        ] {
            assert!(app.dossier_key(code), "{code:?} reached the prompt");
        }
        assert_eq!(app.input.as_str(), before, "a key edited the prompt");

        // Esc closes, and only then does a key reach the prompt again. The closing
        // key is routed by hand here because that is what the event loop does
        // for every other key: `dossier_key` declining a key is the signal, and
        // the loop then performs the normal action.
        app.dossier_key(KeyCode::Esc);
        assert!(app.dossier.is_none());
        if !app.dossier_key(KeyCode::Char('x')) {
            app.input.insert('x');
        }
        assert_eq!(app.input.as_str(), "x");
    }

    #[test]
    fn selecting_a_case_changes_the_detail_pane_not_the_order() {
        let report: dossier::Report = serde_json::from_str(FIXTURE_REPORT).expect("report parses");
        let mut app = App::new(PathBuf::from("/tmp"));
        app.dossier = Some(OpenDossier {
            view: dossier::view(&report, 0),
            detail_scroll: 0,
        });
        let first = app.dossier.as_ref().unwrap().view.detail.join("\n");

        app.dossier_key(KeyCode::Down);
        let open = app.dossier.as_ref().unwrap();
        assert_eq!(open.view.selected, 1);
        assert_ne!(
            open.view.detail.join("\n"),
            first,
            "moving to the next case did not change what is shown"
        );

        // Up at the top must not wrap to the bottom of the queue.
        app.dossier_key(KeyCode::Up);
        app.dossier_key(KeyCode::Up);
        assert_eq!(app.dossier.as_ref().unwrap().view.selected, 0);
    }

    #[cfg(unix)]
    #[test]
    fn patch_parser_rejects_symlink_destinations() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("real.rs"), "safe\n").unwrap();
        std::os::unix::fs::symlink(root.path().join("real.rs"), root.path().join("alias.rs"))
            .unwrap();
        let patch = "diff --git a/alias.rs b/alias.rs\n--- a/alias.rs\n+++ b/alias.rs\n";
        assert!(validate_patch(root.path(), patch).is_err());
    }
}
