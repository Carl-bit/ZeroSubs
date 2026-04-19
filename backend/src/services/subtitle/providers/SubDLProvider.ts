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
      return entry ? entry.getData().toString('utf8') : null;
    } catch {
      return null;
    }
  }
  const text = buffer.toString('utf8');
  return /-->/.test(text) ? text : null;
}
