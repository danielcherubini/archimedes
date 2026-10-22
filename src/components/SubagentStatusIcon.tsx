import {
  CircleAlert,
  CheckCircle2,
  LoaderCircle,
} from "lucide-react";
import type { SubagentEntry } from "../store/subagents";
import { cn } from "./lib/utils";

export const STATUS_CHIP_STYLES: Record<SubagentEntry["status"], string> = {
  running: "text-warning",
  completed: "text-success",
  failed: "text-destructive",
};

/**
 * The directory row's status icon (ZCode's `StatusIcon` treatment):
 * running = a spinning loader, completed = a check circle, failed = an
 * alert circle.
 */
export function StatusIcon({ status }: { status: SubagentEntry["status"] }) {
  // `cn()` rather than a template literal: the ink is the LAST argument so it
  // wins any text-colour conflict with what the caller passed, and `cn` drops
  // the loser instead of leaving two inks to be settled by CSS source order.
  const className = "size-4 shrink-0";
  if (status === "running") {
    return <LoaderCircle className={cn(className, "animate-spin text-warning")} />;
  }
  if (status === "completed") {
    return <CheckCircle2 className={cn(className, "text-success")} />;
  }
  return <CircleAlert className={cn(className, "text-destructive")} />;
}
