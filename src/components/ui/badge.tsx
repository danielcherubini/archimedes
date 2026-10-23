import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/components/lib/utils";

// Retained on purpose, still with ZERO importers (Task A6 / finding 17 kept it — NOT ADR 0072, which
// is about unconsumed palette TOKENS and never mentions this file; an earlier draft of this comment
// cited it wrongly). `badgeVariants` below has one importer, and it is a test.
//
// Task C2 looked at this primitive as the home for the settings badge and did NOT
// add a `settings` variant — that is a recorded decision, not an omission
// (Finding 6c, route (b); the measurement and its reason are pinned in
// `src/components/settings/primitives.test.tsx`). The short version: `SettingsBadge`
// is a plain inline `rounded-md bg-surface px-2.5 py-1 text-ui-base
// text-foreground-subtle` box, and the geometry a `settings` arm would have to
// fight lives in the BASE below — `h-5`, `w-fit`, `rounded-full`, `px-2 py-0.5`,
// `text-ui-xs`, `overflow-hidden`, `transition-all`, `[&>svg]:size-2.5!` — which
// a cva arm is APPENDED to, not substituted for. Neutralising those still leaves
// `inline-flex`/`items-center`/`shrink-0`, `border-transparent`, the
// `focus-visible:` ring machinery and `[&>svg]:pointer-events-none` on all 20
// settings sites, i.e. a repaint of every badge in Settings to save one class
// string. `settings/primitives.tsx`'s `SettingsBadge` stays the owner.
//
// The related trap for C7: `defaultVariants.variant = "default"` means a bare
// `<Badge>` is `bg-primary` — naming a variant is never optional here.
const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-ui-xs font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-2.5!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary: "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive:
          "bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
        outline:
          "border-border bg-input/20 text-foreground dark:bg-input/30 [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost: "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
