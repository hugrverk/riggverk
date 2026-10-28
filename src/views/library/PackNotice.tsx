import { forgettablePacks, packNoticeLines } from "../../lib/packSkills";
import type { PackLibrary } from "../../types";
import { TButton } from "../../ui/TButton";

interface PackNoticeProps {
  library: PackLibrary | null;
  /** Why the packs could not be listed at all; the bundled skills are still shown. */
  error?: string | null;
  onForgetPack: (name: string) => void;
}

/**
 * Above the skill list, for the packs that need attention: a pack that is refused (a link in it, a folder
 * others can write to), folders in `packs/` that are no pack, and skills installed from a pack whose folder
 * is gone, which are kept until the user forgets the pack. Nothing here while all packs are fine.
 */
export function PackNotice({ library, error = null, onForgetPack }: PackNoticeProps) {
  const lines = packNoticeLines(library, error);
  const forgettable = forgettablePacks(library);
  if (lines.length === 0 && forgettable.length === 0) return null;
  return (
    <div className="lib-pack-note" role="group" aria-label="Skill pack problems">
      {lines.map(line => (
        <div key={line.key} className="lib-pack-row">
          <span className="c-warn">{line.label}</span>
          <span className="c-dim">{line.text}</span>
        </div>
      ))}
      {forgettable.map(pack => (
        <div key={`forget:${pack.name}`} className="lib-pack-row">
          <span className="c-warn">pack:{pack.name}</span>
          <span className="c-dim">
            {pack.state === "refused" ? pack.reason : "folder missing"}: its installed skills are kept
          </span>
          <TButton keys={[]} variant="danger" onClick={() => onForgetPack(pack.name)}>
            Forget pack
          </TButton>
        </div>
      ))}
    </div>
  );
}
