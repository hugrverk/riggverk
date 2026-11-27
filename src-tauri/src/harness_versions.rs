//! The CLI versions each harness was checked with, from `metadata/harness-versions.json`: the one
//! source for all nine harnesses. Nothing here runs a CLI; the pages only show these versions,
//! and the light tier compares the minimum with the version its `--version` probe found.
use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;

use crate::agent_targets::HarnessId;
use crate::light_harness::version_numbers;

const REGISTRY: &str =
    include_str!("../../resources/default-workspace/metadata/harness-versions.json");

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Versions {
    /// The newest version the harness's paths were checked with on a real install.
    pub checked_version: Option<String>,
    /// The oldest version those paths hold for; `None` when no lower bound is known.
    pub min_version: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Registry {
    version: u32,
    harnesses: BTreeMap<String, Versions>,
}

fn parse(text: &str) -> Result<Registry, String> {
    let registry: Registry = serde_json::from_str(text).map_err(|e| e.to_string())?;
    if registry.version != 1 {
        return Err("unsupported registry version".into());
    }
    if registry.harnesses.len() != HarnessId::ALL.len()
        || HarnessId::ALL
            .iter()
            .any(|id| !registry.harnesses.contains_key(id.as_str()))
    {
        return Err("registry must contain exactly every harness id".into());
    }
    for (id, versions) in &registry.harnesses {
        let parse_version = |value: &Option<String>| {
            value
                .as_ref()
                .map(|v| version_numbers(v).ok_or_else(|| format!("{id}: invalid version")))
                .transpose()
        };
        let checked = parse_version(&versions.checked_version)?;
        let min = parse_version(&versions.min_version)?;
        if matches!((min, checked), (Some(min), Some(checked)) if min > checked) {
            return Err(format!("{id}: minimum exceeds checked version"));
        }
    }
    Ok(registry)
}

/// The versions recorded for `id`. The registry is embedded and a test validates it, so a
/// parse failure here is a build defect.
pub fn get(id: HarnessId) -> &'static Versions {
    static PARSED: OnceLock<Registry> = OnceLock::new();
    &PARSED
        .get_or_init(|| parse(REGISTRY).expect("invalid bundled harness versions"))
        .harnesses[id.as_str()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_registry_and_validation() {
        let registry = parse(REGISTRY).expect("bundled registry validates");
        assert_eq!(
            registry.harnesses["antigravity"].min_version.as_deref(),
            Some("1.5.15")
        );
        let base: serde_json::Value = serde_json::from_str(REGISTRY).unwrap();
        let mut cases = Vec::new();
        let mut v = base.clone();
        v["extra"] = true.into();
        cases.push(v);
        let mut v = base.clone();
        v["harnesses"]["pi"]["extra"] = true.into();
        cases.push(v);
        let mut v = base.clone();
        v["harnesses"].as_object_mut().unwrap().remove("pi");
        cases.push(v);
        let mut v = base.clone();
        v["harnesses"]["unknown"] = serde_json::json!({});
        cases.push(v);
        let mut v = base.clone();
        v["version"] = 2.into();
        cases.push(v);
        for bad in ["", "1.2", "1.2.3.4", "v1.2.3", "1.2.x", "1.2.3-beta"] {
            let mut v = base.clone();
            v["harnesses"]["pi"]["checked_version"] = bad.into();
            cases.push(v);
            let mut v = base.clone();
            v["harnesses"]["pi"]["min_version"] = bad.into();
            cases.push(v);
        }
        let mut v = base;
        v["harnesses"]["antigravity"]["min_version"] = "1.5.19".into();
        cases.push(v);
        for case in cases {
            assert!(parse(&case.to_string()).is_err(), "{case}");
        }
    }
}
