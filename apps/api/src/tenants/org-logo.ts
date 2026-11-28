import type { Response } from 'express';
import { imageType } from '../common/image-type.js';

/** The organisation's logo is at most as large as a project's. */
export const LOGO_MAX = 512 * 1024;

/** Kinds of image the organisation's logo may be. */
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp']);

/**
 * The type of an organisation logo from its first bytes (the file name and declared type are not
 * trusted), as the project logo's check sees it, or null. Only PNG, JPEG and WebP: SVG can carry
 * scripts and nothing here makes it safe, and an animated GIF has no place in the side panel.
 */
export function orgLogoType(b: Buffer): string | null {
  const type = imageType(b);
  return type && ALLOWED.has(type) ? type : null;
}

/**
 * Sends a logo image. Its address changes with the logo (`?v=`), so it can be kept a day. The
 * image is never read as anything else (`nosniff`), and if it were opened on its own nothing in it
 * could run (`default-src 'none'`).
 */
export function sendLogo(
  res: Response,
  logo: { contentType: string; image: Buffer },
  cache: 'private' | 'public',
) {
  res.setHeader('Content-Type', logo.contentType);
  res.setHeader('Cache-Control', `${cache}, max-age=86400`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Content-Disposition', 'inline; filename="logo"');
  res.end(logo.image);
}

/** The address the web app draws the logo from; it changes with the logo, so it can be cached. */
export function logoUrl(path: string, updatedAt: Date): string {
  return `/api/v1/${path}?v=${updatedAt.getTime()}`;
}
