import { PermissionUpdateNotice } from "./features/connection/PermissionUpdateNotice";
import * as Linking from "expo-linking";
import * as SplashScreen from "expo-splash-screen";
import { requireNativeModule } from "expo";
import { useEffect, useRef, useState } from "react";
import { Platform, StatusBar } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  createStaticNavigation,
  getActionFromState,
  getStateFromPath,
  type NavigationState,
} from "@react-navigation/native";
import { pipe } from "effect/Function";
import { DEFAULT_HOSTED_APP_URL } from "@d4research/shared/connectAuth";

import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { ProjectChipIconRasterizer } from "./native/ProjectChipIconImages";
import { ThreadArrangementHost } from "./features/threads/ThreadArrangementSheet";
import * as Dialog from "./components/ui/Dialog";
import { prepareNativeShowcaseCapture } from "./features/showcase/nativeShowcaseScene";
import {
  startIncomingShareInbox,
  presentPendingIncomingShare,
  pruneIncomingShareImports,
} from "./features/sharing/IncomingShareProvider";
import { installThreadOutboxDelivery } from "./state/threadOutboxDelivery";
import { installComposerAttachmentUploads } from "./state/composer-attachment-uploads";
import { installAppearanceRuntime } from "./features/settings/appearance/AppearancePreferencesProvider";
import {
  attachRootNavigation,
  rootNavigationRef,
  flushRootNavigationQueue,
} from "./lib/rootNavigation";
import { pruneNewTaskFlowStates } from "./features/threads/new-task-flow-state";
import { pruneNewTaskBranchCheckouts } from "./features/threads/NewTaskDraftRouteScreen";
import { I18nProvider } from "./i18n/I18nProvider";
import { subscribeComposerDraftModelReconciliation } from "./state/use-composer-drafts";
import { environmentThreadShells, threadEnvironment } from "./state/threads";
import { environmentShell, shellCachesReadAtom } from "./state/shell";
import {
  AppearancePreferencesProvider,
  useAppearancePreferences,
} from "./features/settings/appearance/AppearancePreferencesProvider";
import { RootStack } from "./Stack";
import { appAtomRegistry } from "./state/atom-registry";
import { OverlayPortalHost } from "./components/ui/OverlayPortal";
import { shouldHandleAppLink, restoreDraftLinkState } from "./lib/appLinking";
import { useMobileNavigationTheme } from "./lib/useMobileNavigationTheme";
import { useUiRuntimeMemoryWarningGc } from "./lib/useUiRuntimeMemoryWarningGc";
import { SubscriptionUsageCoordinator } from "./widgets/SubscriptionUsageCoordinator";
import { GlobalVoiceInputControl } from "./features/voice-input/GlobalVoiceInputControl";
import {
  launchSplashHomeRowsPending,
  settleLaunchSplashHomeRows,
  splashCanHide,
  useLaunchSplashHomeRowsPending,
} from "./features/home/home-launch-splash";
import {
  restoreSettingsLinkState,
  settingsLinkAction,
} from "./features/settings/settings-navigation";
import {
  hydrateWorkspaceSelections,
  launchWorkspaceURL,
  recordWorkspaceSelections,
  settingsLinkPage,
} from "./features/layout/workspace/workspace-selection-store";
import { takeScheduledTaskNewLink } from "./features/settings/scheduled-task-editor-state";
import {
  pairingFormLinkAction,
  startDevAutoConnect,
  withoutPairingTarget,
} from "./features/connection/devAutoConnect";
import { workspaceDetailLinkAction } from "./features/layout/workspace/workspace-detail-selection";
import { NativeLayoutMetricsProvider } from "./native/native-layout-metrics";

import "../global.css";

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  prepareNativeShowcaseCapture();
}

void SplashScreen.preventAutoHideAsync().catch(() => {});

const appLinking = {
  prefixes: [
    Linking.createURL("/"),
    "t3code://",
    "t3code-dev://",
    "t3code-preview://",
    DEFAULT_HOSTED_APP_URL,
  ],
  config: { initialRouteName: "Home" },
  filter: shouldHandleAppLink,
  getInitialURL: async () => (await Linking.getInitialURL()) ?? (await launchWorkspaceURL()),
  getActionFromState: (
    state: Parameters<typeof getActionFromState>[0],
    options: Parameters<typeof getActionFromState>[1],
  ): ReturnType<typeof getActionFromState> => {
    const current = rootNavigationRef.isReady() ? rootNavigationRef.getRootState() : undefined;
    return (
      // Our router handles the selection; React Navigation's type only lists its own actions.
      (workspaceDetailLinkAction(state) as ReturnType<typeof getActionFromState>) ??
      pairingFormLinkAction(state, current) ??
      settingsLinkAction(state, current) ??
      getActionFromState(state, options)
    );
  },
  getStateFromPath: (path: string, options: Parameters<typeof getStateFromPath>[1]) =>
    pipe(
      getStateFromPath(path, options),
      (state) => restoreDraftLinkState(state, path),
      (state) => restoreSettingsLinkState(state, settingsLinkPage()),
      withoutPairingTarget,
      startDevAutoConnect,
      takeScheduledTaskNewLink,
    ),
};

const Navigation = createStaticNavigation(RootStack);

function handleNavigationStateChange(state: NavigationState | undefined) {
  recordWorkspaceSelections(state);
  presentPendingIncomingShare();
  if (!state) return;
  if (state.routes[state.index]?.name !== "Home") settleLaunchSplashHomeRows();
  pruneNewTaskFlowStates(state);
  pruneNewTaskBranchCheckouts(state);
  pruneIncomingShareImports(state);
}

const SPLASH_WAIT_MS = 1_500;

function SplashScreenCoordinator() {
  const { isReady } = useAppearancePreferences();
  const shellCachesRead = useAtomValue(shellCachesReadAtom);
  const homeRowsPending = useLaunchSplashHomeRowsPending();
  const [waitEnded, setWaitEnded] = useState(false);
  const hidden = useRef(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the limit on how long the native splash screen waits for cached shells and their rows
  useEffect(() => {
    const timer = setTimeout(() => setWaitEnded(true), SPLASH_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- hides the native splash screen once preferences have loaded and the cached rows are laid out
  useEffect(() => {
    const canHide = splashCanHide({
      preferencesReady: isReady,
      shellCachesRead,
      // Home holds the splash in a layout effect of the commit that gives it rows. That can be
      // this commit, after this render read the store.
      homeRowsPending: homeRowsPending || launchSplashHomeRowsPending(),
      waitEnded,
    });
    if (!canHide || hidden.current) return;
    hidden.current = true;
    settleLaunchSplashHomeRows();
    void SplashScreen.hide();
  }, [isReady, shellCachesRead, homeRowsPending, waitEnded]);

  return null;
}

export default function App() {
  useUiRuntimeMemoryWarningGc();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Install application subscriptions and native share, upload, and appearance runtimes until unmount.
  useEffect(() => {
    void hydrateWorkspaceSelections();
    const cleanup = [
      subscribeComposerDraftModelReconciliation({
        registry: appAtomRegistry,
        threadShellAtom: environmentThreadShells.threadShellAtom,
        threadRefsAtom: environmentThreadShells.threadRefsAtom,
        shellStateAtom: environmentShell.stateAtom,
        pendingThreadIdsAtom: threadEnvironment.pendingThreadIdsAtom,
      }),
      startIncomingShareInbox(),
      installThreadOutboxDelivery(),
      installComposerAttachmentUploads(),
      installAppearanceRuntime(),
    ];
    return () => cleanup.forEach((dispose) => dispose());
  }, []);

  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <AppearancePreferencesProvider>
        <I18nProvider>
          <AppContent />
        </I18nProvider>
      </AppearancePreferencesProvider>
    </RegistryContext.Provider>
  );
}

function AppContent() {
  const { themeAppearance } = useAppearancePreferences();
  const navigationTheme = useMobileNavigationTheme();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- matches the Android navigation bar to the app theme, as StatusBar does for the status bar
  useEffect(() => {
    if (Platform.OS !== "android") return;
    void requireNativeModule<{ setNavigationBarStyle(light: boolean): Promise<void> }>(
      "T3NativeControls",
    ).setNavigationBarStyle(themeAppearance === "light");
  }, [themeAppearance]);

  return (
    <>
      <SplashScreenCoordinator />
      <SubscriptionUsageCoordinator />
      <PermissionUpdateNotice />
      <GestureHandlerRootView className="flex-1">
        <KeyboardProvider statusBarTranslucent>
          <SafeAreaProvider>
            <StatusBar barStyle={themeAppearance === "dark" ? "light-content" : "dark-content"} />
            {/* Native-stack forwards the navigation theme to overrideUserInterfaceStyle;
                without it, native headers stay light when the system is dark. */}
            <GlobalVoiceInputControl>
              <NativeLayoutMetricsProvider>
                <Navigation
                  ref={attachRootNavigation}
                  onReady={() => {
                    handleNavigationStateChange(rootNavigationRef.getRootState());
                    flushRootNavigationQueue();
                  }}
                  onStateChange={handleNavigationStateChange}
                  linking={appLinking}
                  theme={navigationTheme}
                />

                <Dialog.Host />
                <ThreadArrangementHost />
                <ProjectChipIconRasterizer />
              </NativeLayoutMetricsProvider>
            </GlobalVoiceInputControl>
            {/* Anchored-menu overlays render here — in-window, so the
                keyboard stays up while a dropdown is open. */}
            <OverlayPortalHost />
          </SafeAreaProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </>
  );
}
