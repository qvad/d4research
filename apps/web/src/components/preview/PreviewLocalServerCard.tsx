import type { ScopedThreadRef } from "@d4research/contracts";
import { msg, useMessages } from "gt-react";

import type { MessageResolver } from "../../i18n/messages";
import { DiscoveryListRow } from "../ui/discovery-list";

import { PreviewFaviconIcon } from "./PreviewFaviconIcon";
import type { PreviewableServer } from "./useDiscoveredLocalServers";

interface Props {
  threadRef: ScopedThreadRef;
  server: PreviewableServer;
  onOpen: () => void;
}

export function PreviewLocalServerCard({ threadRef, server, onOpen }: Props) {
  const m = useMessages();
  const subtitle = describeServer(server, m);
  return (
    <DiscoveryListRow
      onClick={onOpen}
      icon={<PreviewFaviconIcon threadRef={threadRef} url={server.requestedUrl} />}
      title={subtitle}
      description={`${server.host}:${server.port}`}
    />
  );
}

function describeServer(server: PreviewableServer, resolve: MessageResolver): string {
  if (server.processName) return server.processName;
  if (server.listening)
    return resolve(msg("Listening", { $context: "a local server is listening on a port" }));
  if (server.source === "configured") return resolve(msg("Configured"));
  return resolve(msg("Recently seen"));
}
