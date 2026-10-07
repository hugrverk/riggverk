import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useKeymap } from "../keyboard/useKeymap";
import type { Binding } from "../keyboard/registry";
import { Kv, type KvItem } from "../ui/Kv";
import { usePaneId } from "../ui/Pane";
import type { ListAvailableModelsResult, OpenCodeModelSelection } from "../types";

interface OpenCodeModelRowsProps {
  workspaceValid: boolean;
  /** The saved selection changed; the owner reloads runtime health and the installation overview. */
  onModelUpdated: () => void;
}

const FORMAT_ERROR = "Must be provider/model format";

/**
 * The OpenCode model override as editable rows of the detail pane: `model` and `small model` are selects
 * (a text input while no model list is available), `s` saves, `R` reloads the list, `e` edits. `m` is the
 * rules file's "leave as is" in the same pane, so the reload does not take it. The value is
 * stored in app settings and applied on the next OpenCode update; workspace templates are not edited.
 */
export function OpenCodeModelRows({ workspaceValid, onModelUpdated }: OpenCodeModelRowsProps) {
  const paneId = usePaneId();
  const [available, setAvailable] = useState<ListAvailableModelsResult | null>(null);
  const [selection, setSelection] = useState<OpenCodeModelSelection | null>(null);
  const [draftModel, setDraftModel] = useState("");
  const [draftSmall, setDraftSmall] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [modelWarning, setModelWarning] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const selectionGenRef = useRef(0);
  const modelsGenRef = useRef(0);
  const modelSelectRef = useRef<HTMLSelectElement>(null);
  const modelInputRef = useRef<HTMLInputElement>(null);
  const modelId = useId();
  const smallModelId = useId();

  const loadSelection = useCallback(async () => {
    if (!workspaceValid) return;
    const gen = ++selectionGenRef.current;
    try {
      const sel = await invoke<OpenCodeModelSelection>("read_opencode_model_selection");
      if (gen !== selectionGenRef.current) return;
      setSelection(sel);
      setDraftModel(sel.model);
      setDraftSmall(sel.small_model);
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

  const hasChanges = selection !== null && (draftModel !== selection.model || draftSmall !== selection.small_model);
  const modelError = draftModel && !draftModel.includes("/") ? FORMAT_ERROR : null;
  const smallError = draftSmall && !draftSmall.includes("/") ? FORMAT_ERROR : null;
  const canSave = workspaceValid && hasChanges && !modelError && !smallError && !saving;

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const msg = await invoke<string>("update_opencode_model_selection", {
        model: draftModel,
        smallModel: draftSmall,
      });
      setSaveMessage(msg);
      await loadSelection();
      onModelUpdated();
    } catch (err) {
      setSaveMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [canSave, draftModel, draftSmall, loadSelection, onModelUpdated]);

  // Sync the drafts when the selection reloads after a save.
  useEffect(() => {
    if (selection && !hasChanges) {
      setDraftModel(selection.model);
      setDraftSmall(selection.small_model);
    }
  }, [selection]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!saveMessage) return;
    const timer = setTimeout(() => setSaveMessage(null), 5000);
    return () => clearTimeout(timer);
  }, [saveMessage]);

  // Discovered models plus the configured and drafted ones, so the current selection is always an option.
  const modelOptions = useMemo(() => {
    const set = new Set<string>();
    for (const m of available?.models ?? []) set.add(m);
    if (selection?.model) set.add(selection.model);
    if (selection?.small_model) set.add(selection.small_model);
    if (draftModel && draftModel.includes("/")) set.add(draftModel);
    if (draftSmall && draftSmall.includes("/")) set.add(draftSmall);
    return [...set].sort();
  }, [available, selection, draftModel, draftSmall]);

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
          run: () => (modelSelectRef.current ?? modelInputRef.current)?.focus(),
        },
        {
          id: "opencode.model.save",
          keys: "s",
          title: "Save the model override",
          hint: "save model",
          group: "OpenCode model",
          scope: "pane",
          paneId,
          when: () => (!workspaceValid ? false : canSave ? true : modelError || smallError || "no unsaved change"),
          run: () => void handleSave(),
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

  const showModelList = modelOptions.length > 0;
  const field = (id: string, value: string, onChange: (value: string) => void, error: string | null, ref?: boolean): KvItem["value"] =>
    showModelList ? (
      <select
        id={id}
        ref={ref ? modelSelectRef : undefined}
        value={value}
        onChange={event => onChange(event.target.value)}
        disabled={saving}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
      >
        {modelOptions.map(m => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    ) : (
      <input
        id={id}
        ref={ref ? modelInputRef : undefined}
        type="text"
        value={value}
        onChange={event => onChange(event.target.value)}
        disabled={saving}
        placeholder="provider/model"
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
      />
    );

  const items: KvItem[] = [
    { label: <label htmlFor={modelId}>model</label>, value: field(modelId, draftModel, setDraftModel, modelError, true), id: "model" },
    ...(modelError ? [{ label: "", value: <span id={`${modelId}-error`} role="alert">{modelError}</span>, tone: "warn" as const, id: "model-error" }] : []),
    { label: <label htmlFor={smallModelId}>small model</label>, value: field(smallModelId, draftSmall, setDraftSmall, smallError), id: "small" },
    ...(smallError ? [{ label: "", value: <span id={`${smallModelId}-error`} role="alert">{smallError}</span>, tone: "warn" as const, id: "small-error" }] : []),
  ];

  return (
    <section className="runtime-edit" aria-label="Model selection">
      <div className="group">model override</div>
      <Kv items={items} className="kv-edit" />
      {modelWarning && <p className="c-warn runtime-note">{modelWarning}</p>}
      {saveMessage && (
        <p className={/saved/i.test(saveMessage) ? "c-ok runtime-note" : "c-warn runtime-note"} role="status">
          {saveMessage}
        </p>
      )}
      <p className="c-dim runtime-note">
        Stored in app settings and applied on the next OpenCode update; workspace templates are not edited.
      </p>
    </section>
  );
}
