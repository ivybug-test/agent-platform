"use client";

import { useEffect, useState } from "react";

interface PreviewData {
  url: string;
  host: string;
  ok: boolean;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  favicon?: string;
}

// In-memory cache shared across card instances. Avoids hammering the
// preview endpoint when the same URL appears in multiple messages.
const cache = new Map<string, Promise<PreviewData>>();

async function loadPreview(url: string): Promise<PreviewData> {
  let pending = cache.get(url);
  if (!pending) {
    pending = (async () => {
      try {
        const res = await fetch(
          `/api/link-preview?url=${encodeURIComponent(url)}`
        );
        if (!res.ok) {
          return { url, host: "", ok: false };
        }
        return (await res.json()) as PreviewData;
      } catch {
        return { url, host: "", ok: false };
      }
    })();
    cache.set(url, pending);
  }
  return pending;
}

export default function LinkPreviewCard({ url }: { url: string }) {
  const [data, setData] = useState<PreviewData | null>(null);

  useEffect(() => {
    let active = true;
    loadPreview(url).then((d) => {
      if (active) setData(d);
    });
    return () => {
      active = false;
    };
  }, [url]);

  // Loading skeleton — keeps the bubble height stable as data arrives.
  if (!data) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="block mt-2 max-w-[360px] rounded-lg border border-base-300 bg-base-200/40 p-2.5 animate-pulse"
      >
        <div className="h-3 w-2/3 bg-base-300 rounded mb-2" />
        <div className="h-2 w-full bg-base-300/70 rounded mb-1" />
        <div className="h-2 w-1/2 bg-base-300/70 rounded" />
      </a>
    );
  }

  const fallbackHost = data.host || (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  })();

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="block mt-2 max-w-[360px] rounded-lg border border-base-300 bg-base-200/60 hover:bg-base-200 transition-colors overflow-hidden"
    >
      <div className="flex gap-3 p-2.5">
        {data.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={data.image}
            alt=""
            className="w-16 h-16 rounded object-cover bg-base-300 flex-shrink-0"
            referrerPolicy="no-referrer"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = "none";
            }}
          />
        ) : data.favicon ? (
          <div className="w-16 h-16 rounded bg-base-300 flex items-center justify-center flex-shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={data.favicon}
              alt=""
              className="w-8 h-8 opacity-80"
              referrerPolicy="no-referrer"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          </div>
        ) : null}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium leading-snug line-clamp-2 break-all">
            {data.title || fallbackHost}
          </div>
          {data.description && (
            <div className="text-xs opacity-70 line-clamp-2 mt-0.5 break-all">
              {data.description}
            </div>
          )}
          <div className="text-[10px] opacity-50 mt-1 truncate">
            {data.siteName || fallbackHost}
          </div>
        </div>
      </div>
    </a>
  );
}
