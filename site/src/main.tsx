import { createRoot, hydrateRoot } from "react-dom/client";
import { IDENTIFIER_PREFIX, SiteRoot } from "./app-root";
import "./styles.css";

const root = document.getElementById("root")!;
if (root.dataset.prerendered === "true") {
  hydrateRoot(root, <SiteRoot />, { identifierPrefix: IDENTIFIER_PREFIX });
} else {
  createRoot(root, { identifierPrefix: IDENTIFIER_PREFIX }).render(<SiteRoot />);
}
