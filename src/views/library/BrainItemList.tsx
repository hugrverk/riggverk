import { LibraryList } from "./LibraryList";

export const BRAIN_LIST_KEY = "brain:setup";

const ROWS = [{ key: BRAIN_LIST_KEY, name: "Brain Setup" }];

interface BrainItemListProps {
  brainSetupSource: string;
  workspaceValid: boolean;
  onActivate: (key: string) => void;
}

export function BrainItemList({ brainSetupSource, workspaceValid, onActivate }: BrainItemListProps) {
  if (!workspaceValid) {
    return <p className="c-dim" role="status">No valid workspace</p>;
  }
  return (
    <LibraryList<(typeof ROWS)[number]>
      label="Brain Setup"
      items={ROWS}
      getKey={row => row.key}
      getGroup={() => "source"}
      renderItem={row => (
        <>
          <span className="nm">{row.name}</span>
          <span className="meta" title={brainSetupSource}>copy block</span>
        </>
      )}
      activeKey={BRAIN_LIST_KEY}
      followCursor={false}
      onSelect={() => {}}
      onActivate={onActivate}
      activateHint="open"
    />
  );
}
