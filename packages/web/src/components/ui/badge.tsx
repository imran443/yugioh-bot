import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-body font-semibold motion-safe:transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-primary",
  {
    variants: {
      variant: {
        default:
          "bg-accent-primary/10 text-accent-primary border border-accent-primary/20",
        success:
          "bg-accent-success/10 text-accent-success border border-accent-success/20",
        warning:
          "bg-accent-gold/10 text-accent-gold border border-accent-gold/20",
        danger:
          "bg-accent-cta/10 text-accent-cta border border-accent-cta/20",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant, className }))} {...props} />
  );
}

export { Badge, badgeVariants };
