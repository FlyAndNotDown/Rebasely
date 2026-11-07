import { readFile, writeFile, copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import sharp from "sharp";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = (...parts) => path.join(root, ...parts);
const iconDirectory = destination("src-tauri", "icons");
const master = destination("src-tauri", "icons", "app-icon.png");
const brandDirectory = destination("assets", "brand");
const fontfile = destination("node_modules", "@fontsource-variable", "geist", "files", "geist-latin-wght-normal.woff2");

async function imagePng(image, width) {
  return sharp(image).resize(width, width).withIccProfile("srgb").png({ compressionLevel: 9 }).toBuffer();
}

function iconFile(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, image }, index) => {
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(image.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  });
  return Buffer.concat([header, ...images.map(({ image }) => image)]);
}

async function refineSmallIcns(small) {
  const filename = path.join(iconDirectory, "icon.icns");
  const input = await readFile(filename);
  const { data } = await sharp(small[16]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgb = Buffer.alloc(16 * 16 * 3);
  const alpha = Buffer.alloc(16 * 16);
  for (let pixel = 0; pixel < 16 * 16; pixel++) {
    for (let channel = 0; channel < 3; channel++) rgb[pixel * 3 + channel] = data[pixel * 4 + channel];
    alpha[pixel] = data[pixel * 4 + 3];
  }
  const replacements = { is32: rgb, s8mk: alpha, ic11: small[32] };
  const chunks = [];
  for (let offset = 8; offset < input.length;) {
    const type = input.toString("ascii", offset, offset + 4);
    const length = input.readUInt32BE(offset + 4);
    const content = replacements[type] ?? input.subarray(offset + 8, offset + length);
    const header = Buffer.alloc(8);
    header.write(type);
    header.writeUInt32BE(content.length + 8, 4);
    chunks.push(header, content);
    offset += length;
  }
  const header = Buffer.alloc(8);
  header.write("icns");
  header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  await writeFile(filename, Buffer.concat([header, ...chunks]));
}

async function shareImage(width, height, icon) {
  const heading = await sharp({ text: { text: "RebaseRaven", font: "Geist Medium 88", fontfile, rgba: true, dpi: 72 } }).png().toBuffer({ resolveWithObject: true });
  const subtitle = await sharp({ text: { text: '<span foreground="#666b73">Git + Perforce desktop client</span>', font: "Geist 32", fontfile, rgba: true, dpi: 72 } }).png().toBuffer({ resolveWithObject: true });
  const iconSize = 172;
  const gap = 30;
  const blockWidth = iconSize + gap + Math.max(heading.info.width, subtitle.info.width);
  const left = Math.round((width - blockWidth) / 2);
  const textTop = Math.round((height - heading.info.height - subtitle.info.height - 25) / 2);
  return sharp({ create: { width, height, channels: 4, background: "#fafafa" } }).composite([
    { input: await imagePng(icon, iconSize), left, top: Math.round((height - iconSize) / 2) },
    { input: heading.data, left: left + iconSize + gap, top: textTop },
    { input: subtitle.data, left: left + iconSize + gap, top: textTop + heading.info.height + 25 },
  ]).withIccProfile("srgb").png({ compressionLevel: 9 }).toBuffer();
}

async function generate() {
  const mark = await readFile(destination("assets", "brand", "raven.svg"), "utf8");
  const inner = mark.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const foreground = inner.replace(/<path data-layer="rear-wing"[^>]*\/>/, "");
  const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="4" y="4" width="120" height="120" rx="27" fill="#101216"/><svg x="6" y="24" width="116" height="79" viewBox="200 280 850 580" color="#f4f5f8">${foreground}</svg></svg>\n`;
  await mkdir(brandDirectory, { recursive: true });
  await writeFile(path.join(brandDirectory, "favicon.svg"), favicon);
  const icon = await readFile(master);
  const generated = await mkdtemp(path.join(os.tmpdir(), "rebaseraven-icons-"));
  try {
    execFileSync(process.execPath, [destination("node_modules", "@tauri-apps", "cli", "tauri.js"), "icon", master, "--output", generated], { cwd: root, stdio: "inherit" });
    for (const file of await readdir(generated, { withFileTypes: true })) {
      if (file.isFile() && /\.(?:png|ico|icns)$/.test(file.name)) await copyFile(path.join(generated, file.name), path.join(iconDirectory, file.name));
    }
  } finally {
    await rm(generated, { recursive: true, force: true });
  }
  const small = {};
  for (const size of [16, 24, 32, 48, 64, 96]) small[size] = await imagePng(Buffer.from(favicon), size);
  const desktop = [];
  for (const size of [32, 16, 24, 48, 64, 256]) desktop.push({ size, image: size < 32 ? small[size] : await imagePng(icon, size) });
  await writeFile(path.join(iconDirectory, "icon.ico"), iconFile(desktop));
  await refineSmallIcns(small);
  await writeFile(destination("public", "assets", "mark.png"), await imagePng(icon, 256));
  await copyFile(destination("public", "assets", "mark.png"), destination("site", "public", "assets", "mark.png"));
  await writeFile(destination("public", "favicon.png"), small[64]);
  await writeFile(destination("site", "public", "assets", "favicon.png"), small[96]);
  await writeFile(destination("site", "public", "assets", "favicon-32.png"), small[32]);
  await writeFile(destination("site", "public", "assets", "favicon.ico"), iconFile([16, 24, 32, 48, 64].map(size => ({ size, image:small[size] }))));
  await copyFile(path.join(brandDirectory, "favicon.svg"), destination("site", "public", "assets", "favicon.svg"));
  await copyFile(path.join(brandDirectory, "raven.svg"), destination("site", "public", "assets", "raven.svg"));
  await writeFile(destination("site", "public", "assets", "social.png"), await shareImage(1200, 630, icon));
  await writeFile(path.join(brandDirectory, "github-social.png"), await shareImage(1280, 640, icon));
  console.log("Generated RebaseRaven desktop, web, favicon, and social assets.");
}

await generate();
