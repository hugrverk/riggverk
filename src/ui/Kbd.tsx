import type { ReactNode } from "react";

/** A key cap. Pass display text ("j", "↵", "⌘S"), not a key spec. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={className}>{children}</kbd>;
}

/** A row of key caps, one per token ("g g" -> two caps). */
export function KeyCaps({ keys }: { keys: readonly string[] }) {
  return (
    <>
      {keys.map((token, index) => (
        <kbd key={`${index}:${token}`}>{token}</kbd>
      ))}
    </>
  );
}
