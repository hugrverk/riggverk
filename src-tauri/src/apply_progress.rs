//! Progress events for the long-running setup commands (apply, uninstall, rules conversion, rollback).
//!
//! Those commands return only when they are finished, so the webview learns what they are doing from
//! `apply-progress` events. Reporting is best effort and never part of the transaction: without an app
//! handle (tests) or when an emit fails nothing happens, and events are rate limited so a large apply cannot
//! flood the IPC channel.

use std::path::Path;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Emitter;

use crate::artifact_registry::ArtifactId;

/// Name of the event the webview listens for.
pub const APPLY_PROGRESS_EVENT: &str = "apply-progress";

/// At most about 30 events per second; phase changes and completed phases are always sent.
const MIN_EVENT_INTERVAL: Duration = Duration::from_millis(33);

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ApplyPhase {
    /// Copying the current state of each artifact into the transaction backup.
    Backup,
    /// The main per-file work: writing, removing or (for a rollback) restoring.
    Apply,
    /// The command has finished, successfully or not; the result arrives through the command's return value.
    Done,
}

/// Event payload. `done` counts finished items; `file` is the item being worked on (`~/...`, never file
/// contents), absent between items and once a phase is complete.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct ApplyProgress {
    /// The command's name (`apply_setup`, `apply_uninstall`, `apply_rules_conversion`, ...).
    pub task: String,
    pub phase: ApplyPhase,
    pub done: usize,
    pub total: Option<usize>,
    pub file: Option<String>,
}

static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Registers the app handle events are emitted through. Called once at startup; before that (and in
/// tests) reporters stay silent.
pub fn install(handle: tauri::AppHandle) {
    let _ = APP_HANDLE.set(handle);
}

/// Decides which events go out: the first one, any later one once the interval has passed, and every
/// forced one.
struct EmitGate {
    last: Option<Instant>,
}

impl EmitGate {
    fn admit(&mut self, now: Instant, force: bool) -> bool {
        let due = force
            || self
                .last
                .is_none_or(|last| now.saturating_duration_since(last) >= MIN_EVENT_INTERVAL);
        if due {
            self.last = Some(now);
        }
        due
    }
}

type Sink = Box<dyn FnMut(ApplyProgress)>;

/// Reports the progress of one command run. Pass it down to the loops that do the work.
pub struct ProgressReporter {
    task: &'static str,
    sink: Option<Sink>,
    gate: EmitGate,
    phase: Option<ApplyPhase>,
    done: usize,
    total: Option<usize>,
}

impl ProgressReporter {
    /// A reporter that emits nothing.
    pub fn silent() -> Self {
        Self::with_sink("", None)
    }

    /// A reporter that emits `apply-progress` events through the app handle, if one is registered.
    pub fn for_task(task: &'static str) -> Self {
        let sink = APP_HANDLE.get().cloned().map(|handle| {
            Box::new(move |payload: ApplyProgress| {
                // A failed emit must never touch the transaction.
                let _ = handle.emit(APPLY_PROGRESS_EVENT, payload);
            }) as Sink
        });
        Self::with_sink(task, sink)
    }

    /// A reporter that records every event it lets through.
    #[cfg(test)]
    pub(crate) fn collecting(task: &'static str) -> (Self, CollectedEvents) {
        let events = CollectedEvents::default();
        let recorder = events.clone();
        let sink = Box::new(move |payload| recorder.0.borrow_mut().push(payload)) as Sink;
        (Self::with_sink(task, Some(sink)), events)
    }

    fn with_sink(task: &'static str, sink: Option<Sink>) -> Self {
        Self {
            task,
            sink,
            gate: EmitGate { last: None },
            phase: None,
            done: 0,
            total: None,
        }
    }

    /// Reports `done` of `total` items finished in `phase`; `file` names the item in progress and is only
    /// computed when the event goes out. A change of phase and `done == total` are never rate limited.
    pub fn report(
        &mut self,
        phase: ApplyPhase,
        done: usize,
        total: Option<usize>,
        file: impl FnOnce() -> Option<String>,
    ) {
        self.report_at(Instant::now(), phase, done, total, file);
    }

    fn report_at(
        &mut self,
        now: Instant,
        phase: ApplyPhase,
        done: usize,
        total: Option<usize>,
        file: impl FnOnce() -> Option<String>,
    ) {
        let phase_changed = self.phase != Some(phase);
        self.phase = Some(phase);
        self.done = done;
        self.total = total;
        if self.sink.is_none() {
            return;
        }
        let force = phase_changed || total == Some(done);
        if !self.gate.admit(now, force) {
            return;
        }
        self.send(phase, file());
    }

    /// Ends the stream with a `done` event carrying the last counts. Nothing is sent if the command never
    /// got as far as reporting.
    pub fn finish(&mut self) {
        if self.phase.take().is_none() {
            return;
        }
        if self.sink.is_some() {
            self.gate.admit(Instant::now(), true);
            self.send(ApplyPhase::Done, None);
        }
    }

    fn send(&mut self, phase: ApplyPhase, file: Option<String>) {
        let payload = ApplyProgress {
            task: self.task.to_string(),
            phase,
            done: self.done,
            total: self.total,
            file,
        };
        if let Some(sink) = self.sink.as_mut() {
            sink(payload);
        }
    }
}

/// What a test reporter recorded.
#[cfg(test)]
#[derive(Clone, Default)]
pub(crate) struct CollectedEvents(std::rc::Rc<std::cell::RefCell<Vec<ApplyProgress>>>);

#[cfg(test)]
impl CollectedEvents {
    pub(crate) fn snapshot(&self) -> Vec<ApplyProgress> {
        self.0.borrow().clone()
    }
}

/// Where an artifact lives, for display: `~/.claude/CLAUDE.md`. An artifact outside the home folder (a custom
/// workspace) shows its short label instead of an absolute path.
pub fn artifact_display_path(artifact: &ArtifactId, home: &Path, workspace_root: &Path) -> String {
    artifact
        .resolve_dest(home, workspace_root)
        .ok()
        .and_then(|dest| {
            dest.strip_prefix(home)
                .ok()
                .map(|rel| format!("~/{}", rel.to_string_lossy().replace('\\', "/")))
        })
        .unwrap_or_else(|| crate::installation_status::artifact_label(artifact))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn collecting() -> (ProgressReporter, CollectedEvents) {
        ProgressReporter::collecting("apply_setup")
    }

    #[test]
    fn gate_admits_the_first_event_then_one_per_interval() {
        let start = Instant::now();
        let mut gate = EmitGate { last: None };
        assert!(gate.admit(start, false));
        assert!(!gate.admit(start + Duration::from_millis(10), false));
        assert!(!gate.admit(start + Duration::from_millis(32), false));
        assert!(gate.admit(start + Duration::from_millis(33), false));
        assert!(!gate.admit(start + Duration::from_millis(40), false));
    }

    #[test]
    fn gate_always_admits_forced_events_and_restarts_the_interval() {
        let start = Instant::now();
        let mut gate = EmitGate { last: None };
        assert!(gate.admit(start, false));
        assert!(gate.admit(start + Duration::from_millis(1), true));
        assert!(!gate.admit(start + Duration::from_millis(20), false));
        assert!(gate.admit(start + Duration::from_millis(34), false));
    }

    #[test]
    fn two_hundred_files_in_a_burst_stay_under_thirty_events_a_second() {
        let (mut reporter, events) = collecting();
        let start = Instant::now();
        let total = 200;
        // One file per millisecond: 200 ms of work.
        for index in 0..total {
            reporter.report_at(
                start + Duration::from_millis(index as u64),
                ApplyPhase::Apply,
                index,
                Some(total),
                || Some(format!("~/file-{index}")),
            );
        }
        reporter.report_at(
            start + Duration::from_millis(total as u64),
            ApplyPhase::Apply,
            total,
            Some(total),
            || None,
        );

        let events = events.snapshot();
        // First event of the phase, one per 33 ms window (6 within 200 ms), and the completed phase.
        assert!(events.len() <= 8, "{} events", events.len());
        assert_eq!(events.first().map(|e| e.done), Some(0));
        let last = events.last().expect("the last event is always emitted");
        assert_eq!(
            (last.done, last.total, last.file.as_deref()),
            (200, Some(200), None)
        );
        assert!(events.windows(2).all(|pair| pair[0].done < pair[1].done));
    }

    #[test]
    fn phase_changes_are_never_dropped() {
        let (mut reporter, events) = collecting();
        let now = Instant::now();
        reporter.report_at(now, ApplyPhase::Backup, 0, Some(3), || None);
        reporter.report_at(now, ApplyPhase::Backup, 1, Some(3), || None);
        reporter.report_at(now, ApplyPhase::Apply, 0, Some(3), || None);
        let phases: Vec<_> = events
            .snapshot()
            .iter()
            .map(|e| (e.phase, e.done))
            .collect();
        assert_eq!(
            phases,
            vec![(ApplyPhase::Backup, 0), (ApplyPhase::Apply, 0)]
        );
    }

    #[test]
    fn finish_sends_done_with_the_last_counts_even_when_the_last_report_was_dropped() {
        let (mut reporter, events) = collecting();
        let now = Instant::now();
        reporter.report_at(now, ApplyPhase::Apply, 0, Some(7), || Some("~/a".into()));
        reporter.report_at(now, ApplyPhase::Apply, 3, Some(7), || Some("~/b".into()));
        reporter.finish();
        reporter.finish();

        let events = events.snapshot();
        assert_eq!(events.len(), 2, "second finish sends nothing");
        let done = events.last().unwrap();
        assert_eq!(done.phase, ApplyPhase::Done);
        assert_eq!(
            (done.done, done.total, done.file.as_deref()),
            (3, Some(7), None)
        );
    }

    #[test]
    fn finish_without_any_report_sends_nothing() {
        let (mut reporter, events) = collecting();
        reporter.finish();
        assert!(events.snapshot().is_empty());
    }

    #[test]
    fn dropped_events_do_not_compute_their_file() {
        let (mut reporter, _events) = collecting();
        let now = Instant::now();
        reporter.report_at(now, ApplyPhase::Apply, 0, Some(5), || None);
        reporter.report_at(now, ApplyPhase::Apply, 1, Some(5), || {
            panic!("a dropped event must not build its payload")
        });
    }

    #[test]
    fn payload_serializes_to_the_documented_shape() {
        let payload = ApplyProgress {
            task: "apply_setup".into(),
            phase: ApplyPhase::Apply,
            done: 4,
            total: Some(7),
            file: Some("~/.claude/skills/handoff/SKILL.md".into()),
        };
        assert_eq!(
            serde_json::to_value(&payload).unwrap(),
            serde_json::json!({
                "task": "apply_setup",
                "phase": "apply",
                "done": 4,
                "total": 7,
                "file": "~/.claude/skills/handoff/SKILL.md"
            })
        );
        let backup = ApplyProgress {
            task: "apply_setup".into(),
            phase: ApplyPhase::Backup,
            done: 0,
            total: None,
            file: None,
        };
        assert_eq!(
            serde_json::to_value(&backup).unwrap(),
            serde_json::json!({
                "task": "apply_setup",
                "phase": "backup",
                "done": 0,
                "total": null,
                "file": null
            })
        );
    }

    #[test]
    fn a_silent_reporter_does_nothing_and_never_builds_a_file() {
        let mut reporter = ProgressReporter::silent();
        reporter.report(ApplyPhase::Apply, 1, Some(2), || {
            panic!("a silent reporter must not build its payload")
        });
        reporter.finish();
    }

    #[test]
    fn a_task_reporter_without_an_app_handle_is_silent() {
        // No handle is installed in tests: running a command must work with nobody listening.
        let mut reporter = ProgressReporter::for_task("apply_setup");
        reporter.report(ApplyPhase::Apply, 1, Some(2), || {
            panic!("no handle: nothing to emit")
        });
        reporter.finish();
    }

    #[test]
    fn display_path_is_relative_to_home() {
        let home = Path::new("/home/someone");
        let workspace = Path::new("/home/someone/.config/agent-workspace");
        assert_eq!(
            artifact_display_path(&ArtifactId::ClaudeRules, home, workspace),
            "~/.claude/CLAUDE.md"
        );
        let file = ArtifactId::WorkspaceFile(
            crate::artifact_registry::WorkspaceRelPath::new("docs/guide.md").unwrap(),
        );
        assert_eq!(
            artifact_display_path(&file, home, workspace),
            "~/.config/agent-workspace/docs/guide.md"
        );
    }

    #[test]
    fn display_path_outside_home_falls_back_to_the_label() {
        let home = Path::new("/home/someone");
        let workspace = Path::new("/var/folders/tmp/custom-workspace");
        let file = ArtifactId::WorkspaceFile(
            crate::artifact_registry::WorkspaceRelPath::new("docs/guide.md").unwrap(),
        );
        let shown = artifact_display_path(&file, home, workspace);
        assert_eq!(shown, "Workspace file docs/guide.md");
        assert!(!shown.contains("/var/folders"));
    }
}
