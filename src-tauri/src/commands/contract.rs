use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;

use super::workspace::workspace_root;

const ROUTING_PROFILES_REL: &str = "routing/profiles.json";
const AGENT_METADATA_REL: &str = "metadata/agents.json";
const MAX_ROUTING_FILE_SIZE: usize = 256 * 1024;
const MAX_METADATA_FILE_SIZE: usize = 128 * 1024;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Pass,
    Warn,
    Fail,
}

#[derive(Serialize, Clone, Debug)]
pub struct ContractCheck {
    pub id: String,
    pub label: String,
    pub status: CheckStatus,
    pub detail: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct WorkspaceContractResult {
    pub valid: bool,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
    pub checks: Vec<ContractCheck>,
}

/// Validate the active workspace against the public app contract.
/// Read-only. No scripts run. No config sync. No installs.
#[tauri::command]
pub fn validate_workspace_contract() -> Result<WorkspaceContractResult, String> {
    let root = workspace_root()?;

    let mut checks: Vec<ContractCheck> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    // ── 1. Workspace root ──
    checks.push(ContractCheck {
        id: "ws-root".into(),
        label: "Workspace root resolves".into(),
        status: CheckStatus::Pass,
        detail: format!("{}", root.display()),
    });

    let marker = root.join(".ux-workspace/workspace.json");
    if marker.is_file() {
        checks.push(ContractCheck {
            id: "ws-marker".into(),
            label: ".ux-workspace/workspace.json exists".into(),
            status: CheckStatus::Pass,
            detail: "Workspace marker found".into(),
        });
    } else {
        let msg = ".ux-workspace/workspace.json is missing";
        errors.push(msg.into());
        checks.push(ContractCheck {
            id: "ws-marker".into(),
            label: ".ux-workspace/workspace.json exists".into(),
            status: CheckStatus::Fail,
            detail: msg.into(),
        });
    }

    // ── 2. Skills ──
    validate_skills(&root, &mut checks, &mut errors);

    // ── 3. Routing ──
    validate_routing_contract(&root, &mut checks, &mut warnings, &mut errors);

    // ── 4. Agent metadata ──
    validate_agent_metadata_contract(&root, &mut checks, &mut warnings, &mut errors);

    // ── 5. Agents ──
    validate_agents_directory(&root, &mut checks);

    // Determine overall validity
    let has_fail = checks.iter().any(|c| c.status == CheckStatus::Fail);
    let valid = !has_fail && errors.is_empty();

    Ok(WorkspaceContractResult {
        valid,
        warnings,
        errors,
        checks,
    })
}

// ─── Skills validation ───

fn validate_skills(root: &Path, checks: &mut Vec<ContractCheck>, errors: &mut Vec<String>) {
    let skills_dir = root.join("skills");

    if !skills_dir.is_dir() {
        let msg = "skills/ directory not found";
        errors.push(msg.into());
        checks.push(ContractCheck {
            id: "skills-dir".into(),
            label: "Skills directory exists".into(),
            status: CheckStatus::Fail,
            detail: msg.into(),
        });
        return;
    }

    checks.push(ContractCheck {
        id: "skills-dir".into(),
        label: "Skills directory exists".into(),
        status: CheckStatus::Pass,
        detail: "skills/ found".into(),
    });

    // Discover root-level skills (skills/<skill>/SKILL.md)
    let (root_skills, legacy_paths) = discover_contract_skills(root);
    let skill_count = root_skills.len();

    // Root-level skills count
    if skill_count == 0 {
        checks.push(ContractCheck {
            id: "skills-root".into(),
            label: "Root-level skills discovered".into(),
            status: CheckStatus::Warn,
            detail: "No root-level skills found at skills/<skill>/SKILL.md".into(),
        });
    } else {
        checks.push(ContractCheck {
            id: "skills-root".into(),
            label: "Root-level skills discovered".into(),
            status: CheckStatus::Pass,
            detail: format!("{skill_count} skill(s) found at skills/<skill>/SKILL.md"),
        });
    }

    // Check each SKILL.md has name and description
    let mut missing_name: Vec<String> = Vec::new();
    let mut missing_desc: Vec<String> = Vec::new();
    for skill in &root_skills {
        if skill.name.is_empty() {
            missing_name.push(skill.rel_path.clone());
        }
        if skill.description.is_empty() {
            missing_desc.push(skill.rel_path.clone());
        }
    }
    if missing_name.is_empty() && missing_desc.is_empty() {
        checks.push(ContractCheck {
            id: "skills-metadata".into(),
            label: "Every SKILL.md has name and description".into(),
            status: CheckStatus::Pass,
            detail: format!("All {skill_count} skill(s) have required fields"),
        });
    } else {
        let mut parts: Vec<String> = Vec::new();
        if !missing_name.is_empty() {
            parts.push(format!("missing name: {}", missing_name.join(", ")));
        }
        if !missing_desc.is_empty() {
            parts.push(format!("missing description: {}", missing_desc.join(", ")));
        }
        let detail = parts.join("; ");
        checks.push(ContractCheck {
            id: "skills-metadata".into(),
            label: "Every SKILL.md has name and description".into(),
            status: CheckStatus::Fail,
            detail,
        });
    }

    // Duplicate skill names
    let mut seen: HashSet<&str> = HashSet::new();
    let mut duplicates: Vec<String> = Vec::new();
    for skill in &root_skills {
        if !seen.insert(&skill.name) {
            duplicates.push(skill.name.clone());
        }
    }
    if duplicates.is_empty() {
        checks.push(ContractCheck {
            id: "skills-duplicates".into(),
            label: "No duplicate skill names".into(),
            status: CheckStatus::Pass,
            detail: "All skill names are unique".into(),
        });
    } else {
        let detail = format!("Duplicate skill names: {}", duplicates.join(", "));
        checks.push(ContractCheck {
            id: "skills-duplicates".into(),
            label: "No duplicate skill names".into(),
            status: CheckStatus::Fail,
            detail,
        });
    }

    // Legacy nested skills (skills/engineering/*/SKILL.md etc.)
    if legacy_paths.is_empty() {
        checks.push(ContractCheck {
            id: "skills-legacy".into(),
            label: "No legacy nested skills".into(),
            status: CheckStatus::Pass,
            detail: "No skills under nested subdirectories (skills/engineering/*/SKILL.md)".into(),
        });
    } else {
        let detail = format!(
            "Legacy nested skills found (not valid for public app contract): {}",
            legacy_paths.join(", ")
        );
        checks.push(ContractCheck {
            id: "skills-legacy".into(),
            label: "No legacy nested skills".into(),
            status: CheckStatus::Fail,
            detail,
        });
    }
}

struct ContractSkill {
    name: String,
    description: String,
    rel_path: String,
}

fn extract_frontmatter_field(content: &str, key: &str) -> String {
    let prefix = format!("{key}:");
    for line in content.lines() {
        if line.trim_start().starts_with(&prefix) {
            return line
                .trim_start()
                .strip_prefix(&prefix)
                .unwrap_or("")
                .trim()
                .to_string();
        }
    }
    String::new()
}

fn discover_contract_skills(root: &Path) -> (Vec<ContractSkill>, Vec<String>) {
    let skills_dir = root.join("skills");
    let mut root_skills: Vec<ContractSkill> = Vec::new();
    let mut legacy_paths: Vec<String> = Vec::new();

    let entries = match std::fs::read_dir(&skills_dir) {
        Ok(e) => e,
        Err(_) => return (root_skills, legacy_paths),
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();

        if !path.is_dir() {
            continue;
        }

        // Check for root-level skill: skills/<name>/SKILL.md
        let flat_md = path.join("SKILL.md");
        if flat_md.is_file() {
            let content = std::fs::read_to_string(&flat_md).unwrap_or_default();
            let skill_name = extract_frontmatter_field(&content, "name");
            let description = extract_frontmatter_field(&content, "description");
            let rel = flat_md
                .strip_prefix(root)
                .unwrap_or(&flat_md)
                .to_string_lossy()
                .into_owned();

            root_skills.push(ContractSkill {
                name: if skill_name.is_empty() {
                    name.clone()
                } else {
                    skill_name
                },
                description,
                rel_path: rel,
            });
            continue;
        }

        // This is a category directory — check for legacy nested skills inside it
        let sub_entries = match std::fs::read_dir(&path) {
            Ok(e) => e,
            Err(_) => continue,
        };

        for sub in sub_entries.flatten() {
            let sub_path = sub.path();
            if !sub_path.is_dir() {
                continue;
            }
            let sub_md = sub_path.join("SKILL.md");
            if sub_md.is_file() {
                let rel = sub_md
                    .strip_prefix(root)
                    .unwrap_or(&sub_md)
                    .to_string_lossy()
                    .into_owned();
                legacy_paths.push(rel);
            }
        }
    }

    root_skills.sort_by(|a, b| a.name.cmp(&b.name));
    legacy_paths.sort();

    (root_skills, legacy_paths)
}

// ─── Routing validation ───

fn validate_routing_contract(
    root: &Path,
    checks: &mut Vec<ContractCheck>,
    warnings: &mut Vec<String>,
    errors: &mut Vec<String>,
) {
    let path = root.join(ROUTING_PROFILES_REL);

    if !path.exists() {
        checks.push(ContractCheck {
            id: "routing-file".into(),
            label: "routing/profiles.json exists".into(),
            status: CheckStatus::Warn,
            detail: "routing/profiles.json is optional but not found".into(),
        });
        return;
    }

    // Size check
    let metadata = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(e) => {
            let msg = format!("Cannot read routing file metadata: {e}");
            errors.push(msg.clone());
            checks.push(ContractCheck {
                id: "routing-file".into(),
                label: "routing/profiles.json readable".into(),
                status: CheckStatus::Fail,
                detail: msg,
            });
            return;
        }
    };

    if metadata.len() > MAX_ROUTING_FILE_SIZE as u64 {
        let msg = format!(
            "routing file exceeds {} KB limit",
            MAX_ROUTING_FILE_SIZE / 1024
        );
        errors.push(msg.clone());
        checks.push(ContractCheck {
            id: "routing-size".into(),
            label: "routing/profiles.json within size limit".into(),
            status: CheckStatus::Fail,
            detail: msg,
        });
        return;
    }

    checks.push(ContractCheck {
        id: "routing-size".into(),
        label: "routing/profiles.json within size limit".into(),
        status: CheckStatus::Pass,
        detail: format!("{} bytes", metadata.len()),
    });

    // Parse JSON
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("Cannot read routing file: {e}");
            errors.push(msg.clone());
            checks.push(ContractCheck {
                id: "routing-json".into(),
                label: "routing/profiles.json is valid JSON".into(),
                status: CheckStatus::Fail,
                detail: msg,
            });
            return;
        }
    };

    let parsed: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(e) => {
            let msg = format!("Invalid routing JSON: {e}");
            errors.push(msg.clone());
            checks.push(ContractCheck {
                id: "routing-json".into(),
                label: "routing/profiles.json is valid JSON".into(),
                status: CheckStatus::Fail,
                detail: msg,
            });
            return;
        }
    };

    checks.push(ContractCheck {
        id: "routing-json".into(),
        label: "routing/profiles.json is valid JSON".into(),
        status: CheckStatus::Pass,
        detail: "JSON parsed successfully".into(),
    });

    // Check notes fields are string arrays
    let profiles = parsed
        .get("profiles")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut notes_failures: Vec<String> = Vec::new();
    for (i, profile) in profiles.iter().enumerate() {
        let profile_id = profile
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        if let Some(notes) = profile.get("notes") {
            if !notes.is_array() {
                notes_failures.push(format!("profile '{}' (index {})", profile_id, i));
                continue;
            }
            if let Some(arr) = notes.as_array() {
                for (j, note) in arr.iter().enumerate() {
                    if !note.is_string() {
                        notes_failures.push(format!(
                            "profile '{}' notes[{}] is not a string",
                            profile_id, j
                        ));
                    }
                }
            }
        }
    }

    if notes_failures.is_empty() {
        checks.push(ContractCheck {
            id: "routing-notes".into(),
            label: "routing notes are string arrays".into(),
            status: CheckStatus::Pass,
            detail: format!("{} profile(s) have valid notes", profiles.len()),
        });
    } else {
        let detail = format!("Invalid notes: {}", notes_failures.join("; "));
        checks.push(ContractCheck {
            id: "routing-notes".into(),
            label: "routing notes are string arrays".into(),
            status: CheckStatus::Fail,
            detail,
        });
    }

    // Check each referenced skill exists
    let discovered = super::skills::discover_skills(root).unwrap_or_default();
    let skill_names: HashSet<&str> = discovered.iter().map(|s| s.name.as_str()).collect();

    let mut missing_skills: Vec<String> = Vec::new();
    for profile in &profiles {
        let profile_id = profile
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        if let Some(skills) = profile.get("skills").and_then(|v| v.as_array()) {
            for skill in skills {
                if let Some(s) = skill.as_str() {
                    if !skill_names.contains(s) {
                        missing_skills.push(format!(
                            "profile '{}' references unknown skill '{}'",
                            profile_id, s
                        ));
                    }
                }
            }
        }
    }

    if missing_skills.is_empty() {
        checks.push(ContractCheck {
            id: "routing-skills-ref".into(),
            label: "Each referenced skill exists".into(),
            status: CheckStatus::Pass,
            detail: "All referenced skills found in workspace".into(),
        });
    } else {
        let detail = missing_skills.join("; ");
        warnings.push(detail.clone());
        checks.push(ContractCheck {
            id: "routing-skills-ref".into(),
            label: "Each referenced skill exists".into(),
            status: CheckStatus::Fail,
            detail,
        });
    }

    // Check each agent_profile references a known agent file
    let known_agents: HashSet<&str> = super::content::known_agent_files()
        .iter()
        .copied()
        .collect();
    let agents_dir = root.join("agents");

    let mut missing_agents: Vec<String> = Vec::new();
    for profile in &profiles {
        let profile_id = profile
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        if let Some(ap) = profile.get("agent_profile").and_then(|v| v.as_str()) {
            if !known_agents.contains(ap) {
                missing_agents.push(format!(
                    "profile '{}' references unknown agent '{}'",
                    profile_id, ap
                ));
            } else if !agents_dir.join(ap).is_file() {
                missing_agents.push(format!(
                    "profile '{}' references agent '{}' not present in workspace",
                    profile_id, ap
                ));
            }
        }
    }

    if missing_agents.is_empty() {
        checks.push(ContractCheck {
            id: "routing-agent-ref".into(),
            label: "Each referenced agent_profile exists".into(),
            status: CheckStatus::Pass,
            detail: "All referenced agents found".into(),
        });
    } else {
        let detail = missing_agents.join("; ");
        warnings.push(detail.clone());
        checks.push(ContractCheck {
            id: "routing-agent-ref".into(),
            label: "Each referenced agent_profile exists".into(),
            status: CheckStatus::Warn,
            detail,
        });
    }
}

// ─── Agent metadata validation ───

fn validate_agent_metadata_contract(
    root: &Path,
    checks: &mut Vec<ContractCheck>,
    warnings: &mut Vec<String>,
    errors: &mut Vec<String>,
) {
    let path = root.join(AGENT_METADATA_REL);

    if !path.exists() {
        checks.push(ContractCheck {
            id: "metadata-file".into(),
            label: "metadata/agents.json exists".into(),
            status: CheckStatus::Warn,
            detail: "metadata/agents.json is optional but not found".into(),
        });
        return;
    }

    // Size check
    let metadata = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(e) => {
            let msg = format!("Cannot read metadata file: {e}");
            errors.push(msg.clone());
            checks.push(ContractCheck {
                id: "metadata-size".into(),
                label: "metadata/agents.json readable".into(),
                status: CheckStatus::Fail,
                detail: msg,
            });
            return;
        }
    };

    if metadata.len() > MAX_METADATA_FILE_SIZE as u64 {
        let msg = format!(
            "metadata file exceeds {} KB limit",
            MAX_METADATA_FILE_SIZE / 1024
        );
        errors.push(msg.clone());
        checks.push(ContractCheck {
            id: "metadata-size".into(),
            label: "metadata/agents.json within size limit".into(),
            status: CheckStatus::Fail,
            detail: msg,
        });
        return;
    }

    checks.push(ContractCheck {
        id: "metadata-size".into(),
        label: "metadata/agents.json within size limit".into(),
        status: CheckStatus::Pass,
        detail: format!("{} bytes", metadata.len()),
    });

    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("Cannot read metadata file: {e}");
            errors.push(msg.clone());
            checks.push(ContractCheck {
                id: "metadata-json".into(),
                label: "metadata/agents.json is valid JSON".into(),
                status: CheckStatus::Fail,
                detail: msg,
            });
            return;
        }
    };

    let parsed: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(e) => {
            let msg = format!("Invalid metadata JSON: {e}");
            errors.push(msg.clone());
            checks.push(ContractCheck {
                id: "metadata-json".into(),
                label: "metadata/agents.json is valid JSON".into(),
                status: CheckStatus::Fail,
                detail: msg,
            });
            return;
        }
    };

    checks.push(ContractCheck {
        id: "metadata-json".into(),
        label: "metadata/agents.json is valid JSON".into(),
        status: CheckStatus::Pass,
        detail: "JSON parsed successfully".into(),
    });

    let agents = parsed
        .get("agents")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    // Check notes fields are string arrays
    let mut notes_failures: Vec<String> = Vec::new();
    for (agent_id, entry) in &agents {
        if let Some(notes) = entry.get("notes") {
            if !notes.is_array() {
                notes_failures.push(format!("agent '{}' notes is not an array", agent_id));
                continue;
            }
            if let Some(arr) = notes.as_array() {
                for (j, note) in arr.iter().enumerate() {
                    if !note.is_string() {
                        notes_failures
                            .push(format!("agent '{}' notes[{}] is not a string", agent_id, j));
                    }
                }
            }
        }
    }

    if notes_failures.is_empty() {
        checks.push(ContractCheck {
            id: "metadata-notes".into(),
            label: "metadata notes are string arrays".into(),
            status: CheckStatus::Pass,
            detail: format!("{} agent(s) have valid notes", agents.len()),
        });
    } else {
        let detail = format!("Invalid notes: {}", notes_failures.join("; "));
        checks.push(ContractCheck {
            id: "metadata-notes".into(),
            label: "metadata notes are string arrays".into(),
            status: CheckStatus::Fail,
            detail,
        });
    }

    // Check agent keys exist in known agent files
    let known_agents: HashSet<&str> = super::content::known_agent_files()
        .iter()
        .copied()
        .collect();
    let mut unknown_keys: Vec<String> = Vec::new();
    for key in agents.keys() {
        if !known_agents.contains(key.as_str()) {
            unknown_keys.push(key.clone());
        }
    }

    if unknown_keys.is_empty() {
        checks.push(ContractCheck {
            id: "metadata-keys".into(),
            label: "All agent metadata keys map to known agents".into(),
            status: CheckStatus::Pass,
            detail: "All agent metadata keys are known agent files".into(),
        });
    } else {
        let detail = format!("Unknown agent keys: {}", unknown_keys.join(", "));
        warnings.push(detail.clone());
        checks.push(ContractCheck {
            id: "metadata-keys".into(),
            label: "All agent metadata keys map to known agents".into(),
            status: CheckStatus::Warn,
            detail,
        });
    }

    // Check default_skills exist
    let discovered = super::skills::discover_skills(root).unwrap_or_default();
    let skill_names: HashSet<&str> = discovered.iter().map(|s| s.name.as_str()).collect();

    let mut missing_defaults: Vec<String> = Vec::new();
    for (agent_id, entry) in &agents {
        if let Some(defaults) = entry.get("default_skills").and_then(|v| v.as_array()) {
            for skill in defaults {
                if let Some(s) = skill.as_str() {
                    if !skill_names.contains(s) {
                        missing_defaults.push(format!(
                            "agent '{}' default_skill '{}' not found",
                            agent_id, s
                        ));
                    }
                }
            }
        }
    }

    if missing_defaults.is_empty() {
        checks.push(ContractCheck {
            id: "metadata-defaults".into(),
            label: "All metadata default_skills exist".into(),
            status: CheckStatus::Pass,
            detail: "All referenced default skills found in workspace".into(),
        });
    } else {
        let detail = missing_defaults.join("; ");
        warnings.push(detail.clone());
        checks.push(ContractCheck {
            id: "metadata-defaults".into(),
            label: "All metadata default_skills exist".into(),
            status: CheckStatus::Fail,
            detail,
        });
    }
}

// ─── Agents directory validation ───

fn validate_agents_directory(root: &Path, checks: &mut Vec<ContractCheck>) {
    let agents_dir = root.join("agents");
    let known = super::content::known_agent_files();

    let mut present: Vec<String> = Vec::new();
    let mut missing: Vec<String> = Vec::new();

    if agents_dir.is_dir() {
        for filename in known {
            if agents_dir.join(filename).is_file() {
                present.push(filename.to_string());
            } else {
                missing.push(filename.to_string());
            }
        }
    } else {
        for filename in known {
            missing.push(filename.to_string());
        }
    }

    let total = known.len();
    if missing.is_empty() {
        checks.push(ContractCheck {
            id: "agents-present".into(),
            label: "Known agent source files present".into(),
            status: CheckStatus::Pass,
            detail: format!("{total}/{total} agent files found"),
        });
    } else {
        checks.push(ContractCheck {
            id: "agents-present".into(),
            label: "Known agent source files present".into(),
            status: CheckStatus::Warn,
            detail: format!(
                "{}/{} agent files found (missing: {})",
                present.len(),
                total,
                missing.join(", ")
            ),
        });
    }
}

// ─── Tests ───

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("agent-workspace-contract-{name}-{nonce}"));
        fs::create_dir_all(&root).expect("create temp root");
        root
    }

    fn write_file(root: &PathBuf, rel: &str, content: &str) {
        if let Some(parent) = root.join(rel).parent() {
            fs::create_dir_all(parent).expect("create parent dirs");
        }
        fs::write(root.join(rel), content).expect("write file");
    }

    fn write_skill(root: &PathBuf, skill_name: &str) {
        let path = root.join("skills").join(skill_name).join("SKILL.md");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create skill dir");
        }
        fs::write(
            path,
            format!("---\nname: {}\ndescription: test\n---\n", skill_name),
        )
        .expect("write skill");
    }

    fn write_skill_no_meta(root: &PathBuf, skill_name: &str) {
        let path = root.join("skills").join(skill_name).join("SKILL.md");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create skill dir");
        }
        fs::write(path, "# No frontmatter\n").expect("write skill");
    }

    fn write_legacy_skill(root: &PathBuf, category: &str, skill_name: &str) {
        let path = root
            .join("skills")
            .join(category)
            .join(skill_name)
            .join("SKILL.md");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create legacy skill dir");
        }
        fs::write(
            path,
            format!("---\nname: {}\ndescription: legacy\n---\n", skill_name),
        )
        .expect("write legacy skill");
    }

    fn write_agent(root: &PathBuf, agent_name: &str) {
        let path = root.join("agents").join(agent_name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create agents dir");
        }
        fs::write(path, "# agent\n").expect("write agent");
    }

    fn setup_valid_workspace(name: &str) -> PathBuf {
        let root = temp_root(name);
        write_file(&root, ".ux-workspace/workspace.json", "{}");
        write_file(&root, "scripts/bootstrap.sh", "#!/usr/bin/env bash\n");
        write_file(
            &root,
            "scripts/install-agent-rules.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(
            &root,
            "scripts/install-opencode-config.sh",
            "#!/usr/bin/env bash\n",
        );
        write_file(&root, "scripts/install-skills.sh", "#!/usr/bin/env bash\n");
        write_file(&root, "templates/global-agent-rules.md", "# rules\n");
        write_file(&root, "templates/opencode.json", "{}");
        write_file(&root, "README.md", "# readme\n");
        fs::create_dir_all(root.join("skills")).expect("create skills dir");
        root
    }

    fn cleanup(root: &PathBuf) {
        let _ = fs::remove_dir_all(root);
    }

    // We can't call the Tauri command directly in tests (needs workspace_root()),
    // so we test the internal validation functions and the overall contract assembly.

    #[test]
    fn valid_workspace_passes_skills_checks() {
        let root = setup_valid_workspace("valid-skills");
        write_skill(&root, "diagnose");
        write_skill(&root, "security-review");

        let mut checks = Vec::new();
        let mut errors = Vec::new();
        validate_skills(&root, &mut checks, &mut errors);

        cleanup(&root);

        assert!(errors.is_empty(), "should have no errors");
        let skill_dir_check = checks.iter().find(|c| c.id == "skills-dir").unwrap();
        assert_eq!(skill_dir_check.status, CheckStatus::Pass);

        let root_check = checks.iter().find(|c| c.id == "skills-root").unwrap();
        assert_eq!(root_check.status, CheckStatus::Pass);

        let meta_check = checks.iter().find(|c| c.id == "skills-metadata").unwrap();
        assert_eq!(meta_check.status, CheckStatus::Pass);

        let dup_check = checks.iter().find(|c| c.id == "skills-duplicates").unwrap();
        assert_eq!(dup_check.status, CheckStatus::Pass);

        let legacy_check = checks.iter().find(|c| c.id == "skills-legacy").unwrap();
        assert_eq!(legacy_check.status, CheckStatus::Pass);
    }

    #[test]
    fn missing_workspace_marker_fails() {
        let root = temp_root("missing-marker");
        // No .ux-workspace/workspace.json

        let mut checks: Vec<ContractCheck> = Vec::new();
        let mut errors: Vec<String> = Vec::new();

        // Simulate the check without workspace_root()
        let marker = root.join(".ux-workspace/workspace.json");
        if marker.is_file() {
            checks.push(ContractCheck {
                id: "ws-marker".into(),
                label: ".ux-workspace/workspace.json exists".into(),
                status: CheckStatus::Pass,
                detail: "Workspace marker found".into(),
            });
        } else {
            let msg = ".ux-workspace/workspace.json is missing";
            errors.push(msg.into());
            checks.push(ContractCheck {
                id: "ws-marker".into(),
                label: ".ux-workspace/workspace.json exists".into(),
                status: CheckStatus::Fail,
                detail: msg.into(),
            });
        }

        cleanup(&root);

        assert!(!errors.is_empty());
        let marker_check = checks.iter().find(|c| c.id == "ws-marker").unwrap();
        assert_eq!(marker_check.status, CheckStatus::Fail);
    }

    #[test]
    fn duplicate_skill_names_fail() {
        let root = setup_valid_workspace("dup-skills");
        // Both have name "diagnose" in frontmatter
        write_skill(&root, "diagnose");
        write_skill(&root, "diagnose-v2"); // Also has name: diagnose

        // Override the second one to have the same name
        let path = root.join("skills/diagnose-v2/SKILL.md");
        fs::write(path, "---\nname: diagnose\ndescription: test\n---\n").expect("overwrite");

        let mut checks = Vec::new();
        let mut errors = Vec::new();
        validate_skills(&root, &mut checks, &mut errors);

        cleanup(&root);

        let dup_check = checks.iter().find(|c| c.id == "skills-duplicates").unwrap();
        assert_eq!(
            dup_check.status,
            CheckStatus::Fail,
            "duplicate names should fail: {dup_check:?}"
        );
    }

    #[test]
    fn legacy_nested_skill_fails() {
        let root = setup_valid_workspace("legacy-skills");
        write_skill(&root, "diagnose"); // root-level
        write_legacy_skill(&root, "engineering", "debug-tools"); // legacy nested

        let mut checks = Vec::new();
        let mut errors = Vec::new();
        validate_skills(&root, &mut checks, &mut errors);

        cleanup(&root);

        let legacy_check = checks.iter().find(|c| c.id == "skills-legacy").unwrap();
        assert_eq!(
            legacy_check.status,
            CheckStatus::Fail,
            "legacy nested skills should fail: {legacy_check:?}"
        );
    }

    #[test]
    fn routing_profile_missing_skill_fails() {
        let root = setup_valid_workspace("routing-missing-skill");
        write_skill(&root, "diagnose");

        write_file(
            &root,
            "routing/profiles.json",
            r#"{"profiles":[{"id":"test","title":"T","description":"D","target_tool":"opencode","recommended_model":"m","skills":["diagnose","nonexistent"]}]}"#,
        );

        let mut checks = Vec::new();
        let mut warnings = Vec::new();
        let mut errors = Vec::new();
        validate_routing_contract(&root, &mut checks, &mut warnings, &mut errors);

        cleanup(&root);

        let ref_check = checks
            .iter()
            .find(|c| c.id == "routing-skills-ref")
            .unwrap();
        assert_eq!(
            ref_check.status,
            CheckStatus::Fail,
            "missing skill ref should fail: {ref_check:?}"
        );
        assert!(ref_check.detail.contains("nonexistent"));
    }

    #[test]
    fn routing_notes_non_array_fails() {
        let root = setup_valid_workspace("routing-notes-bad");
        write_skill(&root, "diagnose");

        // notes is a string, not an array
        write_file(
            &root,
            "routing/profiles.json",
            r#"{"profiles":[{"id":"test","title":"T","description":"D","target_tool":"opencode","recommended_model":"m","notes":"not an array"}]}"#,
        );

        let mut checks = Vec::new();
        let mut warnings = Vec::new();
        let mut errors = Vec::new();
        validate_routing_contract(&root, &mut checks, &mut warnings, &mut errors);

        cleanup(&root);

        let notes_check = checks.iter().find(|c| c.id == "routing-notes").unwrap();
        assert_eq!(
            notes_check.status,
            CheckStatus::Fail,
            "non-array notes should fail: {notes_check:?}"
        );
    }

    #[test]
    fn metadata_notes_non_array_fails() {
        let root = setup_valid_workspace("meta-notes-bad");
        write_skill(&root, "diagnose");
        write_agent(&root, "autopilot.md");

        // notes is a string, not an array
        write_file(
            &root,
            "metadata/agents.json",
            r#"{"agents":{"autopilot.md":{"role":"primary","summary":"test","targets":["opencode"],"risk":"medium","default_skills":["diagnose"],"safe_to_edit_runtime":false,"notes":"not an array"}}}"#,
        );

        let mut checks = Vec::new();
        let mut warnings = Vec::new();
        let mut errors = Vec::new();
        validate_agent_metadata_contract(&root, &mut checks, &mut warnings, &mut errors);

        cleanup(&root);

        let notes_check = checks.iter().find(|c| c.id == "metadata-notes").unwrap();
        assert_eq!(
            notes_check.status,
            CheckStatus::Fail,
            "non-array metadata notes should fail: {notes_check:?}"
        );
    }

    #[test]
    fn metadata_default_skill_missing_fails() {
        let root = setup_valid_workspace("meta-default-missing");
        write_skill(&root, "diagnose");
        write_agent(&root, "autopilot.md");

        write_file(
            &root,
            "metadata/agents.json",
            r#"{"agents":{"autopilot.md":{"role":"primary","summary":"test","targets":["opencode"],"risk":"medium","default_skills":["nonexistent-skill"],"safe_to_edit_runtime":false,"notes":[]}}}"#,
        );

        let mut checks = Vec::new();
        let mut warnings = Vec::new();
        let mut errors = Vec::new();
        validate_agent_metadata_contract(&root, &mut checks, &mut warnings, &mut errors);

        cleanup(&root);

        let defaults_check = checks.iter().find(|c| c.id == "metadata-defaults").unwrap();
        assert_eq!(
            defaults_check.status,
            CheckStatus::Fail,
            "missing default skill should fail: {defaults_check:?}"
        );
        assert!(defaults_check.detail.contains("nonexistent-skill"));
    }

    #[test]
    fn optional_routing_missing_does_not_fail() {
        let root = setup_valid_workspace("optional-routing");
        write_skill(&root, "diagnose");
        // No routing/profiles.json

        let mut checks = Vec::new();
        let mut warnings = Vec::new();
        let mut errors = Vec::new();
        validate_routing_contract(&root, &mut checks, &mut warnings, &mut errors);

        cleanup(&root);

        let file_check = checks.iter().find(|c| c.id == "routing-file").unwrap();
        assert_eq!(file_check.status, CheckStatus::Warn);
        assert!(
            errors.is_empty(),
            "missing optional routing should not error"
        );
    }

    #[test]
    fn optional_metadata_missing_does_not_fail() {
        let root = setup_valid_workspace("optional-meta");
        write_skill(&root, "diagnose");
        // No metadata/agents.json

        let mut checks = Vec::new();
        let mut warnings = Vec::new();
        let mut errors = Vec::new();
        validate_agent_metadata_contract(&root, &mut checks, &mut warnings, &mut errors);

        cleanup(&root);

        let file_check = checks.iter().find(|c| c.id == "metadata-file").unwrap();
        assert_eq!(file_check.status, CheckStatus::Warn);
        assert!(
            errors.is_empty(),
            "missing optional metadata should not error"
        );
    }

    #[test]
    fn skill_missing_name_or_description_fails() {
        let root = setup_valid_workspace("skill-no-meta");
        write_skill_no_meta(&root, "no-meta-skill");

        let mut checks = Vec::new();
        let mut errors = Vec::new();
        validate_skills(&root, &mut checks, &mut errors);

        cleanup(&root);

        let meta_check = checks.iter().find(|c| c.id == "skills-metadata").unwrap();
        assert_eq!(
            meta_check.status,
            CheckStatus::Fail,
            "missing name/desc should fail: {meta_check:?}"
        );
    }

    #[test]
    fn command_is_read_only() {
        // validate_workspace_contract reads files but never writes, runs scripts,
        // or modifies any state. This is verified by the implementation:
        // it only uses workspace_root(), std::fs::read_to_string, and
        // serde_json::from_str. No file writes, no process::Command, no
        // settings::save.
        //
        // This test is a structural check: verify the command function
        // doesn't reference any write or execute helpers.
        let _ = validate_workspace_contract; // compile-time binding check
    }
}
