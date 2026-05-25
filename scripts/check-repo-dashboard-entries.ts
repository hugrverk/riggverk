import assert from "node:assert/strict";
import type { DiscoveredLocalGitRepo, RepoDashboardEntry } from "../src/types";
import {
  discoveredToDashboardEntry,
  isRepoPathAlreadySaved,
  mergeImportedRepoEntries,
  repoEntryIdFromPath,
} from "../src/lib/repoDashboardEntries";

assert.equal(repoEntryIdFromPath("/tmp/My Repo/"), "my-repo");

const existing: RepoDashboardEntry[] = [
  { id: "alpha", label: "Alpha", path: "/tmp/alpha" },
];

assert.equal(isRepoPathAlreadySaved("/tmp/alpha/", existing), true);
assert.equal(isRepoPathAlreadySaved("/tmp/beta", existing), false);

const discovered: DiscoveredLocalGitRepo = {
  label: "Beta",
  path: "/tmp/beta",
  default_branch: "main",
  repo_slug: "org/beta",
  warnings: [],
};

const merged = mergeImportedRepoEntries(existing, [
  discoveredToDashboardEntry(discovered),
  discoveredToDashboardEntry({ ...discovered, path: "/tmp/alpha" }),
]);
assert.equal(merged.length, 2);
assert.equal(merged[1]?.path, "/tmp/beta");

const idCollision = mergeImportedRepoEntries(
  [{ id: "demo", label: "Demo", path: "/a/demo" }],
  [{ id: "demo", label: "Other", path: "/b/other" }],
);
assert.equal(idCollision.length, 2);
assert.equal(idCollision[1]?.id, "demo-2");

console.log("Repo Dashboard entry checks passed");
