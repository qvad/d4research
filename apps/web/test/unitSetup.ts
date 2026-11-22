import { initializeGT } from "gt-react";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "../src/i18n/locales";

initializeGT({
  defaultLocale: DEFAULT_LOCALE,
  locales: [...SUPPORTED_LOCALES],
});
