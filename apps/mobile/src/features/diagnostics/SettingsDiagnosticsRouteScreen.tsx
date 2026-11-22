import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { T, useGT } from "gt-react-native";
import { useEffect, useState } from "react";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import {
  formatStartupCrashReport,
  parseStartupCrashRecords,
  type StartupCrashRecord,
} from "./crash-log-model";

// expo-updates keeps its persistent log this long. Reading any further back
// returns nothing, so this is the whole available window.
const LOG_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type CrashLogState =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly records: ReadonlyArray<StartupCrashRecord> };

function appIdentity() {
  return {
    version: Constants.expoConfig?.version ?? "0.0.0",
    build:
      (Platform.OS === "ios"
        ? Constants.platform?.ios?.buildNumber
        : Constants.platform?.android?.versionCode?.toString()) ?? "dev",
  };
}

export function SettingsDiagnosticsRouteScreen() {
  const insets = useSafeAreaInsets();
  const gt = useGT();
  const [state, setState] = useState<CrashLogState>(() =>
    Updates.isEnabled ? { status: "loading" } : { status: "unavailable" },
  );
  const [copied, setCopied] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Read the native Expo update log for this mounted diagnostics screen and ignore late results.
  useEffect(() => {
    if (!Updates.isEnabled) return;
    let cancelled = false;
    Updates.readLogEntriesAsync(LOG_WINDOW_MS)
      .then((entries) => {
        if (cancelled) return;
        setState({ status: "ready", records: parseStartupCrashRecords(entries) });
      })
      .catch((error: unknown) => {
        console.warn("[diagnostics] could not read the expo-updates log", error);
        if (!cancelled) setState({ status: "unavailable" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const records = state.status === "ready" ? state.records : [];
  const copyReport = async () => {
    const ok = await tryCopyTextWithHaptic(formatStartupCrashReport(records, appIdentity()), {
      target: "crash report",
    });
    if (ok) setCopied(true);
  };

  return (
    <SettingsScreen title={gt("Diagnostics")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title={gt("Startup crashes")}>
          {state.status === "loading" ? (
            <View className="items-center gap-3 px-6 py-8">
              <AppActivityIndicator />
              <Text className="text-center text-sm text-foreground-muted">
                <T>Reading crash log…</T>
              </Text>
            </View>
          ) : state.status === "unavailable" ? (
            <EmptyState
              icon="exclamationmark.triangle"
              title={gt("Crash log unavailable")}
              detail={gt("Startup crash records are unavailable in this build.")}
            />
          ) : records.length === 0 ? (
            <EmptyState
              icon="checkmark.circle"
              title={gt("No startup crashes")}
              detail={gt("No startup crashes recorded in the last 7 days.")}
            />
          ) : (
            records.map((record, index) => (
              <CrashRow key={record.timestamp} record={record} first={index === 0} />
            ))
          )}
        </SettingsSection>

        <View className="gap-3">
          <SettingsSection title={gt("Actions")}>
            <SettingsActionRow
              icon={copied ? "checkmark" : "doc.on.doc"}
              label={copied ? gt("Copied") : gt("Copy crash report")}
              disabled={state.status !== "ready"}
              onPress={() => void copyReport()}
            />
          </SettingsSection>
          <Text className="px-2 text-sm leading-normal text-foreground-muted">
            <T>
              Paste the report into a GitHub issue. It contains the app version, the JavaScript
              error message, and the component stack. Error messages can quote values from the app,
              so read it over before sharing.
            </T>
          </Text>
        </View>
      </ScrollView>
    </SettingsScreen>
  );
}

function EmptyState(props: {
  readonly icon: "exclamationmark.triangle" | "checkmark.circle";
  readonly title: string;
  readonly detail: string;
}) {
  return (
    <View className="items-center gap-2 px-6 py-8">
      <SymbolView
        name={props.icon}
        size={28}
        tintColorClassName="accent-icon"
        type="monochrome"
        weight="regular"
      />
      <Text className="text-center text-base text-foreground">{props.title}</Text>
      <Text className="text-center text-sm text-foreground-muted">{props.detail}</Text>
    </View>
  );
}

function CrashRow(props: { readonly record: StartupCrashRecord; readonly first: boolean }) {
  const { record } = props;
  return (
    <View className={props.first ? "gap-1.5 p-4" : "gap-1.5 border-t border-border-subtle p-4"}>
      <Text className="text-xs text-foreground-muted">
        {new Date(record.timestamp).toLocaleString()}
      </Text>
      <Text selectable className="text-base leading-snug text-danger-foreground">
        {record.description}
      </Text>
      {record.frames.length > 0 ? (
        <Text selectable className="font-mono text-xs leading-snug text-foreground-muted">
          {record.frames.slice(0, 4).join("\n")}
        </Text>
      ) : null}
    </View>
  );
}
