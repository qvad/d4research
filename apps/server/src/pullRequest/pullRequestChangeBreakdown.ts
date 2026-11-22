import type { PullRequestChangeBreakdown } from "@d4research/contracts";
import { summarizeChangedFiles } from "@d4research/shared/changedFileKind";
import type { ProviderFileStats } from "@d4research/source-control-core/server/PullRequestProvider";

export function toChangeBreakdown(stats: ProviderFileStats): PullRequestChangeBreakdown {
  if (stats.truncated) return null;
  return summarizeChangedFiles(stats.files);
}
