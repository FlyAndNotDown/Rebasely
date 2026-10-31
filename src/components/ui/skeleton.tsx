import * as React from "react"
import { cn } from "cn"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("loading-placeholder rounded-md bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
