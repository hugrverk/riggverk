import { useId, type ReactNode } from "react";
import { CopyButton } from "./CopyButton";

interface CopyableBlockProps {
  text: string;
  children: ReactNode;
  className?: string;
}

export function CopyableBlock({ text, children, className = "" }: CopyableBlockProps) {
  const rawId = useId();
  const blockId = `copyable-${rawId.replace(/:/g, "")}`;

  return (
    <div className={`copyable-block${className ? ` ${className}` : ""}`}>
      <CopyButton getText={() => text} fallbackElementId={blockId} />
      <div id={blockId} className="copyable-block-content">
        {children}
      </div>
    </div>
  );
}
