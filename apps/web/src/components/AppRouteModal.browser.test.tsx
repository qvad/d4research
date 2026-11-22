import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { useCommitOnBlur } from "../hooks/useCommitOnBlur";
import { AppRouteModal } from "./AppRouteModal";

vi.mock("./chat/GlobalVoiceInputIndicator", () => ({ GlobalVoiceInputIndicator: () => null }));

function CommitOnBlurField({ onCommit }: { onCommit: (next: string) => void }) {
  return <input aria-label="Instructions" {...useCommitOnBlur("", onCommit)} />;
}

describe("AppRouteModal", () => {
  it("keeps navigation outside the pane accessible without dismissing settings", async () => {
    const onNavigate = vi.fn();
    await using _screen = await render(
      <>
        <button onClick={onNavigate}>Open navigation</button>
        <AppRouteModal label="Settings">
          <input aria-label="Instructions" />
        </AppRouteModal>
      </>,
      { router: "/settings/general" },
    );

    await page.getByRole("textbox", { name: "Instructions" }).fill("Keep this draft");
    await page.getByRole("button", { name: "Open navigation" }).click();
    expect(onNavigate).toHaveBeenCalledOnce();
    await expect
      .element(page.getByRole("textbox", { name: "Instructions" }))
      .toHaveValue("Keep this draft");
  });

  it("keeps the settings pane inside the app content lane", async () => {
    await using screen = await render(
      <div style={{ display: "flex", width: 600, height: 400, marginTop: 80 }}>
        <nav aria-label="Main navigation" style={{ width: 200, flexShrink: 0 }}>
          Navigation
        </nav>
        <AppRouteModal label="Settings">
          <input aria-label="Instructions" />
        </AppRouteModal>
      </div>,
      { router: "/settings/general" },
    );

    await expect.element(page.getByRole("textbox", { name: "Instructions" })).toBeVisible();
    const navigation = screen.container.querySelector("nav")!.getBoundingClientRect();
    const pane = page.getByRole("dialog", { name: "Settings" }).element().getBoundingClientRect();
    expect(pane.left).toBeGreaterThanOrEqual(navigation.right);
    expect(pane.top).toBeGreaterThanOrEqual(navigation.top);
    expect(pane.width).toBeLessThanOrEqual(400);
  });

  it("commits a focused field when Esc closes it", async () => {
    const onCommit = vi.fn();
    await using _screen = await render(
      <AppRouteModal label="Settings">
        <CommitOnBlurField onCommit={onCommit} />
      </AppRouteModal>,
      { router: "/settings/general" },
    );

    await page.getByRole("textbox", { name: "Instructions" }).fill("Keep titles short");
    await userEvent.keyboard("{Escape}");

    expect(onCommit).toHaveBeenCalledWith("Keep titles short");
  });

  it("returns focus to the opener when Esc closes it", async () => {
    const opener = <button type="button">Open usage</button>;
    await using screen = await render(opener, { router: "/" });
    const openerButton = screen.getByRole("button", { name: "Open usage" });
    (openerButton.element() as HTMLElement).focus();

    await screen.rerender(
      <>
        {opener}
        <AppRouteModal label="Usage">
          <p>Usage</p>
        </AppRouteModal>
      </>,
    );
    await expect.element(page.getByRole("dialog", { name: "Usage" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");

    await expect.element(page.getByRole("dialog", { name: "Usage" })).not.toBeInTheDocument();
    await expect.element(openerButton).toHaveFocus();
  });

  it("stays open when Esc belongs to a modal outside Base UI", async () => {
    await using _screen = await render(
      <AppRouteModal label="Settings">
        <CommitOnBlurField onCommit={() => undefined} />
      </AppRouteModal>,
      { router: "/settings/general" },
    );
    const settings = page.getByRole("dialog", { name: "Settings" });
    // Base UI takes initial focus a frame after opening; let it land before Clerk's modal takes focus.
    await expect.element(settings).toHaveFocus();
    // Clerk renders its account modal in its own root and dismisses on a document Esc listener.
    const foreignModal = document.body.appendChild(document.createElement("input"));
    using _foreignModal = { [Symbol.dispose]: () => foreignModal.remove() };

    foreignModal.focus();
    await userEvent.keyboard("{Escape}");

    await expect.element(settings).toHaveAttribute("data-open");
  });
});
