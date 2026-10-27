import { useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useKeymap } from "../keyboard/useKeymap";
import type { Binding } from "../keyboard/registry";
import { Kv, type KvItem } from "../ui/Kv";
import { usePaneId } from "../ui/Pane";
import type { ListAvailableModelsResult, OpenCodeModelSelection, OpenCodeModelSource, OpenCodeRuntimeHealth } from "../types";

interface OpenCodeModelRowsProps {
  workspaceValid: boolean;
  /** The installed config against the bundled render: it says whether a saved selection is already installed. */
  health: Pick<OpenCodeRuntimeHealth, "config_status" | "config_diverged_keys"> | null;
  /** The saved selection changed; the owner reloads runtime health and the installation overview. */
  onModelUpdated: () => void;
}

const FORMAT_ERROR = "Must be provider/model format";
/** Not a model id (it has no slash), so it cannot collide with an option. */
const CUSTOM_CHOICE = "__custom__";
/** `agent.<role>.model`: the managed entries that carry the subagent model. */
const SUBAGENT_MODEL_KEY = /^agent\.[^.]+\.model$/;
const CRITIC_MODEL_KEY = "agent.inspector.model";

type ApplyState = "applied" | "pending";

/**
 * Whether the installed config already holds what the saved selection (or the bundled default) asks for.
 * The config check compares the installed file with the bundled render, which includes the override, so a
 * managed key it names is a value that an update would still change. `null`: not known yet.
 */
function applyState(health: OpenCodeModelRowsProps["health"], keyMatches: (key: string) => boolean): ApplyState | null {
  if (!health) return null;
  switch (health.config_status) {
    case "synced":
      return "applied";
    case "diverged":
      return health.config_diverged_keys.some(keyMatches) ? "pending" : "applied";
    case "missing":
    case "invalid":
      return "pending";
    default:
      return null;
  }
}

function providerOf(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : model;
}

function groupByProvider(models: readonly string[]): Array<[string, string[]]> {
  const groups = new Map<string, string[]>();
  for (const model of models) {
    const provider = providerOf(model);
    groups.set(provider, [...(groups.get(provider) ?? []), model]);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b));
}

/** `source: override · state: pending apply (u to update)`; the state is left out while it is not known. */
function SourceLine({ source, state }: { source: OpenCodeModelSource; state: ApplyState | null }) {
  return (
    <>
      source: {source}
      {state && (
        <>
          {" · "}
          <span className={state === "applied" ? "c-ok" : "c-warn"}>state: {state === "applied" ? "applied" : "pending apply (u to update)"}</span>
        </>
      )}
    </>
  );
}

interface ModelFieldProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  disabled: boolean;
  /** The choices: every model the CLI lists plus the configured and drafted ones. */
  models: readonly string[];
  /** The models `opencode models` lists; null while that is not known, so nothing is marked unavailable. */
  listed: ReadonlySet<string> | null;
  /** Label of the empty choice; set on an optional field. */
  emptyLabel?: string;
  placeholder: string;
  fieldRef?: RefObject<HTMLSelectElement | HTMLInputElement | null>;
}

/**
 * One model value: a select grouped by provider, or a text input while there is no list or a custom
 * provider/model is typed. Esc leaves the custom input and returns to the list.
 */
function ModelField({ id, value, onChange, error, disabled, models, listed, emptyLabel, placeholder, fieldRef }: ModelFieldProps) {
  const [custom, setCustom] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const returningToList = useRef(false);
  useEffect(() => {
    if (custom) {
      // The current value is the starting point; selected, typing replaces it.
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (returningToList.current) {
      returningToList.current = false;
      selectRef.current?.focus();
    }
  }, [custom]);

  const describedBy = error ? `${id}-error` : undefined;
  if (models.length === 0 || custom) {
    return (
      <input
        id={id}
        ref={node => {
          inputRef.current = node;
          if (fieldRef) fieldRef.current = node;
        }}
        type="text"
        value={value}
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key !== "Escape" || !custom) return;
          // The shell's Escape would only leave the field: here it goes back to the list.
          event.preventDefault();
          returningToList.current = true;
          setCustom(false);
        }}
        disabled={disabled}
        placeholder={custom ? `${placeholder} (Esc: back to the list)` : placeholder}
        aria-invalid={!!error}
        aria-describedby={describedBy}
      />
    );
  }
  return (
    <select
      id={id}
      ref={node => {
        selectRef.current = node;
        if (fieldRef) fieldRef.current = node;
      }}
      value={value}
      onChange={event => (event.target.value === CUSTOM_CHOICE ? setCustom(true) : onChange(event.target.value))}
      disabled={disabled}
      aria-invalid={!!error}
      aria-describedby={describedBy}
    >
      {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
      {groupByProvider(models).map(([provider, group]) => (
        <optgroup key={provider} label={provider}>
          {group.map(model => (
            <option key={model} value={model}>
              {listed && !listed.has(model) ? `${model} (not in opencode models)` : model}
            </option>
          ))}
        </optgroup>
      ))}
      <option value={CUSTOM_CHOICE}>custom provider/model…</option>
    </select>
  );
}

/**
 * The OpenCode model override as editable rows: `model`, `small model`, `subagent model` and `critic model`
 * are selects grouped by provider (a text input while no model list is available or a custom model is typed).
 * Each row says where its value comes from and whether the installed config already has it. `s` saves, `x`
 * resets the override to the bundled default, `R` reloads the list, `e` edits. `m` is the rules file's
 * "leave as is" in the same pane, so the reload does not take it. The values are stored in app settings and
 * applied on the next OpenCode update; workspace templates are not edited.
 */
export function OpenCodeModelRows({ workspaceValid, health, onModelUpdated }: OpenCodeModelRowsProps) {
  const paneId = usePaneId();
  const [available, setAvailable] = useState<ListAvailableModelsResult | null>(null);
  const [selection, setSelection] = useState<OpenCodeModelSelection | null>(null);
  const [draftModel, setDraftModel] = useState("");
  const [draftSmall, setDraftSmall] = useState("");
  const [draftSubagent, setDraftSubagent] = useState("");
  const [draftCritic, setDraftCritic] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [modelWarning, setModelWarning] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  /** Bumped whenever the selection is read again, so fields drop a typed custom value's input mode. */
  const [revision, setRevision] = useState(0);
  const selectionGenRef = useRef(0);
  const modelsGenRef = useRef(0);
  const firstFieldRef = useRef<HTMLSelectElement | HTMLInputElement | null>(null);
  const modelId = useId();
  const smallModelId = useId();
  const subagentModelId = useId();
  const criticModelId = useId();

  const loadSelection = useCallback(async () => {
    if (!workspaceValid) return;
    const gen = ++selectionGenRef.current;
    try {
      const sel = await invoke<OpenCodeModelSelection>("read_opencode_model_selection");
      if (gen !== selectionGenRef.current) return;
      setSelection(sel);
      setDraftModel(sel.model);
      setDraftSmall(sel.small_model);
      setDraftSubagent(sel.subagent_model ?? "");
      setDraftCritic(sel.critic_model ?? "");
      setRevision(value => value + 1);
    } catch {
      if (gen !== selectionGenRef.current) return;
      setSelection(null);
    }
  }, [workspaceValid]);

  const loadModels = useCallback(async () => {
    if (!workspaceValid) return;
    const gen = ++modelsGenRef.current;
    setLoadingModels(true);
    setModelWarning(null);
    try {
      const result = await invoke<ListAvailableModelsResult>("list_available_opencode_models");
      if (gen !== modelsGenRef.current) return;
      setAvailable(result);
      if (result.warning) setModelWarning(result.warning);
    } catch (err) {
      if (gen !== modelsGenRef.current) return;
      setAvailable(null);
      setModelWarning(err instanceof Error ? err.message : String(err));
    } finally {
      if (gen === modelsGenRef.current) setLoadingModels(false);
    }
  }, [workspaceValid]);

  useEffect(() => {
    if (workspaceValid) {
      void loadSelection();
      void loadModels();
    } else {
      setAvailable(null);
      setSelection(null);
    }
  }, [workspaceValid, loadSelection, loadModels]);

  const savedSubagent = selection?.subagent_model ?? "";
  const savedCritic = selection?.critic_model ?? "";
  const hasChanges = selection !== null && (draftModel !== selection.model || draftSmall !== selection.small_model || draftSubagent !== savedSubagent || draftCritic !== savedCritic);
  const modelError = draftModel && !draftModel.includes("/") ? FORMAT_ERROR : null;
  const smallError = draftSmall && !draftSmall.includes("/") ? FORMAT_ERROR : null;
  const subagentError = draftSubagent && !draftSubagent.includes("/") ? FORMAT_ERROR : null;
  const criticError = draftCritic && !draftCritic.includes("/") ? FORMAT_ERROR : null;
  const canSave = workspaceValid && hasChanges && !modelError && !smallError && !subagentError && !criticError && !saving;
  const hasOverride = [selection?.model_source, selection?.small_model_source, selection?.subagent_source, selection?.critic_source].includes("override");

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    setNotice(null);
    try {
      const msg = await invoke<string>("update_opencode_model_selection", {
        model: draftModel,
        smallModel: draftSmall,
        subagentModel: draftSubagent || null,
        criticModel: draftCritic || null,
      });
      setNotice({ text: msg, ok: /saved/i.test(msg) });
      await loadSelection();
      onModelUpdated();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : String(err), ok: false });
    } finally {
      setSaving(false);
    }
  }, [canSave, draftModel, draftSmall, draftSubagent, draftCritic, loadSelection, onModelUpdated]);

  const handleReset = useCallback(async () => {
    if (!workspaceValid || !hasOverride || saving) return;
    setSaving(true);
    setNotice(null);
    try {
      const msg = await invoke<string>("reset_opencode_model_selection");
      setNotice({ text: msg, ok: true });
      // The drafts follow the bundled default again, including a typed value that was never saved.
      await loadSelection();
      onModelUpdated();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : String(err), ok: false });
    } finally {
      setSaving(false);
    }
  }, [workspaceValid, hasOverride, saving, loadSelection, onModelUpdated]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Discovered models plus the configured and drafted ones, so the current selection is always an option.
  const modelOptions = useMemo(() => {
    const set = new Set<string>();
    for (const m of available?.models ?? []) set.add(m);
    for (const m of [selection?.model, selection?.small_model, selection?.subagent_model, selection?.critic_model, draftModel, draftSmall, draftSubagent, draftCritic]) {
      if (m && m.includes("/")) set.add(m);
    }
    return [...set].sort();
  }, [available, selection, draftModel, draftSmall, draftSubagent, draftCritic]);

  // A listing that failed, or exited non-zero, may be partial: it marks nothing unavailable.
  const listed = useMemo(
    () => (available && !available.warning && available.models.length > 0 ? new Set(available.models) : null),
    [available],
  );

  const bindings: Binding[] = paneId
    ? [
        {
          id: "opencode.model.edit",
          keys: "e",
          title: "Edit the model override",
          hint: "edit model",
          group: "OpenCode model",
          scope: "pane",
          paneId,
          when: () => workspaceValid,
          run: () => firstFieldRef.current?.focus(),
        },
        {
          id: "opencode.model.save",
          keys: "s",
          title: "Save the model override",
          hint: "save model",
          group: "OpenCode model",
          scope: "pane",
          paneId,
          when: () => (!workspaceValid ? false : canSave ? true : modelError || smallError || subagentError || criticError || "no unsaved change"),
          run: () => void handleSave(),
        },
        {
          id: "opencode.model.reset",
          keys: "x",
          title: "Reset the model override to the bundled default",
          hint: "reset model",
          group: "OpenCode model",
          scope: "pane",
          paneId,
          when: () => (!workspaceValid ? false : saving ? "busy" : hasOverride ? true : "no override to reset"),
          run: () => void handleReset(),
        },
        {
          id: "opencode.model.refresh",
          keys: "R",
          title: "Reload the available models",
          hint: "reload models",
          group: "OpenCode model",
          scope: "pane",
          paneId,
          when: () => (!workspaceValid ? false : loadingModels || saving ? "busy" : true),
          run: () => void loadModels(),
        },
      ]
    : [];
  useKeymap(bindings);

  if (!workspaceValid) return null;

  const modelState = applyState(health, key => key === "model");
  const smallState = applyState(health, key => key === "small_model");
  const subagentState = applyState(health, key => SUBAGENT_MODEL_KEY.test(key) && !(savedCritic && key === CRITIC_MODEL_KEY));
  const criticState = applyState(health, key => key === CRITIC_MODEL_KEY);
  const field = (id: string, value: string, onChange: (value: string) => void, error: string | null, extra: Partial<ModelFieldProps> = {}): KvItem["value"] => (
    <ModelField
      key={`${id}-${revision}`}
      id={id}
      value={value}
      onChange={onChange}
      error={error}
      disabled={saving}
      models={modelOptions}
      listed={listed}
      placeholder="provider/model"
      {...extra}
    />
  );
  const errorRow = (id: string, error: string | null): KvItem[] =>
    error ? [{ label: "", value: <span id={`${id}-error`} role="alert">{error}</span>, tone: "warn" as const, id: `${id}-error` }] : [];
  const sourceRow = (id: string, source: OpenCodeModelSource | undefined, state: ApplyState | null): KvItem[] =>
    source ? [{ label: "", value: <SourceLine source={source} state={state} />, tone: "dim" as const, wrap: true, id: `${id}-source` }] : [];

  const items: KvItem[] = [
    { label: <label htmlFor={modelId}>model</label>, value: field(modelId, draftModel, setDraftModel, modelError, { fieldRef: firstFieldRef }), id: "model" },
    ...errorRow(modelId, modelError),
    ...sourceRow("model", selection?.model_source, modelState),
    { label: <label htmlFor={smallModelId}>small model</label>, value: field(smallModelId, draftSmall, setDraftSmall, smallError), id: "small" },
    ...errorRow(smallModelId, smallError),
    ...sourceRow("small", selection?.small_model_source, smallState),
    {
      label: <label htmlFor={subagentModelId}>subagent model</label>,
      value: field(subagentModelId, draftSubagent, setDraftSubagent, subagentError, { emptyLabel: "inherit main model", placeholder: "inherit main model" }),
      id: "subagent",
    },
    ...errorRow(subagentModelId, subagentError),
    ...sourceRow("subagent", selection?.subagent_source, subagentState),
    {
      label: <label htmlFor={criticModelId}>critic model</label>,
      value: field(criticModelId, draftCritic, setDraftCritic, criticError, { emptyLabel: "inherit subagent or main model", placeholder: "inherit subagent or main model" }),
      id: "critic",
    },
    ...errorRow(criticModelId, criticError),
    ...sourceRow("critic", selection?.critic_source, criticState),
    { label: "", value: "used by the adversarial skills' critic (inspector)", tone: "dim", wrap: true, id: "critic-hint" },
  ];

  return (
    <section className="runtime-edit" aria-label="Model selection">
      <div className="group">model override</div>
      <Kv items={items} className="kv-edit" />
      {modelWarning && <p className="c-warn runtime-note">{modelWarning}</p>}
      {notice && (
        <p className={notice.ok ? "c-ok runtime-note" : "c-warn runtime-note"} role="status">
          {notice.text}
        </p>
      )}
      <p className="c-dim runtime-note">
        Stored in app settings and applied on the next OpenCode update; workspace templates are not edited. Saving stores only the values you
        changed: one equal to the bundled default keeps following it. The subagent model pins repo-scout, inspector, sentinel, verifier and
        scribe; unset, they use the main model. The critic model takes precedence for inspector only.
      </p>
    </section>
  );
}
