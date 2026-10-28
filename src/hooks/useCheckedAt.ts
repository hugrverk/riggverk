import { useEffect, useRef, useState } from "react";
import type { InstallationOverview } from "./useInstallationOverview";

/**
 * When the installation status was last fetched: set each time a fetch of the overview settles with at least one
 * entry. Null before the first one (and while the workspace folder is unusable, which leaves no entries).
 */
export function useCheckedAt(overview: Pick<InstallationOverview, "loading" | "entries">): Date | null {
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const wasLoading = useRef(false);
  const hasEntries = Object.keys(overview.entries).length > 0;
  useEffect(() => {
    if (wasLoading.current && !overview.loading && hasEntries) setCheckedAt(new Date());
    wasLoading.current = overview.loading;
  }, [overview.loading, hasEntries]);
  return checkedAt;
}
