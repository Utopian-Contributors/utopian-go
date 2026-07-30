export interface MetaUrl {
  netloc?: string;
  path?: string;
}

export interface Profile {
  name?: string;
  url?: string;
}

export interface Thumbnail {
  src: string;
}

export interface ClusterLink {
  title: string;
  url: string;
  description?: string;
}

export interface WebResult {
  title: string;
  url: string;
  description: string;
  profile?: Profile;
  meta_url?: MetaUrl;
  cluster?: ClusterLink[];
  age?: string;
}

export interface Infobox {
  title: string;
  description?: string;
  long_desc?: string;
  category?: string;
  thumbnail?: string;
  attributes?: [string, string][];
  profiles?: Profile[];
}

export interface FaqItem {
  question: string;
  answer: string;
}

export interface NewsItem {
  title: string;
  url: string;
  description?: string;
  age?: string;
  meta_url?: MetaUrl;
}

export interface VideoItem {
  title: string;
  url: string;
  description?: string;
  meta_url?: MetaUrl;
  thumbnail?: Thumbnail;
}

export interface DiscussionItem {
  title: string;
  url: string;
  description?: string;
  meta_url?: MetaUrl;
}

export interface ImageItem {
  title: string;
  /** Page the image was found on */
  url: string;
  source?: string;
  /** Brave CDN thumbnail */
  thumbnail?: string;
  /** Original / full image URL when available */
  image?: string;
  width?: number;
  height?: number;
}

export interface SearchApiResponse {
  query: string;
  results: WebResult[];
  infobox?: Infobox;
  faq?: FaqItem[];
  news?: NewsItem[];
  videos?: VideoItem[];
  discussions?: DiscussionItem[];
  error?: string;
}

export interface ImageSearchApiResponse {
  query: string;
  images: ImageItem[];
  error?: string;
}

/** Loose Brave response shapes (fields we read only). */
export interface BraveSearchResponse {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      profile?: { name?: string };
      meta_url?: {
        netloc?: string;
        path?: string;
      };
      cluster?: Array<{
        title?: string;
        url?: string;
        description?: string;
      }>;
      page_age?: string;
      age?: string;
    }>;
  };
  infobox?: {
    results?: Array<{
      title?: string;
      description?: string;
      long_desc?: string;
      category?: string;
      attributes?: [string, string][];
      profiles?: Array<{ name?: string; url?: string }>;
      images?: Array<{ src?: string }>;
      thumbnail?: { src?: string };
    }>;
  };
  faq?: {
    results?: Array<{ question?: string; answer?: string }>;
  };
  news?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      page_age?: string;
      meta_url?: { netloc?: string };
    }>;
  };
  videos?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      meta_url?: { netloc?: string };
      thumbnail?: { src?: string };
    }>;
  };
  discussions?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      meta_url?: { netloc?: string };
    }>;
  };
}

/** Loose Brave image search response. */
export interface BraveImageSearchResponse {
  results?: Array<{
    title?: string;
    url?: string;
    source?: string;
    thumbnail?: { src?: string; width?: number; height?: number };
    properties?: {
      url?: string;
      width?: number;
      height?: number;
    };
    meta_url?: { netloc?: string };
  }>;
}
