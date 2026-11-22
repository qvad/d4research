import type { EnvironmentId, EnvironmentMachineKind } from "@d4research/contracts";
import { useGT } from "gt-react";

import type { SidebarProjectSnapshot } from "~/sidebarProjectGrouping";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function ProjectEnvironmentBadge(props: {
  readonly group: Pick<SidebarProjectSnapshot, "memberProjects">;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly machineByEnvironmentId: ReadonlyMap<EnvironmentId, EnvironmentMachineKind>;
}) {
  const gt = useGT();
  const members = props.group.memberProjects
    .map((member) => ({
      ...member,
      environmentLabel:
        member.environmentLabel ??
        (member.environmentId === props.primaryEnvironmentId
          ? gt("This machine")
          : gt("Remote", { $context: "machine location" })),
    }))
    .sort((a, b) => a.environmentLabel.localeCompare(b.environmentLabel));
  const first =
    members.find((member) => member.environmentId === props.primaryEnvironmentId) ?? members[0];
  if (!first) return null;
  const labels = members
    .map((member) => member.environmentLabel)
    .filter((label, index, all) => all.indexOf(label) === index)
    .join(", ");
  const description = gt("On {labels}", { labels });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={description}
            className="inline-flex shrink-0 items-center text-muted-foreground"
          />
        }
      >
        <EnvironmentMachineIcon
          aria-hidden
          kind={props.machineByEnvironmentId.get(first.environmentId) ?? "server"}
          className="size-3.5"
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{description}</TooltipPopup>
    </Tooltip>
  );
}
