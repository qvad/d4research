import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { T, useGT } from "gt-react";
import { XIcon } from "lucide-react";
import { useRef, useState, type CSSProperties, type ReactNode } from "react";

import { getCommandPaletteOpener } from "../commandPaletteStore";
import { useNativeTitlebarHeight } from "../lib/windowControlsOverlay";
import { requestWorkspaceFocus } from "../lib/workspaceFocus";
import { useCloseAppModal } from "./sidebar/mainAppLocation";
import { GlobalVoiceInputIndicator } from "./chat/GlobalVoiceInputIndicator";
import { Button } from "./ui/button";
import { SidebarInset } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * Settings and Usage keep the main sidebar available. Esc and the close button return
 * to the page that opened them. Keyboard guards that skip dialogs exempt
 * `[data-app-modal]`, because these pages own their shortcuts.
 */
export function AppRouteModal({ label, children }: { label: string; children: ReactNode }) {
  const closeAppModal = useCloseAppModal();
  const [open, setOpen] = useState(true);
  // Focus the surface, not its first control: no stray focus ring, no phone keyboard.
  // On close, return focus to the opener only after a keyboard close; after a pointer close it
  // would paint a focus ring.
  const popupRef = useRef<HTMLDivElement>(null);
  const [opener] = useState(
    () =>
      getCommandPaletteOpener() ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null),
  );
  const nativeTitlebarHeight = useNativeTitlebarHeight();
  const [paneElement, setPaneElement] = useState<HTMLElement | null>(null);

  return (
    <DialogPrimitive.Root
      open={open}
      modal={false}
      // Sidebar navigation must not dismiss the page before its destination is selected.
      disablePointerDismissal
      onOpenChange={(nextOpen, eventDetails) => {
        if (nextOpen) return;
        // Esc from a layer outside Base UI (Clerk's modals) is that layer's to handle.
        const target = eventDetails.event.target;
        if (
          eventDetails.reason === "escape-key" &&
          target !== document.body &&
          target instanceof Node &&
          !popupRef.current?.contains(target)
        ) {
          return eventDetails.cancel();
        }
        // Closing unmounts a focused field without a blur, so commit-on-blur rows would
        // drop what was typed. Blur first so they commit.
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && popupRef.current?.contains(focused)) focused.blur();
        setOpen(false);
      }}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) void closeAppModal();
      }}
    >
      <SidebarInset ref={setPaneElement}>
        {paneElement ? (
          <DialogPrimitive.Portal container={paneElement} className="contents">
            <DialogPrimitive.Popup
              ref={popupRef}
              initialFocus={popupRef}
              finalFocus={(closeType) => {
                if (closeType !== "keyboard" || !opener?.isConnected) return false;
                if (!opener.closest("[inert]")) return opener;
                // The thread behind the modal stays inert until the route closes, so its area
                // takes focus once it is usable again.
                const area = opener.closest<HTMLElement>("[data-workspace-area]");
                if (area?.dataset.workspaceArea)
                  requestWorkspaceFocus({ area: area.dataset.workspaceArea });
                return false;
              }}
              aria-label={label}
              data-slot="dialog-popup"
              data-app-modal=""
              style={
                {
                  "--app-modal-top-inset": `max(var(--workspace-topbar-height), env(safe-area-inset-top), ${nativeTitlebarHeight}px)`,
                } as CSSProperties
              }
              className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground outline-none max-md:pt-(--app-modal-top-inset) max-md:pb-safe [-webkit-app-region:no-drag]"
            >
              {children}
              <GlobalVoiceInputIndicator />
            </DialogPrimitive.Popup>
          </DialogPrimitive.Portal>
        ) : null}
      </SidebarInset>
    </DialogPrimitive.Root>
  );
}

export function AppRouteModalClose() {
  const gt = useGT();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <DialogPrimitive.Close
            aria-label={gt("Close")}
            render={<Button size="icon-sm" variant="ghost" />}
          />
        }
      >
        <XIcon />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        <T>Close (Esc)</T>
      </TooltipPopup>
    </Tooltip>
  );
}
