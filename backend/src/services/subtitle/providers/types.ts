export type MediaType = 'movie' | 'tv';

export interface SubtitleSearchQuery {
  tmdbId: number;
  language: string;
  mediaType: MediaType;
  season?: number;
  episode?: number;
}

export interface SubtitleResult {
  content: string;
  score: number;
  source: string;
}

export interface SubtitleProvider {
  search(query: SubtitleSearchQuery): Promise<SubtitleResult | null>;
}
