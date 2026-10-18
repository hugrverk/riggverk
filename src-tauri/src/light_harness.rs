//! The light tier: GitHub Copilot, Pi and Kilo Code.
//!
//! A light harness gets the shared skills (through the folders it reads, see
//! [`crate::skill_roots`]) and a runtime health row set. Install facts that are data live in
//! `resources/default-workspace/metadata/light-harnesses.json`. That file is embedded at build time
//! and never read from the runtime workspace, so nothing the user edits can redirect what the app
//! runs or writes. Identity (the [`HarnessId`] variants, the TypeScript unions) stays code;
//! `scripts/check-harness-mirror.py` keeps the descriptor, the Rust ids and the UI in step.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;

use crate::agent_targets::HarnessId;

const DESCRIPTOR: &str =
    include_str!("../../resources/default-workspace/metadata/light-harnesses.json");

const SCHEMA_VERSION: u32 = 1;
const MAX_LABEL_CHARS: usize = 24;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawDescriptor {
    version: u32,
    harnesses: BTreeMap<String, RawHarness>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawHarness {
    label: String,
    cli: RawCli,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawCli {
    program: String,
}

/// One light harness as the descriptor describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LightHarness {
    pub id: HarnessId,
    /// Display name: the tab, the page title and messages.
    pub label: String,
    /// The CLI program name looked up on `PATH`; the only call made to it is `--version`.
    pub cli_program: String,
}

fn is_plain_label(label: &str) -> bool {
    !label.is_empty()
        && label.chars().count() <= MAX_LABEL_CHARS
        && label
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '.'))
        && label.trim() == label
}

/// A bare program name: no path, no option-like leading dash, nothing a shell would interpret.
fn is_bare_program_name(program: &str) -> bool {
    let mut chars = program.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && program.len() <= 32
        && program
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Parses and validates a descriptor. The result has one entry per light [`HarnessId`], in
/// [`HarnessId::ALL`] order.
fn parse(text: &str) -> Result<Vec<LightHarness>, String> {
    let raw: RawDescriptor =
        serde_json::from_str(text).map_err(|error| format!("not a valid descriptor: {error}"))?;
    if raw.version != SCHEMA_VERSION {
        return Err(format!("unsupported version {}", raw.version));
    }
    let mut by_id: BTreeMap<&str, LightHarness> = BTreeMap::new();
    for (key, harness) in raw.harnesses {
        let id = HarnessId::ALL
            .iter()
            .copied()
            .find(|candidate| candidate.as_str() == key)
            .ok_or_else(|| format!("unknown harness id {key:?}"))?;
        if !id.is_light() {
            return Err(format!("{key} is not a light harness"));
        }
        if !is_plain_label(&harness.label) {
            return Err(format!(
                "{key}: label is not plain text of 1-{MAX_LABEL_CHARS} characters"
            ));
        }
        if !is_bare_program_name(&harness.cli.program) {
            return Err(format!("{key}: cli.program is not a bare program name"));
        }
        by_id.insert(
            id.as_str(),
            LightHarness {
                id,
                label: harness.label,
                cli_program: harness.cli.program,
            },
        );
    }
    HarnessId::ALL
        .iter()
        .copied()
        .filter(|id| id.is_light())
        .map(|id| {
            by_id
                .remove(id.as_str())
                .ok_or_else(|| format!("light harness {} has no entry", id.as_str()))
        })
        .collect()
}

/// Every light harness, in [`HarnessId::ALL`] order. Empty only when the embedded descriptor is
/// invalid, which `embedded_descriptor_is_valid` rules out for any build that passes its tests.
pub fn light_harnesses() -> &'static [LightHarness] {
    static PARSED: OnceLock<Vec<LightHarness>> = OnceLock::new();
    PARSED.get_or_init(|| parse(DESCRIPTOR).unwrap_or_default())
}

/// The descriptor of `id`; `None` for a central harness.
pub fn descriptor(id: HarnessId) -> Option<&'static LightHarness> {
    light_harnesses().iter().find(|harness| harness.id == id)
}

/// The name shown for `id`: the descriptor's label for a light harness, the wire name otherwise.
pub fn display_name(id: HarnessId) -> &'static str {
    descriptor(id).map_or(id.as_str(), |harness| harness.label.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid() -> serde_json::Value {
        serde_json::from_str(DESCRIPTOR).expect("descriptor is JSON")
    }

    fn parse_value(value: &serde_json::Value) -> Result<Vec<LightHarness>, String> {
        parse(&value.to_string())
    }

    #[test]
    fn embedded_descriptor_is_valid() {
        let harnesses = parse(DESCRIPTOR).expect("the embedded descriptor validates");
        assert_eq!(
            harnesses
                .iter()
                .map(|harness| (
                    harness.id,
                    harness.label.as_str(),
                    harness.cli_program.as_str()
                ))
                .collect::<Vec<_>>(),
            vec![
                (HarnessId::Copilot, "Copilot", "copilot"),
                (HarnessId::Pi, "Pi", "pi"),
                (HarnessId::Kilo, "Kilo", "kilo"),
            ]
        );
        assert_eq!(light_harnesses(), harnesses.as_slice());
    }

    #[test]
    fn every_light_harness_id_has_a_descriptor_and_no_central_one_has() {
        for id in HarnessId::ALL {
            assert_eq!(descriptor(*id).is_some(), id.is_light(), "{}", id.as_str());
        }
        assert_eq!(display_name(HarnessId::Copilot), "Copilot");
        assert_eq!(display_name(HarnessId::Claude), "claude");
    }

    #[test]
    fn a_descriptor_that_names_a_central_or_unknown_harness_is_refused() {
        for key in ["claude", "codex", "cursor", "opencode", "unknown", "Pi"] {
            let mut value = valid();
            value["harnesses"][key] = serde_json::json!({
                "label": "X",
                "cli": { "program": "x" },
            });
            assert!(parse_value(&value).is_err(), "{key}");
        }
    }

    #[test]
    fn a_descriptor_missing_a_light_harness_or_with_unknown_fields_is_refused() {
        let mut value = valid();
        value["harnesses"].as_object_mut().unwrap().remove("pi");
        assert!(parse_value(&value).unwrap_err().contains("pi"));

        let mut value = valid();
        value["harnesses"]["pi"]["cli"]["version_args"] = serde_json::json!(["--help"]);
        assert!(
            parse_value(&value).is_err(),
            "no field the app does not read"
        );

        let mut value = valid();
        value["extra"] = serde_json::json!(true);
        assert!(parse_value(&value).is_err());

        let mut value = valid();
        value["version"] = serde_json::json!(2);
        assert!(parse_value(&value).unwrap_err().contains("version"));
    }

    #[test]
    fn programs_must_be_bare_names_and_labels_plain_text() {
        for program in [
            "",
            "-h",
            "../pi",
            "/usr/bin/pi",
            "pi --help",
            "pi;ls",
            "Pi",
            "pi.exe",
            &"a".repeat(33),
        ] {
            let mut value = valid();
            value["harnesses"]["pi"]["cli"]["program"] = serde_json::json!(program);
            assert!(parse_value(&value).is_err(), "{program:?}");
        }
        for label in ["", " Pi", "Pi ", "P\ni", "<b>Pi</b>", &"x".repeat(25)] {
            let mut value = valid();
            value["harnesses"]["pi"]["label"] = serde_json::json!(label);
            assert!(parse_value(&value).is_err(), "{label:?}");
        }
    }

    #[test]
    fn invalid_json_gives_an_error_not_a_panic() {
        assert!(parse("").is_err());
        assert!(parse("{").is_err());
        assert!(parse("[]").is_err());
    }
}
