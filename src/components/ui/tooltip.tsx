"use client"

import * as React from "react"
import type { ReactElement, ReactNode } from "react"
import { cn } from "cn"
import { Tooltip as TooltipPrimitive } from "radix-ui"

const TIP_DELAY = 600

function TooltipProvider({
  delayDuration = TIP_DELAY,
  skipDelayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  side = "bottom",
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        side={side}
        sideOffset={sideOffset}
        className={cn(
          "z-50 inline-flex w-fit max-w-xs origin-(--radix-tooltip-content-transform-origin) items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs text-background has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 rotate-45 rounded-[2px] bg-foreground fill-foreground data-[side=bottom]:translate-y-[calc(50%+2px)] data-[side=left]:-translate-x-[calc(50%+2px)] data-[side=right]:translate-x-[calc(50%+2px)] data-[side=top]:-translate-y-[calc(50%+2px)]" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

function HoverTip({
  label,
  side,
  className,
  children,
}: {
  label?: ReactNode
  side?: "top" | "right" | "bottom" | "left"
  className?: string
  children: ReactElement
}) {
  if (label == null || label === false || label === "") return children
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent
        side={side}
        align="start"
        className={cn(
          "max-w-sm items-start text-left whitespace-pre-line wrap-break-word",
          className,
        )}
      >
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export { HoverTip, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
