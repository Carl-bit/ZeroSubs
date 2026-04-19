import axios from 'axios';
import AdmZip from 'adm-zip';
import type { SubtitleProvider, SubtitleResult, SubtitleSearchQuery } from './types.js';

interface SubDLSubtitle {
  url: string;
  lang: string;
  name?: string;
  hi?: boolean;
}

interface SubDLResponse {
  status: boolean;
  subtitles?: SubDLSubtitle[];
}

export class SubDLProvider implements SubtitleProvider {
  private readonly base = 'https://api.subdl.com/api/v1/subtitles';
  private readonly cdn = 'https://dl.subdl.com';

  async search(q: SubtitleSearchQuery): Promise<SubtitleResult | null> {
    const params: Record<string, string | number> = {
      tmdb_id: q.tmdbId,
      languages: q.language,
      type: q.mediaType, // movie | tv
      ...(process.env.SUBDL_API_KEY ? { api_key: process.env.SUBDL_API_KEY } : {}),
    };
    if (q.mediaType === 'tv' && q.season != null) params.season_number = q.season;
    if (q.mediaType === 'tv' && q.episode != null) params.episode_number = q.episode;

    const res = await axios.get<SubDLResponse>(this.base, {
      params,
      timeout: 15000,
    });

    const subtitles = res.data?.subtitles ?? [];
    if (!subtitles.length) return null;

    const best = subtitles[0];
    const downloadUrl = best.url.startsWith('http') ? best.url : `${this.cdn}${best.url}`;

    const dlRes = await axios.get<ArrayBuffer>(downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 20000,
    });

    const content = extractSrt(Buffer.from(dlRes.data));
    if (!content) return null;

    return {
      content,
      score: subtitles.length,
      source: 'subdl',
    };
  }
}

function extractSrt(buffer: Buffer): string | null {
  // ZIP magic bytes: PK\x03\x04
  const isZip = buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (isZip) {
    try {
      const zip = new AdmZip(buffer);
      const entry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('.srt'));
      if (!entry) return null;
      return sanitize(decodeBuffer(entry.getData()));
    } catch {
      return null;
    }
  }
  const text = sanitize(decodeBuffer(buffer));
  return /-->/.test(text) ? text : null;
}

function decodeBuffer(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le');
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.alloc(buf.length - 2);
    for (let i = 2; i < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1] ?? 0;
      swapped[i - 1] = buf[i] ?? 0;
    }
    return swapped.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  return buf.toString('utf8');
}

function sanitize(s: string): string {
  // Postgres text no acepta 0x00. Tambien limpiamos replacement char de decodes fallidos.
  return s.replace(/\u0000/g, '').replace(/\uFFFD/g, '');
}
