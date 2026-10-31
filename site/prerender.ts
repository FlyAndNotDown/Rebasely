import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer, type Plugin } from "vite";
import { SOFTWARE_APPLICATION } from "./src/product.ts";

export function productMetadata(): Plugin {
  return {
    name: "rebasely-product-metadata",
    transformIndexHtml() {
      return [{
        tag: "script",
        attrs: { type: "application/ld+json" },
        children: JSON.stringify(SOFTWARE_APPLICATION).replace(/</g, "\\u003c"),
        injectTo: "head",
      }];
    },
  };
}

export function prerender(root: string): Plugin {
  let outputDirectory: string;
  return {
    name: "rebasely-prerender",
    apply: "build",
    configResolved(config) {
      outputDirectory = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const server = await createServer({
        configFile: path.join(root, "vite.config.ts"),
        server: { middlewareMode: true, hmr: false },
        appType: "custom",
      });
      try {
        const { render } = await server.ssrLoadModule("/src/entry-server.tsx") as { render: () => Promise<string> };
        const content = await render();
        const filename = path.join(outputDirectory, "index.html");
        const template = await readFile(filename, "utf8");
        const placeholder = '<div id="root"></div>';
        if (!template.includes(placeholder) || !content.includes("<main")) {
          throw new Error("Website prerender did not produce the expected page.");
        }
        await writeFile(filename, template.replace(placeholder, () => `<div id="root" data-prerendered="true">${content}</div>`));
      } finally {
        await server.close();
      }
    },
  };
}
