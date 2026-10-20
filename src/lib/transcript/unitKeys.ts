import type { Message } from "../../store/sessions";
import type { RenderUnit } from "../toolGroups";

/**
 * Stable identity key for a single message.
 */
export function messageKey(m: Message): string {
  switch (m.kind) {
    case "tool-call":
      return `tool:${m.id}`;
    case "agent-text":
      return `text:${m.messageId}`;
    case "agent-thought":
      return `thought:${m.messageId}`;
    case "diff":
      return `diff:${m.path}:${m.at}`;
    case "user":
      return `user:${m.at}`;
  }
}

/**
 * Derive array of unique keys for each RenderUnit.
 * Disambiguates duplicate base keys by suffixing `#1`, `#2`, etc.
 */
export function unitKeys(units: RenderUnit[]): string[] {
  const seenCount = new Map<string, number>();
  return units.map((unit) => {
    const firstMsg =
      unit.kind === "changes-group" ? unit.messages[0] : unit.message;
    const baseKey = firstMsg ? messageKey(firstMsg) : "";
    const count = seenCount.get(baseKey) ?? 0;
    seenCount.set(baseKey, count + 1);
    return count === 0 ? baseKey : `${baseKey}#${count}`;
  });
}

/**
 * Checks whether a RenderUnit contains a message matching the specified message key.
 */
export function unitContainsKey(unit: RenderUnit, key: string): boolean {
  if (unit.kind === "single") {
    return messageKey(unit.message) === key;
  }
  return unit.messages.some((m) => messageKey(m) === key);
}

/**
 * Calculates how many RenderUnits have been prepended above the previously first message.
 */
export function prependedUnitCount(
  prevFirstMessageKey: string | undefined,
  units: RenderUnit[],
): number {
  if (!prevFirstMessageKey || units.length === 0) return 0;
  const idx = units.findIndex((unit) => unitContainsKey(unit, prevFirstMessageKey));
  return idx >= 0 ? idx : 0;
}
