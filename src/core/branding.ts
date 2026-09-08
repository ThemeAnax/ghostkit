import { Ssh, shellQuote } from "./ssh.js";
import type { SiteLayout } from "./site.js";
import { uploadImage, updateSettings } from "./ghost.js";

/** Deterministic, pleasant accent when the user has not chosen one. */
export function accentFor(title: string): string {
  const palette = ["#2F6FED", "#0E9F6E", "#C2410C", "#7C3AED", "#B91C1C", "#0F766E", "#B45309", "#1D4ED8"];
  let h = 0;
  for (const c of title) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

/** Up to two initials — "Bastian Ghost" becomes BG, "rewire" becomes R. */
export function initialsFor(title: string): string {
  const words = title
    .replace(/\.[a-z]{2,}$/i, "")
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letters = words.slice(0, 2).map((w) => w[0]).join("");
  return (letters || title[0] || "G").toUpperCase();
}

/** White or near-black, whichever stays readable on the accent. */
function contrastOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.45 ? "#111827" : "#FFFFFF";
}

const escapeXml = (s: string) =>
  s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

/** Square monogram, used for the favicon. */
export function iconSvg(title: string, accent: string): string {
  const fg = contrastOn(accent);
  const text = initialsFor(title);
  const size = text.length > 1 ? 118 : 152;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 256 256">` +
    `<rect width="256" height="256" rx="56" fill="${accent}"/>` +
    `<text x="128" y="128" font-family="Helvetica,Arial,sans-serif" font-size="${size}" font-weight="700" ` +
    `fill="${fg}" text-anchor="middle" dominant-baseline="central">${escapeXml(text)}</text>` +
    `</svg>`
  );
}

/** Wordmark: the monogram tile beside the publication name. */
export function logoSvg(title: string, accent: string): string {
  const fg = contrastOn(accent);
  const text = initialsFor(title);
  const name = escapeXml(title.length > 28 ? `${title.slice(0, 27)}…` : title);
  const width = 96 + Math.max(160, name.length * 26);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="112" viewBox="0 0 ${width} 112">` +
    `<rect x="8" y="8" width="96" height="96" rx="24" fill="${accent}"/>` +
    `<text x="56" y="56" font-family="Helvetica,Arial,sans-serif" font-size="${text.length > 1 ? 42 : 54}" ` +
    `font-weight="700" fill="${fg}" text-anchor="middle" dominant-baseline="central">${escapeXml(text)}</text>` +
    `<text x="124" y="58" font-family="Helvetica,Arial,sans-serif" font-size="42" font-weight="600" ` +
    `fill="#111827" dominant-baseline="central">${name}</text>` +
    `</svg>`
  );
}

/**
 * Rasterise on the host with the sharp that Ghost already bundles.
 *
 * Ghost's image upload accepts png/jpeg/gif/webp but not SVG, and shipping a
 * rasteriser inside ghostkit would mean carrying sharp and its binaries for
 * one small job. Ghost's own copy is right there and always matches the host.
 */
async function svgToPng(ssh: Ssh, site: SiteLayout, svg: string, remoteOut: string): Promise<void> {
  const b64 = Buffer.from(svg).toString("base64");
  const script =
    `const sharp=require('sharp');` +
    `const svg=Buffer.from(process.argv[1],'base64');` +
    `sharp(svg).png().toFile(process.argv[2]).then(()=>console.log('ok')).catch(e=>{console.error(e.message);process.exit(1)});`;
  await ssh.must(
    `cd ${shellQuote(`${site.ghostDir}/current`)} && node -e ${shellQuote(script)} ${shellQuote(b64)} ${shellQuote(remoteOut)}`,
    { timeoutMs: 120_000 },
  );
}

export interface BrandingResult {
  accent_color: string;
  initials: string;
  icon_url?: string;
  logo_url?: string;
  settings_applied: string[];
  skipped?: string;
}

/**
 * Generate and apply the branding a theme needs to not look broken: an icon,
 * a logo, an accent colour, a description, and navigation. A theme with no
 * navigation renders an empty header, which reads as a failed install.
 */
export async function applyBranding(
  ssh: Ssh,
  site: SiteLayout,
  adminApiKey: string,
  opts: {
    title: string;
    description?: string;
    accentColor?: string;
    navigation?: Array<{ label: string; url: string }>;
    generateAssets?: boolean;
  },
): Promise<BrandingResult> {
  const accent = opts.accentColor?.trim() || accentFor(opts.title);
  const settings: Record<string, string> = {
    title: opts.title,
    accent_color: accent,
  };
  if (opts.description) settings.description = opts.description;

  const nav = opts.navigation?.length
    ? opts.navigation
    : [
        { label: "Home", url: "/" },
        { label: "About", url: "/about/" },
        { label: "Contact", url: "/contact/" },
      ];
  settings.navigation = JSON.stringify(nav);

  const result: BrandingResult = {
    accent_color: accent,
    initials: initialsFor(opts.title),
    settings_applied: [],
  };

  if (opts.generateAssets !== false) {
    try {
      const dir = "/tmp/ghostkit-brand";
      await ssh.must(`rm -rf ${dir} && mkdir -p ${dir}`);
      await svgToPng(ssh, site, iconSvg(opts.title, accent), `${dir}/icon.png`);
      await svgToPng(ssh, site, logoSvg(opts.title, accent), `${dir}/logo.png`);
      result.icon_url = await uploadImage(ssh, site.port, site.domain, adminApiKey, `${dir}/icon.png`);
      result.logo_url = await uploadImage(ssh, site.port, site.domain, adminApiKey, `${dir}/logo.png`);
      settings.icon = result.icon_url;
      settings.logo = result.logo_url;
      await ssh.exec(`rm -rf ${dir}`);
    } catch (e) {
      // Branding is cosmetic; never fail an install over it.
      result.skipped = `asset generation failed: ${(e as Error).message}`;
    }
  }

  result.settings_applied = await updateSettings(ssh, site.port, site.domain, adminApiKey, settings);
  return result;
}
