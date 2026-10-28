import { forgettablePacks } from "../../lib/packSkills";
import type { PackLibrary } from "../../types";
import { TButton } from "../../ui/TButton";

interface PackNoticeProps {
  library: PackLibrary | null;
  onForgetPack: (name: string) => void;
}

/**
 * Above the skill list, for the packs that need a decision: skills installed from a pack whose folder is gone
 * (or refused) are kept as they are until the user forgets the pack. Nothing here while all packs are fine.
 */
export function PackNotice({ library, onForgetPack }: PackNoticeProps) {
  const packs = forgettablePacks(library);
  if (packs.length === 0) return null;
  return (
    <div className="lib-pack-note" role="group" aria-label="Skill packs that cannot be read">
      {packs.map(pack => (
        <div key={pack.name} className="lib-pack-row">
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
