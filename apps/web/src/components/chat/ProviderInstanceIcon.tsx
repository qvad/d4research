import { type CSSProperties, memo } from "react";
import { ProviderDriverKind, ProviderInstanceId } from "@d4research/contracts";
import { useProviderAppearance } from "~/hooks/useProviderAppearance";
import { providerInstanceInitials } from "@d4research/client-runtime/state/provider-instance-display";

import { PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";
import { cn } from "~/lib/utils";

export { providerInstanceInitials };

export const ProviderInstanceIcon = memo(function ProviderInstanceIcon(props: {
  driverKind: ProviderDriverKind;
  instanceId?: ProviderInstanceId | undefined;
  displayName: string;
  accentColor?: string | undefined;
  showBadge?: boolean;
  badgeContent?: "initials" | "none";
  className?: string;
  iconClassName?: string;
  badgeClassName?: string;
  statusDotClassName?: string;
  indicatorBackground?: string;
}) {
  const { appearance } = useProviderAppearance(
    props.instanceId ?? ProviderInstanceId.make(props.driverKind),
  );
  const Icon =
    PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make(appearance.icon ?? props.driverKind)] ??
    PROVIDER_ICON_BY_PROVIDER[props.driverKind] ??
    null;
  const BadgeIcon = appearance.badgeIcon
    ? PROVIDER_ICON_BY_PROVIDER[ProviderDriverKind.make(appearance.badgeIcon)]
    : undefined;
  const showBadge = appearance.badgeIcon ? appearance.badgeIcon !== "none" : props.showBadge;
  const indicatorBackground = props.indicatorBackground ?? "var(--card)";
  const accentStyle = props.accentColor
    ? ({ "--provider-accent": props.accentColor } as CSSProperties)
    : undefined;
  const badgeContent = props.badgeContent ?? "initials";

  return (
    <span
      className={cn(
        "relative isolate inline-flex shrink-0 items-center justify-center overflow-visible",
        props.className,
      )}
      style={accentStyle}
      data-provider-accent-color={props.accentColor}
    >
      {Icon ? (
        <Icon className={cn("size-5 shrink-0", props.iconClassName)} aria-hidden />
      ) : (
        <span className={cn("text-[10px] font-semibold leading-none", props.iconClassName)}>
          {providerInstanceInitials(props.displayName)}
        </span>
      )}
      {props.statusDotClassName ? (
        <span
          className={cn(
            "pointer-events-none absolute -left-0.5 -top-0.5 z-10 size-2 rounded-full",
            props.statusDotClassName,
          )}
          style={{ boxShadow: `0 0 0 2px ${indicatorBackground}` }}
          aria-hidden
        />
      ) : null}
      {showBadge ? (
        <span
          className={cn(
            "pointer-events-none absolute right-0 bottom-0 z-10 flex h-3.5 min-w-3.5 items-center justify-center rounded-full border px-0.5 text-[8px] font-semibold leading-none shadow-sm",
            props.accentColor
              ? "bg-[var(--provider-accent)] text-white"
              : "bg-card text-muted-foreground",
            props.badgeClassName,
            BadgeIcon && "h-3.5 min-w-3.5 px-0.5",
          )}
          style={{ borderColor: indicatorBackground }}
          aria-hidden
        >
          {BadgeIcon ? (
            <BadgeIcon className="size-2.5" aria-hidden />
          ) : appearance.badgeIcon === "initials" || badgeContent === "initials" ? (
            providerInstanceInitials(props.displayName)
          ) : null}
        </span>
      ) : null}
    </span>
  );
});
