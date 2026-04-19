import axios from 'axios';
import AdmZip from 'adm-zip';
import type { SubtitleProvider, SubtitleResult, SubtitleSearchQuery } from './types.js';

interface PodnapisiResult {
  id: string;
  download: string;
  stats?: { downloads?: number };
}

interface PodnapisiResponse {
  data?: PodnapisiResult[];
  results?: PodnapisiResult[];
}

export class PodnapisiProvider implements SubtitleProvider {
  private readonly base = 'https://www.podnapisi.net';

  async search(q: SubtitleSearchQuery): Promise<SubtitleResult | null> {
    const params: Record<string, string | number> = {
      tmdb: q.tmdbId,
      language: q.language,
      format: 'json',
    };
    if (q.mediaType === 'tv' && q.season != null) params.seasons = q.season;
    if (q.mediaType === 'tv' && q.episode != null) params.episodes = q.episode;

    const res = await axios.get<PodnapisiResponse>(`${this.base}/subtitles/search/old`, {
      params,
      timeout: 15000,
    });

    const results = res.data?.data ?? res.data?.results ?? [];
    if (!results.length) return null;

    const best = results.reduce((a, b) =>
      (b.stats?.downloads ?? 0) > (a.stats?.downloads ?? 0) ? b : a,
    );

    const downloadUrl = best.download.startsWith('http')
      ? best.download
      : `${this.base}${best.download}`;

    const zipRes = await axios.get<ArrayBuffer>(downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 20000,
    });

    const content = extractSrt(Buffer.from(zipRes.data));
    if (!content) return null;

    return {
      content,
      score: best.stats?.downloads ?? 0,
      source: 'podnapisi',
    };
  }
}

function extractSrt(buffer: Buffer): string | null {
  const zip = new AdmZip(buffer);
  const entry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('.srt'));
  return entry ? entry.getData().toString('utf8') : null;
}
