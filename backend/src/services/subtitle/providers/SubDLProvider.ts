import axios from 'axios';
import AdmZip from 'adm-zip';
import type { SubtitleProvider, SubtitleResult } from './types.js';

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

  async search(tmdbId: number, language: string): Promise<SubtitleResult | null> {
    const res = await axios.get<SubDLResponse>(this.base, {
      params: {
        tmdb_id: tmdbId,
        languages: language,
        ...(process.env.SUBDL_API_KEY ? { api_key: process.env.SUBDL_API_KEY } : {}),
      },
      timeout: 15000,
    });

    const subtitles = res.data?.subtitles ?? [];
    if (!subtitles.length) return null;

    const best = subtitles[0];
    const downloadUrl = best.url.startsWith('http') ? best.url : `${this.cdn}${best.url}`;

    const zipRes = await axios.get<ArrayBuffer>(downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 20000,
    });

    const content = extractSrt(Buffer.from(zipRes.data));
    if (!content) return null;

    return {
      content,
      score: subtitles.length,
      source: 'subdl',
    };
  }
}

function extractSrt(buffer: Buffer): string | null {
  const zip = new AdmZip(buffer);
  const entry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('.srt'));
  return entry ? entry.getData().toString('utf8') : null;
}
