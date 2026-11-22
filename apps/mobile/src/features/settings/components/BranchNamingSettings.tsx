import { msg, T, useGT, useMessages } from "gt-react-native";
import { BranchNamingMode, type ServerSettingsPatch } from "@d4research/contracts";
import { useEffect, useEffectEvent, useRef } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { SettingsChoiceRow } from "./SettingsChoiceRow";
import { SettingsSection } from "./SettingsSection";

const MODES = {
  static: {
    label: msg("Static prefix"),
    description: msg("Add your prefix to the generated branch name."),
  },
  semantic: {
    label: msg("Semantic prefix"),
    description: msg("Let the model choose {examples}, or another prefix.", {
      examples: "feat/, fix/, refactor/",
    }),
  },
  custom: {
    label: msg("Custom instructions"),
    description: msg("Generate the complete name with no added prefix or suffix."),
  },
} satisfies Record<BranchNamingMode, { label: string; description: string }>;

export function BranchNamingSettings(props: {
  mode: BranchNamingMode | null;
  prefix: string | null;
  instructions: string | null;
  /** Per setting, since a policy can lock one and leave the others to the user. */
  disabled: Readonly<Record<"mode" | "prefix" | "instructions", boolean>>;
  onChange: (patch: ServerSettingsPatch) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const drafts = useRef<{
    prefix?: { saved: string | null; text: string };
    instructions?: { saved: string | null; text: string };
  }>({});
  const saveDrafts = (field?: "prefix" | "instructions") => {
    const patch: { branchNamePrefix?: string; branchNameInstructions?: string } = {};
    for (const key of ["prefix", "instructions"] as const) {
      if (field !== undefined && key !== field) continue;
      const draft = drafts.current[key];
      delete drafts.current[key];
      if (!draft || draft.saved !== props[key] || draft.text.trim() === props[key]) continue;
      if (key === "prefix") patch.branchNamePrefix = draft.text.trim();
      else patch.branchNameInstructions = draft.text.trim();
    }
    if (Object.keys(patch).length > 0) props.onChange(patch);
  };
  // Android Back can unmount the screen without emitting onEndEditing.
  const saveOnUnmount = useEffectEvent(() => saveDrafts());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Flush native input drafts when Android Back removes the screen without an editing event.
  useEffect(() => () => saveOnUnmount(), []);
  return (
    <SettingsSection
      title={gt("Worktree branch naming")}
      trailing={
        props.mode === null ? (
          <Text className="text-xs text-foreground-muted">
            <T>Mixed</T>
          </Text>
        ) : null
      }
    >
      {BranchNamingMode.literals.map((mode, index) => (
        <SettingsChoiceRow
          key={mode}
          label={m(MODES[mode].label)}
          description={m(MODES[mode].description)}
          selected={props.mode === mode}
          separated={index > 0}
          disabled={props.disabled.mode}
          onPress={() => props.onChange({ branchNamingMode: mode })}
        />
      ))}
      {props.mode === "static" ? (
        <View className="gap-2 px-4 py-3">
          <Text className="text-sm text-foreground-muted">
            {gt("Use {short} or {slash} for {example}. Leave empty for no prefix.", {
              short: "t3",
              slash: "d4research/",
              example: "d4research/add-search",
            })}
          </Text>
          <AppTextInput
            key={props.prefix}
            accessibilityLabel={gt("Branch prefix")}
            onChangeText={(text) => {
              drafts.current.prefix = { saved: props.prefix, text };
            }}
            defaultValue={props.prefix ?? ""}
            placeholder={props.prefix === null ? gt("Mixed") : gt("No prefix")}
            editable={!props.disabled.prefix}
            autoCapitalize="none"
            autoCorrect={false}
            className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
            onEndEditing={(event) => {
              if (!drafts.current.prefix) return;
              drafts.current.prefix.text = event.nativeEvent.text;
              saveDrafts("prefix");
            }}
          />
        </View>
      ) : null}
      {props.mode === "custom" ? (
        <View className="gap-2 px-4 py-3">
          <Text className="text-sm text-foreground-muted">
            <T>Append instructions to the naming prompt.</T>
          </Text>
          <AppTextInput
            key={props.instructions}
            accessibilityLabel={gt("Branch naming instructions")}
            onChangeText={(text) => {
              drafts.current.instructions = { saved: props.instructions, text };
            }}
            defaultValue={props.instructions ?? ""}
            placeholder={
              props.instructions === null
                ? gt("Mixed. Enter instructions for all selected targets.")
                : gt("Use {prefix} followed by the issue ID and a short description.", {
                    prefix: "julius/",
                  })
            }
            editable={!props.disabled.instructions}
            multiline
            autoCapitalize="sentences"
            className="min-h-24 rounded-xl px-3 py-2 text-base text-foreground"
            onEndEditing={(event) => {
              if (!drafts.current.instructions) return;
              drafts.current.instructions.text = event.nativeEvent.text;
              saveDrafts("instructions");
            }}
          />
        </View>
      ) : null}
    </SettingsSection>
  );
}
