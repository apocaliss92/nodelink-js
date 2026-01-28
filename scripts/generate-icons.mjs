#!/usr/bin/env node
/**
 * Generate all required icons for PWA from source icon
 * Run: node scripts/generate-icons.mjs
 */

import sharp from "sharp";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "assets/icon.png");
const OUTPUT_DIR = path.join(ROOT, "app/client/public");

// Icon sizes needed for PWA and favicon
const ICONS = [
    // Favicons
    { name: "favicon-16x16.png", size: 16 },
    { name: "favicon-32x32.png", size: 32 },
    { name: "favicon-48x48.png", size: 48 },

    // Apple touch icon
    { name: "apple-touch-icon.png", size: 180 },
    { name: "apple-touch-icon-152x152.png", size: 152 },
    { name: "apple-touch-icon-120x120.png", size: 120 },

    // PWA manifest icons
    { name: "icon-72x72.png", size: 72 },
    { name: "icon-96x96.png", size: 96 },
    { name: "icon-128x128.png", size: 128 },
    { name: "icon-144x144.png", size: 144 },
    { name: "icon-152x152.png", size: 152 },
    { name: "icon-192x192.png", size: 192 },
    { name: "icon-384x384.png", size: 384 },
    { name: "icon-512x512.png", size: 512 },

    // Maskable icons (with padding for safe area)
    { name: "maskable-192x192.png", size: 192, maskable: true },
    { name: "maskable-512x512.png", size: 512, maskable: true },
];

async function generateIcon(source, outputPath, size, maskable = false) {
    const image = sharp(source);

    if (maskable) {
        // Maskable icons need 10% padding on each side (safe area)
        // The actual icon should be 80% of the total size
        const iconSize = Math.round(size * 0.8);
        const padding = Math.round((size - iconSize) / 2);

        await image
            .resize(iconSize, iconSize, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .extend({
                top: padding,
                bottom: padding,
                left: padding,
                right: padding,
                background: { r: 26, g: 26, b: 26, alpha: 1 }, // Dark background matching app theme
            })
            .png()
            .toFile(outputPath);
    } else {
        await image
            .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png()
            .toFile(outputPath);
    }
}

async function generateFavicon(source, outputPath) {
    // Generate ICO file with multiple sizes
    const sizes = [16, 32, 48];
    const buffers = await Promise.all(
        sizes.map((size) =>
            sharp(source)
                .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .png()
                .toBuffer()
        )
    );

    // For simplicity, just use the 32x32 as favicon.ico
    // (proper ICO generation would require a separate library)
    await sharp(source)
        .resize(32, 32, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toFile(outputPath.replace(".ico", ".png"));

    // Copy as favicon.ico (browsers accept PNG with .ico extension)
    await fs.copyFile(outputPath.replace(".ico", ".png"), outputPath);
}

async function main() {
    console.log("🎨 Generating icons from:", SOURCE);
    console.log("📁 Output directory:", OUTPUT_DIR);

    // Ensure output directory exists
    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    // Check source exists
    try {
        await fs.access(SOURCE);
    } catch {
        console.error("❌ Source icon not found:", SOURCE);
        process.exit(1);
    }

    // Generate all icons
    for (const icon of ICONS) {
        const outputPath = path.join(OUTPUT_DIR, icon.name);
        await generateIcon(SOURCE, outputPath, icon.size, icon.maskable);
        console.log(`✅ Generated: ${icon.name} (${icon.size}x${icon.size}${icon.maskable ? " maskable" : ""})`);
    }

    // Generate favicon.ico
    const faviconPath = path.join(OUTPUT_DIR, "favicon.ico");
    await generateFavicon(SOURCE, faviconPath);
    console.log("✅ Generated: favicon.ico");

    console.log("\n🎉 All icons generated successfully!");
    console.log("\nDon't forget to:");
    console.log("1. Add manifest.json to public/");
    console.log("2. Update index.html with icon links");
}

main().catch((err) => {
    console.error("Error:", err);
    process.exit(1);
});
