//! Live Claude Code session status, read from the CLI's own per-session
//! status files (#356). Every interactive session keeps
//! `<CLAUDE_CONFIG_DIR>/sessions/<pid>.json` (default `~/.claude/sessions`),
//! rewritten whenever its status changes. The files carry `status` (`busy`,
//! `waiting`, `idle`, sometimes `shell`), `kind` (`interactive` for real
//! sessions; `claude -p` and SDK runs use other kinds), and `procStart` for
//! liveness. A file can outlive its process (crash, kill), so a session
//! counts only when its process identity still checks out: on Linux
//! `procStart` must equal field 22 of `/proc/<pid>/stat` (which also catches
//! recycled pids); on macOS `ps` confirms the pid exists; on Windows, with no
//! procfs and no cheap spawn-free check, a status updated within the last
//! half hour stands in — a documented heuristic, weaker than the others.
//!
//! Read-only and bounded: at most [`MAX_FILES`] files of [`MAX_FILE_BYTES`]
//! each are consulted, every parse failure is a skipped file, and a missing
//! sessions directory is simply "no sessions". Tests inject the directory
//! and a fake [`Liveness`]; nothing here touches a real config dir or /proc.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::Deserialize;

/// Sessions are tiny status documents; anything past this is not one.
const MAX_FILE_BYTES: u64 = 8 * 1024;
/// A machine running hundreds of concurrent interactive sessions is not a
/// shape this counts; past this many files the rest are ignored.
const MAX_FILES: usize = 64;
/// Windows liveness stand-in: how recently a status must have been updated
/// for the session to still count when process identity cannot be checked.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
const RECENT_WINDOW_MS: i64 = 30 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionsSummary {
    pub working: u32,
    pub waiting: u32,
    pub idle: u32,
}

impl SessionsSummary {
    fn add(&mut self, status: &str) {
        match status {
            "busy" => self.working += 1,
            "waiting" => self.waiting += 1,
            "idle" | "shell" => self.idle += 1,
            _ => {}
        }
    }

    fn is_empty(&self) -> bool {
        self.working == 0 && self.waiting == 0 && self.idle == 0
    }

    /// The bar-facing line: working and waiting only. Knowing a session is
    /// idle is the absence of a signal, not one — an all-idle summary reads
    /// as nothing to show.
    pub fn describe(&self) -> Option<String> {
        let mut parts = Vec::new();
        if self.working > 0 {
            parts.push(format!("{} working", self.working));
        }
        if self.waiting > 0 {
            parts.push(format!("{} waiting", self.waiting));
        }
        match parts.len() {
            0 => None,
            _ => Some(parts.join(" · ")),
        }
    }
}

/// How a session file's process is verified. The trait exists so tests never
/// touch `/proc` or spawn `ps`; [`ProdLiveness`] carries the real per-OS
/// checks.
pub trait Liveness {
    fn alive(
        &self,
        pid: u64,
        proc_start: Option<&str>,
        updated_at_ms: Option<i64>,
        now: DateTime<Utc>,
    ) -> bool;
}

/// The production checks. Linux compares `procStart` against procfs (exact,
/// recycled-pid safe); macOS asks `ps` whether the pid exists; Windows
/// accepts a recently-updated status, since neither check is available
/// without a spawn this widget will not make.
pub struct ProdLiveness;

impl Liveness for ProdLiveness {
    fn alive(
        &self,
        pid: u64,
        proc_start: Option<&str>,
        updated_at_ms: Option<i64>,
        now: DateTime<Utc>,
    ) -> bool {
        #[cfg(target_os = "linux")]
        {
            let _ = (updated_at_ms, now);
            let start = match proc_start {
                Some(start) => start.trim(),
                None => return false,
            };
            linux_proc_start(pid).map(|s| s == start).unwrap_or(false)
        }
        #[cfg(target_os = "macos")]
        {
            let _ = (proc_start, updated_at_ms, now);
            let output = std::process::Command::new("/bin/ps")
                .args(["-p", &pid.to_string(), "-o", "pid="])
                .stdin(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .output();
            matches!(output, Ok(out) if out.status.success())
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            let _ = (pid, proc_start);
            match updated_at_ms {
                // Saturating so an absurd future or past stamp cannot overflow
                // in debug builds; a future stamp is not "recent", it is bad
                // data, and does not count.
                Some(updated) => {
                    let now_ms = now.timestamp_millis();
                    updated <= now_ms && now_ms.saturating_sub(updated) <= RECENT_WINDOW_MS
                }
                None => false,
            }
        }
    }
}

/// Field 22 (`starttime`) of `/proc/<pid>/stat`, or `None` when the process
/// is gone or the file does not parse. `comm` (field 2) can contain spaces
/// inside its parentheses, so the fields are counted after the last `)`.
#[cfg(target_os = "linux")]
fn linux_proc_start(pid: u64) -> Option<String> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let after_comm = stat.rsplit_once(')')?.1;
    // after_comm starts with " state ppid ..." — state is field 3, so
    // starttime (field 22) is the 20th token counting from zero here.
    after_comm.split_whitespace().nth(19).map(str::to_owned)
}

#[derive(Debug, Deserialize)]
struct SessionFile {
    pid: u64,
    #[serde(rename = "procStart")]
    proc_start: Option<String>,
    kind: Option<String>,
    status: Option<String>,
    #[serde(rename = "statusUpdatedAt")]
    status_updated_at: Option<i64>,
}

/// Where the CLI keeps its session status files: `$CLAUDE_CONFIG_DIR` when
/// set (the CLI's own convention), else `~/.claude`, then `sessions`.
pub fn sessions_dir() -> Option<PathBuf> {
    let root = match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => {
            let home = directories::BaseDirs::new()?.home_dir().to_path_buf();
            home.join(".claude")
        }
    };
    Some(root.join("sessions"))
}

/// Count live interactive sessions in `dir`. `None` when the directory does
/// not exist; every other failure degrades to fewer sessions, never an
/// error — this is an annotation, not a fetch.
pub fn scan(dir: &Path, liveness: &dyn Liveness, now: DateTime<Utc>) -> Option<SessionsSummary> {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();
    paths.truncate(MAX_FILES);

    let mut summary = SessionsSummary {
        working: 0,
        waiting: 0,
        idle: 0,
    };
    for path in paths {
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Ok(session) = serde_json::from_slice::<SessionFile>(&bytes) else {
            continue;
        };
        if session.kind.as_deref() != Some("interactive") {
            continue;
        }
        let status = session.status.clone().unwrap_or_default();
        if !matches!(status.as_str(), "busy" | "waiting" | "idle" | "shell") {
            continue;
        }
        if !liveness.alive(
            session.pid,
            session.proc_start.as_deref(),
            session.status_updated_at,
            now,
        ) {
            continue;
        }
        summary.add(&status);
    }
    if summary.is_empty() {
        None
    } else {
        Some(summary)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeLiveness;
    impl Liveness for FakeLiveness {
        fn alive(&self, _pid: u64, _s: Option<&str>, _u: Option<i64>, _now: DateTime<Utc>) -> bool {
            true
        }
    }

    struct DeadLiveness;
    impl Liveness for DeadLiveness {
        fn alive(&self, _pid: u64, _s: Option<&str>, _u: Option<i64>, _now: DateTime<Utc>) -> bool {
            false
        }
    }

    fn now() -> DateTime<Utc> {
        Utc::now()
    }

    fn seed(dir: &Path, name: &str, body: &str) {
        std::fs::write(dir.join(format!("{name}.json")), body).unwrap();
    }

    fn dir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn counts_working_waiting_and_idle_kinds() {
        let dir = dir();
        seed(
            dir.path(),
            "1",
            r#"{"pid":1,"kind":"interactive","status":"busy"}"#,
        );
        seed(
            dir.path(),
            "2",
            r#"{"pid":2,"kind":"interactive","status":"busy"}"#,
        );
        seed(
            dir.path(),
            "3",
            r#"{"pid":3,"kind":"interactive","status":"waiting"}"#,
        );
        seed(
            dir.path(),
            "4",
            r#"{"pid":4,"kind":"interactive","status":"shell"}"#,
        );
        let summary = scan(dir.path(), &FakeLiveness, now()).unwrap();
        assert_eq!((summary.working, summary.waiting, summary.idle), (2, 1, 1));
        assert_eq!(summary.describe().as_deref(), Some("2 working · 1 waiting"));
    }

    #[test]
    fn non_interactive_kinds_never_count() {
        let dir = dir();
        seed(dir.path(), "1", r#"{"pid":1,"kind":"cli","status":"busy"}"#);
        seed(dir.path(), "2", r#"{"pid":2,"kind":"sdk","status":"busy"}"#);
        assert!(scan(dir.path(), &FakeLiveness, now()).is_none());
    }

    #[test]
    fn dead_processes_do_not_count() {
        let dir = dir();
        seed(
            dir.path(),
            "1",
            r#"{"pid":1,"kind":"interactive","status":"busy"}"#,
        );
        assert!(scan(dir.path(), &DeadLiveness, now()).is_none());
    }

    #[test]
    fn malformed_and_unknown_files_are_skipped_silently() {
        let dir = dir();
        seed(dir.path(), "broken", "not json at all");
        seed(
            dir.path(),
            "unknown",
            r#"{"pid":1,"kind":"interactive","status":"sleeping"}"#,
        );
        seed(
            dir.path(),
            "nopid",
            r#"{"kind":"interactive","status":"busy"}"#,
        );
        seed(
            dir.path(),
            "live",
            r#"{"pid":9,"kind":"interactive","status":"waiting"}"#,
        );
        let summary = scan(dir.path(), &FakeLiveness, now()).unwrap();
        assert_eq!((summary.waiting, summary.working), (1, 0));
    }

    #[test]
    fn a_missing_directory_is_no_sessions_not_an_error() {
        let dir = dir();
        assert!(scan(&dir.path().join("absent"), &FakeLiveness, now()).is_none());
    }

    #[test]
    fn an_all_idle_summary_has_nothing_to_say() {
        let dir = dir();
        seed(
            dir.path(),
            "1",
            r#"{"pid":1,"kind":"interactive","status":"idle"}"#,
        );
        let summary = scan(dir.path(), &FakeLiveness, now()).unwrap();
        assert_eq!(summary.idle, 1);
        assert!(summary.describe().is_none());
    }

    #[test]
    fn describe_lists_each_count_only_when_nonzero() {
        let summary = SessionsSummary {
            working: 0,
            waiting: 2,
            idle: 3,
        };
        assert_eq!(summary.describe().as_deref(), Some("2 waiting"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_proc_start_reads_field_22_after_a_spaced_comm() {
        // comm contains spaces; starttime (field 22) must still land right.
        let line =
            "42 (claude code (node)) R 1 42 42 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 6 0 7322237 0";
        // Write through the real reader by faking /proc layout is not
        // possible hermetically; the parser itself is exercised directly.
        let after = line.rsplit_once(')').unwrap().1;
        assert_eq!(after.split_whitespace().nth(19), Some("7322237"));
    }
}
