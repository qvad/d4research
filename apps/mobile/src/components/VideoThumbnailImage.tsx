import { Image } from "expo-image";
import { useIsFocused } from "@react-navigation/native";
import type { VideoThumbnail } from "expo-video";
import { useEffect, useState } from "react";
import { StyleSheet } from "react-native";

import type { DraftComposerFileAttachment } from "../lib/composerImages";
import { loadLocalAttachmentPreview } from "../lib/localAttachmentPreview";
import { cachedVideoThumbnail, loadVideoThumbnail } from "../lib/videoThumbnails";

export function VideoThumbnailImage(props: {
  readonly cacheKey: string;
  readonly source: string | DraftComposerFileAttachment | null;
  readonly contentFit?: "cover" | "contain";
}) {
  const { cacheKey, source } = props;
  // Extraction starts only while the screen is focused; leaving it skips queued loads.
  const isFocused = useIsFocused();
  const [loaded, setLoaded] = useState<{ key: string; thumbnail: VideoThumbnail } | null>(null);
  const thumbnail = loaded?.key === cacheKey ? loaded.thumbnail : cachedVideoThumbnail(cacheKey);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Acquire a native thumbnail cache resource while this focused preview is mounted.
  useEffect(() => {
    if (!source || !isFocused) return;
    const controller = new AbortController();
    void loadVideoThumbnail(
      cacheKey,
      async (signal) =>
        typeof source === "string"
          ? { uri: source, dispose: () => undefined }
          : loadLocalAttachmentPreview(source, signal),
      controller.signal,
    ).then((thumbnail) => {
      if (thumbnail && !controller.signal.aborted) setLoaded({ key: cacheKey, thumbnail });
    });
    return () => controller.abort();
  }, [cacheKey, source, isFocused]);

  // iOS draws a frame object the moment its prop is set, with the contentFit the view has then,
  // and a later contentFit never refits it. Send the frame after mount so contentFit is set first.
  const [laidOut, setLaidOut] = useState(false);
  return (
    <Image
      onLayout={() => setLaidOut(true)}
      source={laidOut ? thumbnail : null}
      style={StyleSheet.absoluteFill}
      contentFit={props.contentFit ?? "cover"}
      recyclingKey={cacheKey}
      accessible={false}
    />
  );
}
