import * as React from "react"
import { cn } from "@/lib/utils"

/** Keep action labels on one line while leaving icons and shortcuts independent. */
export function MenuItemContent({ children }: { children: React.ReactNode }) {
  return React.Children.map(children, (child) => {
    if (React.isValidElement<{ className?: string; children?: React.ReactNode }>(child) && child.type === "span" && menuItemText(child.props.children)) {
      return React.cloneElement(child, { className: cn(child.props.className, "min-w-0 truncate") })
    }
    if (typeof child !== "string" && typeof child !== "number") return child
    if (typeof child === "string" && !child.trim()) return child
    return <span data-slot="menu-item-label" className="min-w-0 flex-1 truncate">{child}</span>
  })
}

/** Native titles preserve complete names when a ref or translated label is clipped. */
export function menuItemText(children: React.ReactNode): string | undefined {
  const text = React.Children.toArray(children).map((child): string => {
    if (typeof child === "string" || typeof child === "number") return String(child)
    if (!React.isValidElement<{ children?: React.ReactNode }>(child)) return ""
    return menuItemText(child.props.children) ?? ""
  }).filter(Boolean).join(" ").trim()
  return text || undefined
}
