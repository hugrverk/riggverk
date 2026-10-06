import { useContext, useEffect, useRef } from "react";
import { KeymapContext } from "../context";
import type { CommandSpec } from "./parser";

function signatureOf(command: CommandSpec): string {
  const args = (command.args ?? []).map(arg => `${arg.name}:${arg.kind}:${arg.optional ? "?" : ""}`).join(",");
  return [command.name, (command.aliases ?? []).join(","), command.summary, command.group ?? "", args].join("\u0000");
}

/**
 * Registers commands for the lifetime of the calling component (views register theirs while mounted;
 * the app registers the global set). `run`, `enabled`, `validate` and `complete` read the latest
 * closure, so a fresh array every render is fine. Without a KeymapProvider this is a no-op.
 */
export function useCommands(commands: readonly CommandSpec[]): void {
  const registry = useContext(KeymapContext)?.commands ?? null;
  const latest = useRef(commands);
  latest.current = commands;
  const signature = commands.map(signatureOf).join("\n");

  useEffect(() => {
    if (!registry) return;
    const current = (name: string) => latest.current.find(command => command.name === name);
    const proxies = latest.current.map((command): CommandSpec => ({
      ...command,
      args: command.args?.map(arg => ({
        ...arg,
        // Dynamic enum values and descriptions are read through the latest closure too.
        values: typeof arg.values === "function"
          ? () => {
              const live = current(command.name)?.args?.find(candidate => candidate.name === arg.name)?.values;
              return typeof live === "function" ? live() : live ?? [];
            }
          : arg.values,
        describe: arg.describe
          ? (value: string) =>
              current(command.name)?.args?.find(candidate => candidate.name === arg.name)?.describe?.(value)
          : undefined,
      })),
      enabled: command.enabled ? () => current(command.name)?.enabled?.() ?? "unavailable" : undefined,
      validate: command.validate ? parsed => current(command.name)?.validate?.(parsed) ?? null : undefined,
      complete: command.complete ? context => current(command.name)?.complete?.(context) ?? [] : undefined,
      run: parsed => current(command.name)?.run(parsed),
    }));
    return registry.register(proxies);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, signature]);
}
