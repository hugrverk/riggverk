use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use super::process::ActionResult;
use super::workspace::workspace_root;

const ROUTING_PROFILES_PATH: &str = "routing/profiles.json";
const MAX_ROUTING_FILE_SIZE: usize = 256 * 1024;

const VALID_TARGET_TOOLS: &[&str] = &["codex", "opencode", "claude", "gemini", "auggie"];
const VALID_RISK_VALUES: &[&str] = &["low", "medium", "high"];
const VALID_DB_MIGRATION_VALUES: &[&str] = &["NO", "YES", "POSSIBLE"];

#[derive(Serialize, Clone, Debug)]
pub struct RoutingProfile {
    pub id: String,
    pub title: String,
    pub description: String,
    pub target_tool: String,
    pub recommended_model: String,
    pub db_migration: String,
    pub risk: String,
    pub skills: Vec<String>,
    pub agent_profile: Option<String>,
    pub notes: Vec<String>,
    pub missing_skills: Vec<String>,
    pub missing_agent: bool,
}

#[derive(Serialize, Debug)]
pub struct RoutingProfilesResponse {
    pub exists: bool,
    pub path: String,
    pub profiles: Vec<RoutingProfile>,
    pub warnings: Vec<String>,
}

#[derive(Deserialize)]
struct RawProfile {
    id: String,
    title: String,
    description: String,
    target_tool: String,
    recommended_model: String,
    #[serde(default = "default_no")]
    db_migration: String,
    #[serde(default = "default_medium")]
    risk: String,
    #[serde(default)]
    skills: Vec<String>,
    agent_profile: Option<String>,
    #[serde(default)]
    notes: Vec<String>,
}

fn default_no() -> String {
    "NO".into()
}

fn default_medium() -> String {
    "medium".into()
}

#[derive(Deserialize)]
struct RawProfilesFile {
    #[serde(default)]
    profiles: Vec<RawProfile>,
}

fn load_skill_summaries(root: &Path) -> Vec<super::skills::SkillSummary> {
    super::skills::discover_skills(root).unwrap_or_default()
}

fn load_agent_filenames(root: &Path) -> Vec<String> {
    let agents_dir = root.join("agents");
    if !agents_dir.is_dir() {
        return Vec::new();
    }
    let known = super::content::known_agent_files();
    let mut results: Vec<String> = Vec::new();
    for filename in known {
        if agents_dir.join(filename).is_file() {
            results.push(filename.to_string());
        }
    }
    results
}

fn validate_profiles(
    profiles: &[RawProfile],
    skill_summaries: &[super::skills::SkillSummary],
    agent_filenames: &[String],
) -> (Vec<RoutingProfile>, Vec<String>) {
    let mut warnings: Vec<String> = Vec::new();
    let mut seen_ids: HashSet<&str> = HashSet::new();

    let skill_names: Vec<String> = skill_summaries.iter().map(|s| s.name.clone()).collect();

    for raw in profiles {
        // Duplicate profile id warning
        if !seen_ids.insert(&raw.id) {
            warnings.push(format!("duplicate profile id '{}'", raw.id));
        }

        // Risk enum validation
        if !VALID_RISK_VALUES.contains(&raw.risk.as_str()) {
            warnings.push(format!(
                "profile '{}' has invalid risk '{}' (expected: low, medium, high)",
                raw.id, raw.risk
            ));
        }

        // DB/migration enum validation
        if !VALID_DB_MIGRATION_VALUES.contains(&raw.db_migration.as_str()) {
            warnings.push(format!(
                "profile '{}' has invalid db_migration '{}' (expected: NO, YES, POSSIBLE)",
                raw.id, raw.db_migration
            ));
        }

        // Target tool validation
        if !VALID_TARGET_TOOLS.contains(&raw.target_tool.as_str()) {
            warnings.push(format!(
                "profile '{}' has unknown target_tool '{}' (expected: codex, opencode, claude, gemini, auggie)",
                raw.id, raw.target_tool
            ));
        }

        // Target/model mismatch warnings
        if raw.target_tool == "opencode"
            && (raw.recommended_model.starts_with("GPT")
                || raw.recommended_model.starts_with("gpt"))
        {
            warnings.push(format!(
                "profile '{}' targets opencode but recommended_model '{}' looks like a GPT tier (expected OpenCode model id, e.g. opencode-go/deepseek-v4-pro)",
                raw.id, raw.recommended_model
            ));
        }
        if raw.target_tool == "codex" && raw.recommended_model.contains("opencode-go/") {
            warnings.push(format!(
                "profile '{}' targets codex but recommended_model '{}' looks like an OpenCode model id",
                raw.id, raw.recommended_model
            ));
        }

        // Target tool vs skill targets compatibility
        if VALID_TARGET_TOOLS.contains(&raw.target_tool.as_str()) {
            for skill_name in &raw.skills {
                if let Some(skill) = skill_summaries.iter().find(|s| &s.name == skill_name) {
                    if !skill.targets.is_empty() && !skill.targets.contains(&raw.target_tool) {
                        let warn = format!(
                            "profile '{}' targets '{}' but skill '{}' targets only [{}]",
                            raw.id,
                            raw.target_tool,
                            skill_name,
                            skill.targets.join(", ")
                        );
                        if !warnings.contains(&warn) {
                            warnings.push(warn);
                        }
                    }
                }
            }
        }

        // Profile risk vs skill risk mismatch
        if raw.risk == "low" {
            for skill_name in &raw.skills {
                if let Some(skill) = skill_summaries.iter().find(|s| &s.name == skill_name) {
                    if skill.risk == "high" {
                        let warn = format!(
                            "profile '{}' has risk 'low' but references high-risk skill '{}'",
                            raw.id, skill_name
                        );
                        if !warnings.contains(&warn) {
                            warnings.push(warn);
                        }
                    }
                }
            }
        }
    }

    let mut results: Vec<RoutingProfile> = Vec::new();

    for raw in profiles {
        let mut missing_skills: Vec<String> = Vec::new();
        for skill in &raw.skills {
            if !skill_names.iter().any(|s| s == skill) {
                missing_skills.push(skill.clone());
                let warn = format!(
                    "profile '{}' references unknown skill '{}'",
                    raw.id, skill
                );
                if !warnings.contains(&warn) {
                    warnings.push(warn);
                }
            }
        }

        let mut missing_agent = false;
        if let Some(ref agent) = raw.agent_profile {
            if !agent_filenames.iter().any(|a| a == agent) {
                missing_agent = true;
                warnings.push(format!(
                    "profile '{}' references unknown agent file '{}'",
                    raw.id, agent
                ));
            }
        }

        results.push(RoutingProfile {
            id: raw.id.clone(),
            title: raw.title.clone(),
            description: raw.description.clone(),
            target_tool: raw.target_tool.clone(),
            recommended_model: raw.recommended_model.clone(),
            db_migration: raw.db_migration.clone(),
            risk: raw.risk.clone(),
            skills: raw.skills.clone(),
            agent_profile: raw.agent_profile.clone(),
            notes: raw.notes.clone(),
            missing_skills,
            missing_agent,
        });
    }

    (results, warnings)
}

#[tauri::command]
pub fn get_routing_profiles() -> Result<RoutingProfilesResponse, String> {
    let root = workspace_root()?;
    let rel = ROUTING_PROFILES_PATH;
    let path = root.join(rel);

    if !path.exists() {
        return Ok(RoutingProfilesResponse {
            exists: false,
            path: rel.to_string(),
            profiles: vec![],
            warnings: vec![format!(
                "routing profiles file not found at {}",
                rel
            )],
        });
    }

    // Defense-in-depth: verify path remains under workspace root
    super::content::safe_canonical_target(&root, &path)
        .map_err(|e| format!("routing file path rejected: {}", e))?;

    let metadata = std::fs::metadata(&path)
        .map_err(|e| format!("cannot read routing file metadata: {}", e))?;
    if metadata.len() > MAX_ROUTING_FILE_SIZE as u64 {
        return Err(format!(
            "routing file exceeds {} KB limit",
            MAX_ROUTING_FILE_SIZE / 1024
        ));
    }

    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("cannot read routing file: {}", e))?;

    let raw: RawProfilesFile =
        serde_json::from_str(&content).map_err(|e| format!("invalid routing JSON: {}", e))?;

    let skill_summaries = load_skill_summaries(&root);
    let agent_filenames = load_agent_filenames(&root);

    let (profiles, warnings) = validate_profiles(&raw.profiles, &skill_summaries, &agent_filenames);

    let resolved_path = path.to_string_lossy().into_owned();

    Ok(RoutingProfilesResponse {
        exists: true,
        path: resolved_path,
        profiles,
        warnings,
    })
}

#[tauri::command]
pub fn read_routing_profiles_file() -> Result<String, String> {
    let root = workspace_root()?;
    let path = root.join(ROUTING_PROFILES_PATH);

    if !path.exists() {
        return Ok(String::new());
    }

    super::content::safe_canonical_target(&root, &path)
        .map_err(|e| format!("routing file path rejected: {}", e))?;

    std::fs::read_to_string(&path).map_err(|e| format!("cannot read routing file: {}", e))
}

fn routing_backup_path(target_path: &Path) -> Result<std::path::PathBuf, String> {
    let backup_root = super::backups::backup_root()?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock error".to_string())?
        .as_nanos();
    let file_name = target_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "invalid target file name".to_string())?;
    let backup_dir = backup_root
        .join("routing")
        .join(format!("{}-{}", file_name, timestamp));
    std::fs::create_dir_all(&backup_dir)
        .map_err(|e| format!("create backup dir error: {}", e))?;
    Ok(backup_dir.join(file_name))
}

#[tauri::command]
pub fn save_routing_profiles(content: String) -> Result<ActionResult, String> {
    let root = workspace_root()?;
    save_routing_profiles_inner(&root, &content)
}

fn save_routing_profiles_inner(root: &Path, content: &str) -> Result<ActionResult, String> {
    if content.len() > MAX_ROUTING_FILE_SIZE {
        return Err(format!(
            "content exceeds {} KB limit",
            MAX_ROUTING_FILE_SIZE / 1024
        ));
    }

    // Validate JSON before writing
    serde_json::from_str::<RawProfilesFile>(content)
        .map_err(|e| format!("invalid routing JSON: {}", e))?;

    let path = root.join(ROUTING_PROFILES_PATH);

    super::content::safe_canonical_target(root, &path)
        .map_err(|e| format!("routing file path rejected: {}", e))?;

    // Ensure routing/ directory exists under workspace root
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create routing dir error: {}", e))?;
    }

    if path.exists() {
        let existing =
            std::fs::read_to_string(&path).map_err(|e| format!("read error: {}", e))?;
        if existing == content {
            return Ok(ActionResult::new(
                true,
                "save_routing_profiles",
                "unchanged".to_string(),
                String::new(),
                Some(0),
            ));
        }

        let backup_path = routing_backup_path(&path)?;
        std::fs::write(&backup_path, &existing)
            .map_err(|e| format!("backup write error: {}", e))?;

        std::fs::write(&path, content).map_err(|e| format!("write error: {}", e))?;

        return Ok(ActionResult::new(
            true,
            "save_routing_profiles",
            "saved with backup".to_string(),
            String::new(),
            Some(0),
        ));
    }

    // File does not exist — create it after validation
    std::fs::write(&path, content).map_err(|e| format!("write error: {}", e))?;

    Ok(ActionResult::new(
        true,
        "save_routing_profiles",
        "created".to_string(),
        String::new(),
        Some(0),
    ))
}

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
        let root = std::env::temp_dir().join(format!("ux-workspace-app-routing-{name}-{nonce}"));
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
            format!(
                "---\nname: {}\ndescription: test\n---\n",
                skill_name
            ),
        )
        .expect("write skill");
    }

    fn write_skill_with_targets(
        root: &PathBuf,
        skill_name: &str,
        targets: &str,
        risk: &str,
    ) {
        let path = root.join("skills").join(skill_name).join("SKILL.md");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create skill dir");
        }
        fs::write(
            path,
            format!(
                "---\nname: {}\ndescription: test\ntargets: {}\nrisk: {}\n---\n",
                skill_name, targets, risk
            ),
        )
        .expect("write skill with metadata");
    }

    fn write_agent(root: &PathBuf, agent_name: &str) {
        let path = root.join("agents").join(agent_name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create agents dir");
        }
        fs::write(path, "# agent\n").expect("write agent");
    }

    fn cleanup(root: &PathBuf) {
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn missing_file_returns_exists_false() {
        let root = temp_root("missing-file");

        let response =
            read_profiles_at_root(&root).expect("should succeed");
        cleanup(&root);

        assert!(!response.exists);
        assert!(response.profiles.is_empty());
        assert!(!response.warnings.is_empty());
        assert!(response
            .warnings
            .iter()
            .any(|w| w.contains("not found")));
    }

    #[test]
    fn valid_profiles_parse_and_validate() {
        let root = temp_root("valid-profiles");
        write_skill(&root, "diagnose");
        write_skill(&root, "security-review");
        write_skill(&root, "frontend-design");
        write_agent(&root, "autopilot.md");

        let json = r#"{
  "profiles": [
    {
      "id": "bug-diagnosis",
      "title": "Bug Diagnosis",
      "description": "Debug and fix bugs",
      "target_tool": "opencode",
      "recommended_model": "opencode-go/deepseek-v4-pro",
      "risk": "medium",
      "skills": ["diagnose", "security-review"]
    },
    {
      "id": "frontend-ui",
      "title": "Frontend UI",
      "description": "Frontend design work",
      "target_tool": "codex",
      "recommended_model": "GPT-5.5 Medium",
      "risk": "low",
      "skills": ["frontend-design"],
      "agent_profile": "autopilot.md"
    }
  ]
}"#;
        write_file(&root, "routing/profiles.json", json);

        let response = read_profiles_at_root(&root).expect("should succeed");
        cleanup(&root);

        assert!(response.exists);
        assert_eq!(response.profiles.len(), 2);

        let first = &response.profiles[0];
        assert_eq!(first.id, "bug-diagnosis");
        assert_eq!(first.skills.len(), 2);
        assert!(first.missing_skills.is_empty());
        assert!(!first.missing_agent);
        assert!(first.agent_profile.is_none());

        let second = &response.profiles[1];
        assert_eq!(second.id, "frontend-ui");
        assert_eq!(second.agent_profile.as_deref(), Some("autopilot.md"));
        assert!(!second.missing_agent);
        assert!(second.missing_skills.is_empty());
    }

    #[test]
    fn missing_skill_references_produce_warnings() {
        let root = temp_root("missing-skills");
        write_skill(&root, "diagnose");

        let json = r#"{
  "profiles": [
    {
      "id": "test",
      "title": "Test",
      "description": "Test",
      "target_tool": "opencode",
      "recommended_model": "GPT-5",
      "skills": ["diagnose", "nonexistent-skill", "another-missing"]
    }
  ]
}"#;
        write_file(&root, "routing/profiles.json", json);

        let response = read_profiles_at_root(&root).expect("should succeed");
        cleanup(&root);

        assert!(response.exists);
        let profile = &response.profiles[0];
        assert_eq!(profile.missing_skills.len(), 2);
        assert!(profile.missing_skills.contains(&"nonexistent-skill".to_string()));
        assert!(profile.missing_skills.contains(&"another-missing".to_string()));
        assert!(response.warnings.iter().any(|w| w.contains("nonexistent-skill")));
    }

    #[test]
    fn missing_agent_profile_produces_warning() {
        let root = temp_root("missing-agent");
        write_agent(&root, "autopilot.md");

        let json = r#"{
  "profiles": [
    {
      "id": "test",
      "title": "Test",
      "description": "Test",
      "target_tool": "opencode",
      "recommended_model": "GPT-5",
      "skills": [],
      "agent_profile": "nonexistent-agent.md"
    }
  ]
}"#;
        write_file(&root, "routing/profiles.json", json);

        let response = read_profiles_at_root(&root).expect("should succeed");
        cleanup(&root);

        assert!(response.exists);
        let profile = &response.profiles[0];
        assert!(profile.missing_agent);
        assert!(response.warnings.iter().any(|w| w.contains("nonexistent-agent.md")));
    }

    #[test]
    fn invalid_json_is_rejected() {
        let root = temp_root("invalid-json");
        write_file(&root, "routing/profiles.json", "this is not json");

        let result = read_profiles_at_root(&root);
        cleanup(&root);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid routing JSON"));
    }

    #[test]
    fn empty_profiles_array_is_valid() {
        let root = temp_root("empty-profiles");
        write_skill(&root, "diagnose");
        write_file(&root, "routing/profiles.json", "{\"profiles\": []}");

        let response = read_profiles_at_root(&root).expect("should succeed");
        cleanup(&root);

        assert!(response.exists);
        assert!(response.profiles.is_empty());
        assert!(response.warnings.is_empty());
    }

    #[test]
    fn defaults_for_missing_fields() {
        let root = temp_root("defaults");
        write_skill(&root, "diagnose");

        let json = r#"{
  "profiles": [
    {
      "id": "minimal",
      "title": "Minimal",
      "description": "Minimal profile",
      "target_tool": "opencode",
      "recommended_model": "GPT-5"
    }
  ]
}"#;
        write_file(&root, "routing/profiles.json", json);

        let response = read_profiles_at_root(&root).expect("should succeed");
        cleanup(&root);

        let profile = &response.profiles[0];
        assert_eq!(profile.db_migration, "NO");
        assert_eq!(profile.risk, "medium");
        assert!(profile.skills.is_empty());
        assert!(profile.agent_profile.is_none());
        assert!(profile.notes.is_empty());
    }

    #[test]
    fn oversized_file_rejected() {
        let root = temp_root("oversized");
        let big_content = format!("{{\"profiles\":[{}]}}", "x".repeat(MAX_ROUTING_FILE_SIZE));
        write_file(&root, "routing/profiles.json", &big_content);

        let result = read_profiles_at_root(&root);
        cleanup(&root);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("exceeds"));
    }

    #[test]
    fn duplicate_profile_ids_produce_warning() {
        let root = temp_root("dup-ids");
        write_skill(&root, "diagnose");

        let json = r#"{
  "profiles": [
    {"id": "test", "title": "T1", "description": "D1", "target_tool": "opencode", "recommended_model": "m1"},
    {"id": "test", "title": "T2", "description": "D2", "target_tool": "opencode", "recommended_model": "m2"}
  ]
}"#;
        write_file(&root, "routing/profiles.json", json);

        let response = read_profiles_at_root(&root).expect("should succeed");
        cleanup(&root);

        assert_eq!(response.profiles.len(), 2);
        assert!(response.warnings.iter().any(|w| w.contains("duplicate profile id")));
    }

    #[test]
    fn invalid_risk_value_produces_warning() {
        let root = temp_root("bad-risk");
        write_skill(&root, "diagnose");

        let json = r#"{
  "profiles": [
    {"id": "test", "title": "T", "description": "D", "target_tool": "opencode", "recommended_model": "m", "risk": "critical"}
  ]
}"#;
        write_file(&root, "routing/profiles.json", json);

        let response = read_profiles_at_root(&root).expect("should succeed");
        cleanup(&root);

        assert!(response.warnings.iter().any(|w| w.contains("invalid risk")));
    }

    #[test]
    fn invalid_db_migration_produces_warning() {
        let root = temp_root("bad-db");
        write_skill(&root, "diagnose");

        let json = r#"{
  "profiles": [
    {"id": "test", "title": "T", "description": "D", "target_tool": "opencode", "recommended_model": "m", "db_migration": "MAYBE"}
  ]
}"#;
        write_file(&root, "routing/profiles.json", json);

        let response = read_profiles_at_root(&root).expect("should succeed");
        cleanup(&root);

        assert!(response.warnings.iter().any(|w| w.contains("invalid db_migration")));
    }

    #[test]
    fn unknown_target_tool_produces_warning() {
        let root = temp_root("bad-tool");
        write_skill(&root, "diagnose");

        let json = r#"{
  "profiles": [
    {"id": "test", "title": "T", "description": "D", "target_tool": "foobar", "recommended_model": "m"}
  ]
}"#;
        write_file(&root, "routing/profiles.json", json);

        let response = read_profiles_at_root(&root).expect("should succeed");
        cleanup(&root);

        assert!(response.warnings.iter().any(|w| w.contains("unknown target_tool")));
    }

    #[test]
    fn opencode_target_with_gpt_model_produces_warning() {
        let root = temp_root("oc-gpt");
        write_skill(&root, "diagnose");

        let json = r#"{
  "profiles": [
    {"id": "test", "title": "T", "description": "D", "target_tool": "opencode", "recommended_model": "GPT-5.5 Medium"}
  ]
}"#;
        write_file(&root, "routing/profiles.json", json);

        let response = read_profiles_at_root(&root).expect("should succeed");
        cleanup(&root);

        assert!(response.warnings.iter().any(|w| w.contains("GPT")));
    }

    #[test]
    fn codex_target_with_opencode_model_produces_warning() {
        let root = temp_root("cx-oc");
        write_skill(&root, "diagnose");

        let json = r#"{
  "profiles": [
    {"id": "test", "title": "T", "description": "D", "target_tool": "codex", "recommended_model": "opencode-go/deepseek-v4-pro"}
  ]
}"#;
        write_file(&root, "routing/profiles.json", json);

        let response = read_profiles_at_root(&root).expect("should succeed");
        cleanup(&root);

        assert!(response.warnings.iter().any(|w| w.contains("OpenCode model id")));
    }

    #[test]
    fn valid_enum_values_produce_no_enum_warnings() {
        let root = temp_root("valid-enums");
        write_skill(&root, "diagnose");
        write_agent(&root, "autopilot.md");

        let json = r#"{
  "profiles": [
    {"id": "t1", "title": "T1", "description": "D", "target_tool": "opencode", "recommended_model": "opencode-go/deepseek-v4-pro", "risk": "low", "db_migration": "NO"},
    {"id": "t2", "title": "T2", "description": "D", "target_tool": "codex", "recommended_model": "GPT-5.5 Medium", "risk": "medium", "db_migration": "YES"},
    {"id": "t3", "title": "T3", "description": "D", "target_tool": "claude", "recommended_model": "Claude Sonnet", "risk": "high", "db_migration": "POSSIBLE"}
  ]
}"#;
        write_file(&root, "routing/profiles.json", json);

        let response = read_profiles_at_root(&root).expect("should succeed");
        cleanup(&root);

        let has_enum_warning = response.warnings.iter().any(|w| {
            w.contains("invalid risk")
                || w.contains("invalid db_migration")
                || w.contains("unknown target_tool")
                || w.contains("GPT")
                || w.contains("OpenCode model id")
        });
        assert!(!has_enum_warning, "valid enum values should not produce warnings");
    }

    fn read_profiles_at_root(root: &PathBuf) -> Result<RoutingProfilesResponse, String> {
        let rel = ROUTING_PROFILES_PATH;
        let path = root.join(rel);

        if !path.exists() {
            return Ok(RoutingProfilesResponse {
                exists: false,
                path: rel.to_string(),
                profiles: vec![],
                warnings: vec![format!("routing profiles file not found at {}", rel)],
            });
        }

        let metadata =
            std::fs::metadata(&path).map_err(|e| format!("cannot read routing file metadata: {}", e))?;
        if metadata.len() > MAX_ROUTING_FILE_SIZE as u64 {
            return Err(format!(
                "routing file exceeds {} KB limit",
                MAX_ROUTING_FILE_SIZE / 1024
            ));
        }

        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("cannot read routing file: {}", e))?;

        let raw: RawProfilesFile = serde_json::from_str(&content)
            .map_err(|e| format!("invalid routing JSON: {}", e))?;

        let skill_summaries = load_skill_summaries(root);
        let agent_filenames = load_agent_filenames(root);

        let (profiles, warnings) =
            validate_profiles(&raw.profiles, &skill_summaries, &agent_filenames);

        let resolved_path = path.to_string_lossy().into_owned();

        Ok(RoutingProfilesResponse {
            exists: true,
            path: resolved_path,
            profiles,
            warnings,
        })
    }

    // ── save_routing_profiles tests ──

    fn save_at_root(root: &PathBuf, content: &str) -> Result<ActionResult, String> {
        save_routing_profiles_inner(root, content)
    }

    #[test]
    fn save_invalid_json_rejected() {
        let root = temp_root("save-invalid-json");

        let result = save_at_root(&root, "not json");
        cleanup(&root);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid routing JSON"));
    }

    #[test]
    fn save_oversized_content_rejected() {
        let root = temp_root("save-oversized");
        let big = format!("{{\"profiles\":[{}]}}", "x".repeat(MAX_ROUTING_FILE_SIZE));

        let result = save_at_root(&root, &big);
        cleanup(&root);

        assert!(result.is_err());
        assert!(result.unwrap_err().contains("exceeds"));
    }

    #[test]
    fn save_creates_file_under_routing_profiles_json() {
        let root = temp_root("save-creates");

        let json = "{\"profiles\":[{\"id\":\"test\",\"title\":\"T\",\"description\":\"D\",\"target_tool\":\"opencode\",\"recommended_model\":\"m\"}]}";
        let result = save_at_root(&root, json);
        assert!(result.is_ok(), "save should succeed: {:?}", result);
        let ar = result.unwrap();
        assert_eq!(ar.stdout, "created");

        let path = root.join("routing/profiles.json");
        assert!(path.exists(), "file should be created at routing/profiles.json");

        let saved = std::fs::read_to_string(&path).unwrap();
        cleanup(&root);
        assert_eq!(saved, json);
    }

    #[test]
    fn save_unchanged_returns_unchanged() {
        let root = temp_root("save-unchanged");
        let json = "{\"profiles\":[{\"id\":\"test\",\"title\":\"T\",\"description\":\"D\",\"target_tool\":\"opencode\",\"recommended_model\":\"m\"}]}";
        write_file(&root, "routing/profiles.json", json);

        let result = save_at_root(&root, json);
        assert!(result.is_ok());
        let ar = result.unwrap();
        cleanup(&root);
        assert_eq!(ar.stdout, "unchanged");
    }

    #[test]
    fn save_changed_creates_backup() {
        let root = temp_root("save-backup");
        let original = "{\"profiles\":[{\"id\":\"test\",\"title\":\"Old\",\"description\":\"D\",\"target_tool\":\"opencode\",\"recommended_model\":\"m\"}]}";
        let modified = "{\"profiles\":[{\"id\":\"test\",\"title\":\"New\",\"description\":\"D\",\"target_tool\":\"opencode\",\"recommended_model\":\"m\"}]}";
        write_file(&root, "routing/profiles.json", original);

        let result = save_at_root(&root, modified);
        assert!(result.is_ok());
        let ar = result.unwrap();
        assert_eq!(ar.stdout, "saved with backup");

        // Verify file was updated
        let saved = std::fs::read_to_string(root.join("routing/profiles.json")).unwrap();
        assert_eq!(saved, modified);

        // Verify backup was created (using default backup root)
        let home = std::env::var("HOME").unwrap();
        let backup_root = std::path::PathBuf::from(
            std::env::var("UX_WORKSPACE_BACKUP_DIR").unwrap_or_else(|_| {
                format!(
                    "{}/Library/Application Support/ai.openworkspace.ux-workspace/backups",
                    home
                )
            }),
        );
        let routing_backup_dir = backup_root.join("routing");
        assert!(
            routing_backup_dir.exists(),
            "backup routing dir should exist"
        );
        let backup_entries: Vec<_> = std::fs::read_dir(&routing_backup_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                name.starts_with("profiles.json-")
            })
            .collect();
        assert!(!backup_entries.is_empty(), "backup should be created");

        let backup_file = backup_entries[0].path().join("profiles.json");
        let backup_content = std::fs::read_to_string(&backup_file).unwrap();
        assert_eq!(backup_content, original);

        cleanup(&root);
        let _ = std::fs::remove_dir_all(&routing_backup_dir);
    }

    #[test]
    fn save_no_arbitrary_frontend_path_accepted() {
        // save_routing_profiles always writes to the fixed ROUTING_PROFILES_PATH,
        // regardless of content. The content is pure JSON — no path parameter exists.
        let root = temp_root("save-no-path");
        let json = "{\"profiles\":[{\"id\":\"test\",\"title\":\"T\",\"description\":\"D\",\"target_tool\":\"opencode\",\"recommended_model\":\"m\"}]}";

        let result = save_at_root(&root, json);
        assert!(result.is_ok());

        // Only routing/profiles.json should be written
        let path = root.join("routing/profiles.json");
        assert!(path.exists());

        // No other file should have been created
        let mut count = 0;
        if let Ok(entries) = std::fs::read_dir(root.join("routing")) {
            for _ in entries.flatten() {
                count += 1;
            }
        }
        cleanup(&root);
        assert_eq!(count, 1, "only profiles.json should exist in routing/");
    }

    #[test]
    fn save_empty_profiles_creates_file() {
        let root = temp_root("save-empty");
        let json = "{\"profiles\":[]}";

        let result = save_at_root(&root, json);
        assert!(result.is_ok());
        let ar = result.unwrap();
        assert_eq!(ar.stdout, "created");

        let path = root.join("routing/profiles.json");
        assert!(path.exists());

        let saved = std::fs::read_to_string(&path).unwrap();
        cleanup(&root);
        assert_eq!(saved, json);
    }

    // ── metadata-based compatibility warnings ──

    #[test]
    fn target_tool_not_in_skill_targets_produces_warning() {
        let root = temp_root("target-mismatch");
        write_skill_with_targets(&root, "diagnose", "opencode, codex", "medium");

        let json = r#"{
  "profiles": [
    {"id": "test", "title": "T", "description": "D", "target_tool": "auggie", "recommended_model": "m", "skills": ["diagnose"]}
  ]
}"#;
        write_file(&root, "routing/profiles.json", json);

        let response = read_profiles_at_root(&root).expect("should succeed");
        cleanup(&root);

        assert!(response.warnings.iter().any(|w| w.contains("targets 'auggie' but skill 'diagnose' targets only")));
    }

    #[test]
    fn skill_without_targets_produces_no_target_warning() {
        let root = temp_root("no-targets-skill");
        write_skill(&root, "diagnose"); // no targets field

        let json = r#"{
  "profiles": [
    {"id": "test", "title": "T", "description": "D", "target_tool": "auggie", "recommended_model": "m", "skills": ["diagnose"]}
  ]
}"#;
        write_file(&root, "routing/profiles.json", json);

        let response = read_profiles_at_root(&root).expect("should succeed");
        cleanup(&root);

        // skill has no targets metadata, so no target mismatch warning
        let has_target_warning = response.warnings.iter().any(|w| w.contains("targets only"));
        assert!(!has_target_warning, "skill without targets should not produce target mismatch warning");
    }

    #[test]
    fn low_risk_profile_with_high_risk_skill_produces_warning() {
        let root = temp_root("risk-mismatch");
        write_skill_with_targets(&root, "security-review", "opencode, codex", "high");

        let json = r#"{
  "profiles": [
    {"id": "test", "title": "T", "description": "D", "target_tool": "opencode", "recommended_model": "m", "risk": "low", "skills": ["security-review"]}
  ]
}"#;
        write_file(&root, "routing/profiles.json", json);

        let response = read_profiles_at_root(&root).expect("should succeed");
        cleanup(&root);

        assert!(response.warnings.iter().any(|w| w.contains("risk 'low' but references high-risk skill 'security-review'")));
    }

    #[test]
    fn medium_risk_profile_with_high_risk_skill_does_not_warn() {
        let root = temp_root("risk-ok");
        write_skill_with_targets(&root, "security-review", "opencode, codex", "high");

        let json = r#"{
  "profiles": [
    {"id": "test", "title": "T", "description": "D", "target_tool": "opencode", "recommended_model": "m", "risk": "medium", "skills": ["security-review"]}
  ]
}"#;
        write_file(&root, "routing/profiles.json", json);

        let response = read_profiles_at_root(&root).expect("should succeed");
        cleanup(&root);

        let has_risk_warning = response.warnings.iter().any(|w| w.contains("risk 'low' but references high-risk"));
        assert!(!has_risk_warning, "medium risk with high-risk skill should not produce warning (only low triggers it)");
    }
}
