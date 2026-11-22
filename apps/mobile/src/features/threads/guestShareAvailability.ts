import { managedCapabilityDenial, type ServerConfig } from "@d4research/contracts";

export function canShareWithGuest(
  permitted: boolean,
  config:
    | {
        readonly settings: Pick<ServerConfig["settings"], "guestSharingEnabled">;
        readonly managedPolicy?: ServerConfig["managedPolicy"];
      }
    | undefined,
) {
  return (
    permitted &&
    config?.settings.guestSharingEnabled === true &&
    managedCapabilityDenial(config.managedPolicy, "connect") === undefined
  );
}
