import { GTProvider } from "gt-react";
import type { ReactNode } from "react";
import { renderToStaticMarkup as render } from "react-dom/server";
import { DEFAULT_LOCALE } from "../src/i18n/locales";

export function renderToStaticMarkup(node: ReactNode): string {
  return render(
    <GTProvider locale={DEFAULT_LOCALE} translations={{}}>
      {node}
    </GTProvider>,
  );
}
